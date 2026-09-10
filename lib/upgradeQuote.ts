import { prisma } from "./prisma";
import { deriveEntitlement } from "./entitlement";
import { prorate } from "./proration";
import { getPlan } from "./plans";
import { appendPaymentEvent } from "./paymentLog";
import { generateTxRef } from "./txRef";

export type QuoteUpgradeResult =
  | {
      outcome: "quoted";
      txRef: string;
      daysInPeriod: number;
      daysRemaining: number;
      creditMinor: number;
      chargeMinor: number;
      currency: string;
    }
  /** "Upgrading when already on yearly is rejected." */
  | { outcome: "already_yearly" }
  /** "Upgrading from free goes through the normal subscribe path, not
   * proration — there is no unused value to credit." */
  | { outcome: "no_paid_plan" }
  | { outcome: "inconsistent" };

/**
 * The quote step (step 9): derives the signed-in user's current entitlement
 * from the log, prorates against yearly's current price, and writes
 * PRORATION_QUOTED so what the user was shown is reconstructable from the
 * log alone — not only visible in a screenshot. Initiates no payment; that
 * only happens on explicit confirmation (lib/upgradeConfirm.ts).
 *
 * `now` is a parameter for the same reason it is everywhere else in this
 * codebase: a test needs to control it, and this function must not decide
 * anything by reading the clock itself.
 */
export async function quoteUpgrade(params: { userId: string; now: Date }): Promise<QuoteUpgradeResult> {
  const { userId, now } = params;

  const events = await prisma.paymentEvent.findMany({
    where: { userId },
    orderBy: { seq: "asc" },
  });
  const entitlement = deriveEntitlement(events, now);

  if (entitlement.status === "inconsistent") {
    return { outcome: "inconsistent" };
  }
  if (entitlement.planCode === "yearly") {
    return { outcome: "already_yearly" };
  }
  if (entitlement.planCode === "free" || entitlement.periodStart === null || entitlement.periodEnd === null) {
    // Free, or (defensively) no period on record at all — either way
    // there is no unused value on a plan that was never paid for.
    return { outcome: "no_paid_plan" };
  }

  // What was actually paid for the current period — the last
  // ENTITLEMENT_GRANTED, which is exactly what established
  // entitlement.periodStart/periodEnd (deriveEntitlement takes the latest
  // grant's own fields at face value). Not Plan's price: "events carry
  // their own facts" (AGENTS.md), and a plan's price could differ from
  // what was actually charged historically.
  const currentGrant = events.filter((e) => e.type === "ENTITLEMENT_GRANTED").at(-1);
  if (!currentGrant || currentGrant.amountMinor === null) {
    return { outcome: "inconsistent" };
  }

  // Yearly's *current* price — reading Plan here is fine, unlike during
  // verification: this is what upgrading to yearly costs today, not a
  // historical fact being re-checked against a past record.
  const yearlyPlan = await getPlan("yearly");

  const quote = prorate({
    paidAmountMinor: currentGrant.amountMinor,
    periodStart: entitlement.periodStart,
    periodEnd: entitlement.periodEnd,
    now,
    newPlanAmountMinor: yearlyPlan.amountMinor,
  });

  const txRef = generateTxRef();
  const quoted = await appendPaymentEvent({
    type: "PRORATION_QUOTED",
    userId,
    idempotencyKey: `quote:${txRef}`,
    txRef,
    planCode: "yearly",
    amountMinor: quote.chargeMinor,
    currency: yearlyPlan.currency,
    creditAppliedMinor: quote.creditMinor,
  });
  if (quoted.outcome === "duplicate") {
    // txRef is freshly generated with 128 bits of randomness — reaching
    // this means a genuine collision, not a normal condition.
    console.error("Freshly generated txRef collided with an existing idempotencyKey", { txRef });
    return { outcome: "inconsistent" };
  }

  return {
    outcome: "quoted",
    txRef,
    daysInPeriod: quote.daysInPeriod,
    daysRemaining: quote.daysRemaining,
    creditMinor: quote.creditMinor,
    chargeMinor: quote.chargeMinor,
    currency: yearlyPlan.currency,
  };
}
