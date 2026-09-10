import { prisma } from "./prisma";
import { deriveEntitlement } from "./entitlement";
import { prorate } from "./proration";
import { getPlan } from "./plans";
import { initiateCheckoutCharge } from "./checkoutInitiation";

export type ConfirmUpgradeResult =
  | { outcome: "initiated"; checkoutUrl: string }
  | { outcome: "quote_not_found" }
  | { outcome: "already_confirmed" }
  /** The recomputed charge no longer matches what was quoted — see the
   * comment at the comparison below for why this rejects rather than
   * silently charging the new number. */
  | { outcome: "stale"; reason: string }
  /** Covers both "already on yearly" and "no active plan to upgrade from"
   * — by confirmation time, planCode is simply no longer "monthly". */
  | { outcome: "not_eligible"; reason: string }
  | { outcome: "provider_error" };

/**
 * Confirmation (step 9): the amount charged is recomputed here, from the
 * current entitlement and the current time — never trusted from the
 * client (this function doesn't even accept an amount parameter), and
 * never a blind reuse of what was quoted either, since real time has
 * passed since the quote was shown. Only initiates the charge — through
 * lib/checkoutInitiation.ts, the same path a plain subscribe uses — if the
 * recomputed amount still matches the quote.
 *
 * This does not check entitlement.cancelAtPeriodEnd, deliberately: this
 * function only *initiates* a Flutterwave charge (see
 * lib/checkoutInitiation.ts) — it writes CHECKOUT_INITIATED, never
 * ENTITLEMENT_GRANTED. The actual grant, and the reactivation question Q1
 * of the step 11 follow-up asked about, happens later in
 * lib/fulfilCheckout.ts, once payment is verified — see the "Reactivation"
 * note in lib/cancellation.ts and lib/upgradeQuote.ts's matching note.
 * Nothing here needs to guard against cancellation for that reason: an
 * upgrade that never completes payment changes nothing, same as any other
 * checkout attempt.
 */
export async function confirmUpgrade(params: {
  userId: string;
  txRef: string;
  now: Date;
  customerEmail: string;
  customerName: string;
  redirectUrl: string;
}): Promise<ConfirmUpgradeResult> {
  const { userId, txRef, now } = params;

  const quoteEvent = await prisma.paymentEvent.findFirst({
    where: { txRef, type: "PRORATION_QUOTED" },
  });
  if (
    !quoteEvent ||
    quoteEvent.userId !== userId ||
    quoteEvent.planCode !== "yearly" ||
    quoteEvent.amountMinor === null ||
    quoteEvent.currency === null
  ) {
    return { outcome: "quote_not_found" };
  }

  // A CHECKOUT_INITIATED already exists for this exact txRef: this quote
  // has already been confirmed once. Re-initiating would attempt a second
  // Flutterwave charge under the same tx_ref, which is not something to
  // retry into — refuse rather than double-charge or double-attempt.
  const alreadyInitiated = await prisma.paymentEvent.findFirst({
    where: { txRef, type: "CHECKOUT_INITIATED" },
  });
  if (alreadyInitiated) {
    return { outcome: "already_confirmed" };
  }

  const events = await prisma.paymentEvent.findMany({
    where: { userId },
    orderBy: { seq: "asc" },
  });
  const entitlement = deriveEntitlement(events, now);
  if (
    entitlement.status !== "ok" ||
    entitlement.planCode !== "monthly" ||
    entitlement.periodStart === null ||
    entitlement.periodEnd === null
  ) {
    return { outcome: "not_eligible", reason: "No active monthly period to upgrade from" };
  }

  const currentGrant = events.filter((e) => e.type === "ENTITLEMENT_GRANTED").at(-1);
  if (!currentGrant || currentGrant.amountMinor === null) {
    return { outcome: "not_eligible", reason: "Could not determine what was paid for the current period" };
  }

  const yearlyPlan = await getPlan("yearly");
  const recomputed = prorate({
    paidAmountMinor: currentGrant.amountMinor,
    periodStart: entitlement.periodStart,
    periodEnd: entitlement.periodEnd,
    now,
    newPlanAmountMinor: yearlyPlan.amountMinor,
  });

  if (recomputed.chargeMinor !== quoteEvent.amountMinor) {
    // Time has passed since the quote and a day boundary was crossed, so
    // daysRemaining — and therefore the charge — is no longer what was
    // shown and agreed to. Rejected rather than silently charging a
    // different number than the one the user actually saw: the client
    // must request a fresh quote (lib/upgradeQuote.ts) instead.
    return {
      outcome: "stale",
      reason: `Recomputed charge ${recomputed.chargeMinor} no longer matches the quoted ${quoteEvent.amountMinor}`,
    };
  }

  const result = await initiateCheckoutCharge({
    userId,
    txRef,
    planCode: "yearly",
    amountMinor: recomputed.chargeMinor,
    currency: yearlyPlan.currency,
    customerEmail: params.customerEmail,
    customerName: params.customerName,
    redirectUrl: params.redirectUrl,
  });

  if (result.outcome === "duplicate_tx_ref") {
    // Lost a race with a concurrent confirm of the same quote.
    return { outcome: "already_confirmed" };
  }
  if (result.outcome === "provider_error") {
    return { outcome: "provider_error" };
  }
  return { outcome: "initiated", checkoutUrl: result.checkoutUrl };
}
