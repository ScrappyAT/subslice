import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { fromProviderAmount } from "./money";
import { addCalendarMonths, monthlyPeriodEnd, yearlyPeriodEnd } from "./period";
import { appendPaymentEvent } from "./paymentLog";
import { verifyTransaction } from "./flutterwave/verify";
import { deriveEntitlement } from "./entitlement";
import { refreshSubscriptionProjection } from "./subscriptionProjection";

/**
 * Extends a period from its true origin rather than from wherever it
 * currently ends. This is the write-path half of the billing-anchor
 * decision flagged (but deliberately not implemented) in step 4's
 * entitlement derivation: `currentPeriodEnd` can itself be a clamped date
 * (31 Jan -> 28 Feb), and adding one more cycle to *that* compounds the
 * clamp, permanently losing the original day-of-month. Counting whole
 * cycles from the anchor by month-index difference, then re-clamping
 * fresh against the *next* target month, is what lets 31 Jan -> 28 Feb ->
 * (extended) 31 Mar rather than 28 Mar.
 *
 * The month-index difference (year*12 + month) is used instead of the day,
 * deliberately — clamping only ever changes the day of a target month,
 * never which month addCalendarMonths lands on, so this division is exact
 * for any period this codebase has produced.
 */
function extendFromAnchor(anchor: Date, cycleMonths: number, currentPeriodEnd: Date): Date {
  const anchorMonthIndex = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth();
  const currentEndMonthIndex =
    currentPeriodEnd.getUTCFullYear() * 12 + currentPeriodEnd.getUTCMonth();
  const cyclesSoFar = Math.round((currentEndMonthIndex - anchorMonthIndex) / cycleMonths);
  return addCalendarMonths(anchor, (cyclesSoFar + 1) * cycleMonths);
}

export type FulfilmentResult =
  | {
      outcome: "granted";
      planCode: string;
      periodStart: Date;
      periodEnd: Date;
    }
  /** Already fulfilled by an earlier call with this same transactionId —
   * the unique constraint on idempotencyKey caught it, nothing new
   * happened. Still "you have access", just not newly granted here. */
  | { outcome: "duplicate" }
  /** Flutterwave has not reached a final answer yet. Nothing is written —
   * there is nothing true to record yet, and a later visit (or the
   * webhook, in step 8) gets to resolve it correctly instead of this call
   * locking in a premature failure. */
  | { outcome: "pending" }
  | { outcome: "rejected"; reason: string };

/**
 * Server-side verification and fulfilment for the checkout return view.
 * This is the code path defence question 1 is about: the *only* place
 * entitlement is granted from a checkout is the ENTITLEMENT_GRANTED write
 * below, and it is reachable only after every check in this function has
 * passed. Reaching the return view directly, with any value that doesn't
 * satisfy all five checks, falls through to "rejected" and grants nothing.
 *
 * `now` is a parameter, not `new Date()` inside — it is both "the moment of
 * this grant" and the reference point for deriving whether an earlier
 * period is still active, and a test needs to control what that date is
 * instead of racing the real clock.
 */
export async function fulfilCheckout(params: {
  userId: string;
  txRef: string;
  transactionId: string;
  now: Date;
}): Promise<FulfilmentResult> {
  const { userId, txRef, transactionId, now } = params;

  // The event this whole call is trying to confirm actually happened. If
  // there is no such attempt on record at all, there is nothing to verify
  // against and nothing to blame it on — no PAYMENT_FAILED write, since
  // that would misattribute a failure to a checkout that was never ours.
  const checkoutEvent = await prisma.paymentEvent.findFirst({
    where: { txRef, type: "CHECKOUT_INITIATED" },
  });
  if (!checkoutEvent || checkoutEvent.planCode === null) {
    return { outcome: "rejected", reason: "No checkout attempt found for this tx_ref" };
  }

  // Check 5 (AGENTS.md order): the tx_ref belongs to the signed-in user.
  // Checked first, before any network call, because it's the one condition
  // this function can rule out from data it already has in hand — prevents
  // a signed-in user from claiming a *different* user's payment just by
  // knowing or guessing their tx_ref and transaction_id.
  if (checkoutEvent.userId !== userId) {
    await appendPaymentEvent({
      type: "PAYMENT_FAILED",
      userId: checkoutEvent.userId,
      idempotencyKey: `failed:${txRef}`,
      txRef,
      planCode: checkoutEvent.planCode,
      reason: "tx_ref does not belong to the signed-in user",
    });
    return { outcome: "rejected", reason: "tx_ref does not belong to the signed-in user" };
  }

  // Plan codes are a fixed, known set (lib/plans.ts's PlanCode), not a
  // database lookup — reading Plan here would reopen exactly the
  // current-price-vs-quoted-price gap this event now closes for amount and
  // currency below. The free plan is rejected at checkout (step 6) and has
  // no billing cycle to compute a period from; this is the same defensive
  // guard as before, expressed without the Plan read.
  if (checkoutEvent.planCode !== "monthly" && checkoutEvent.planCode !== "yearly") {
    await appendPaymentEvent({
      type: "PAYMENT_FAILED",
      userId: checkoutEvent.userId,
      idempotencyKey: `failed:${txRef}`,
      txRef,
      planCode: checkoutEvent.planCode,
      reason: "Checkout event's plan is not chargeable",
    });
    return { outcome: "rejected", reason: "Plan is not chargeable" };
  }

  // The amount and currency quoted at checkout time (recorded on
  // CHECKOUT_INITIATED, not read from Plan's current price — see
  // lib/paymentLog.ts). Null here means a row written before this was
  // required, which this function cannot verify against.
  if (checkoutEvent.amountMinor === null || checkoutEvent.currency === null) {
    await appendPaymentEvent({
      type: "PAYMENT_FAILED",
      userId: checkoutEvent.userId,
      idempotencyKey: `failed:${txRef}`,
      txRef,
      planCode: checkoutEvent.planCode,
      reason: "Checkout event is missing its recorded amount",
    });
    return { outcome: "rejected", reason: "No recorded amount to verify against" };
  }
  const expectedAmountMinor = checkoutEvent.amountMinor;
  const expectedCurrency = checkoutEvent.currency.trim();

  const verified = await verifyTransaction(transactionId);
  if (!verified.ok) {
    await appendPaymentEvent({
      type: "PAYMENT_FAILED",
      userId: checkoutEvent.userId,
      idempotencyKey: `failed:${txRef}`,
      txRef,
      planCode: checkoutEvent.planCode,
      reason: `Verify call did not succeed: ${verified.reason}`,
    });
    return { outcome: "rejected", reason: "Could not verify this transaction" };
  }

  // Flutterwave has not reached a final state yet. Distinct from a failed
  // check below: nothing here has been shown to be wrong, there simply
  // isn't an answer yet, so nothing is written in either direction.
  if (verified.data.status === "pending") {
    return { outcome: "pending" };
  }

  // Check 1: the verify response itself — the one authenticated source of
  // truth — says the transaction succeeded. This is the trap the brief
  // names: a URL can claim ?status=successful, but that query parameter is
  // never read for this decision (see the return page) — only this
  // server-to-server response is.
  if (verified.data.status !== "successful") {
    await appendPaymentEvent({
      type: "PAYMENT_FAILED",
      userId: checkoutEvent.userId,
      idempotencyKey: `failed:${txRef}`,
      txRef,
      planCode: checkoutEvent.planCode,
      reason: `Verify response status was "${verified.data.status}", not "successful"`,
    });
    return { outcome: "rejected", reason: "Payment was not successful" };
  }

  // Check 2: the tx_ref the provider has on file for this transaction_id
  // matches the one in the URL — prevents a transaction_id that verifies
  // fine but belongs to an entirely different tx_ref (and therefore a
  // different checkout attempt) from being accepted for this one.
  if (verified.data.txRef !== txRef) {
    await appendPaymentEvent({
      type: "PAYMENT_FAILED",
      userId: checkoutEvent.userId,
      idempotencyKey: `failed:${txRef}`,
      txRef,
      planCode: checkoutEvent.planCode,
      reason: "Verify response tx_ref did not match the tx_ref in the URL",
    });
    return { outcome: "rejected", reason: "Transaction reference mismatch" };
  }

  // Check 3: the amount actually paid, converted to minor units at the one
  // conversion boundary, equals the amount recorded on CHECKOUT_INITIATED
  // — what was actually quoted at checkout, not Plan's price as of this
  // verification (see the comment above, and lib/paymentLog.ts). Prevents
  // a tampered or short payment from being accepted as full payment.
  let verifiedAmountMinor: number;
  try {
    verifiedAmountMinor = fromProviderAmount(verified.data.amount ?? "", expectedCurrency);
  } catch {
    await appendPaymentEvent({
      type: "PAYMENT_FAILED",
      userId: checkoutEvent.userId,
      idempotencyKey: `failed:${txRef}`,
      txRef,
      planCode: checkoutEvent.planCode,
      reason: "Verify response amount could not be parsed",
    });
    return { outcome: "rejected", reason: "Could not read the verified amount" };
  }
  if (verifiedAmountMinor !== expectedAmountMinor) {
    await appendPaymentEvent({
      type: "PAYMENT_FAILED",
      userId: checkoutEvent.userId,
      idempotencyKey: `failed:${txRef}`,
      txRef,
      planCode: checkoutEvent.planCode,
      reason: `Verified amount ${verifiedAmountMinor} did not match the recorded ${expectedAmountMinor}`,
    });
    return { outcome: "rejected", reason: "Amount did not match" };
  }

  // Check 4: the currency actually paid matches the currency recorded on
  // CHECKOUT_INITIATED. Prevents an amount that happens to match
  // numerically but was paid in a different currency from being treated
  // as equivalent.
  if (verified.data.currency !== expectedCurrency) {
    await appendPaymentEvent({
      type: "PAYMENT_FAILED",
      userId: checkoutEvent.userId,
      idempotencyKey: `failed:${txRef}`,
      txRef,
      planCode: checkoutEvent.planCode,
      reason: `Verified currency "${verified.data.currency}" did not match "${expectedCurrency}"`,
    });
    return { outcome: "rejected", reason: "Currency did not match" };
  }

  // All five checks passed. PAYMENT_VERIFIED is keyed on the provider
  // transaction id (AGENTS.md) — a replay of this same transactionId lands
  // on the same idempotencyKey and is caught here as a duplicate, not
  // re-verified into a second grant.
  const verifiedEvent = await appendPaymentEvent({
    type: "PAYMENT_VERIFIED",
    userId: checkoutEvent.userId,
    idempotencyKey: `verified:${transactionId}`,
    providerReference: transactionId,
    txRef,
    planCode: checkoutEvent.planCode,
    amountMinor: verifiedAmountMinor,
    currency: expectedCurrency,
    // The complete raw response body — AGENTS.md flags the exact shape as
    // unconfirmed against a live sandbox; this is where that gets settled.
    // Safe to treat as JSON: verify.ts only ever puts response.json()'s
    // own output here.
    payload: verified.raw as Prisma.InputJsonValue,
  });
  if (verifiedEvent.outcome === "duplicate") {
    return { outcome: "duplicate" };
  }

  // Before granting anything, derive what the user is currently entitled
  // to from the log itself — never assumed to be "nothing" just because
  // this is a checkout. Paying twice for an already-active period must
  // extend it, not silently overlap it with a second period starting from
  // "now" (AGENTS.md's Lifecycle section; the brief's excellent band names
  // this case explicitly).
  const priorEvents = await prisma.paymentEvent.findMany({
    where: { userId: checkoutEvent.userId },
    orderBy: { seq: "asc" },
  });
  const currentEntitlement = deriveEntitlement(priorEvents, now);
  // The subscription's original anchor day — literally the first
  // ENTITLEMENT_GRANTED ever recorded, per AGENTS.md, not the first for
  // this plan or this streak.
  const firstGrantPeriodStart =
    priorEvents.find((e) => e.type === "ENTITLEMENT_GRANTED")?.periodStart ?? null;

  const cycleMonths = checkoutEvent.planCode === "yearly" ? 12 : 1;

  // A matching PRORATION_QUOTED for this same txRef, if any — an upgrade
  // was quoted before this charge was confirmed (step 9). Absent for a
  // plain subscribe or a repeat payment on the same plan, neither of which
  // was ever quoted; creditAppliedMinor on the grant below is then left
  // unset, matching a fresh subscribe having no previous plan to credit
  // from.
  const quoteEvent = priorEvents.find((e) => e.type === "PRORATION_QUOTED" && e.txRef === txRef);

  let periodStart: Date;
  let periodEnd: Date;

  if (
    currentEntitlement.status === "ok" &&
    currentEntitlement.accessGranted &&
    currentEntitlement.planCode === checkoutEvent.planCode &&
    currentEntitlement.periodEnd !== null &&
    firstGrantPeriodStart !== null
  ) {
    // Same plan, still within its current period: extend it. periodStart
    // is where the existing period ends — not "now" — so the two periods
    // are continuous rather than overlapping, and the second payment's
    // value is never silently absorbed.
    periodStart = currentEntitlement.periodEnd;
    periodEnd = extendFromAnchor(firstGrantPeriodStart, cycleMonths, currentEntitlement.periodEnd);
  } else {
    // No unexpired period on this same plan to extend — the first grant
    // ever, a previous period that already ran out, or an upgrade to a
    // *different* plan (currentEntitlement.planCode === checkoutEvent.
    // planCode is false for monthly -> yearly, so the pay-twice extension
    // branch above cannot fire here — confirmed by this step's tests).
    // Either way this grant starts its own fresh period from the moment of
    // payment, and this payment becomes the anchor if it's the first one.
    //
    // For an upgrade specifically, this is deliberate, not merely "no
    // branch matched": the user paid the prorated amount precisely to get
    // yearly access starting now, not to wait out the rest of the old
    // monthly period first. The old monthly period is superseded — its
    // remaining value was already converted into the credit that reduced
    // this charge (see quoteEvent below) — whereas the pay-twice case
    // extends because both payments are for the *same* plan and neither
    // has been given anything the other could double-count.
    periodStart = now;
    periodEnd = checkoutEvent.planCode === "yearly" ? yearlyPeriodEnd(now) : monthlyPeriodEnd(now);
  }

  // The exact line where entitlement is granted.
  const grantedEvent = await appendPaymentEvent({
    type: "ENTITLEMENT_GRANTED",
    userId: checkoutEvent.userId,
    idempotencyKey: `granted:${transactionId}`,
    providerReference: transactionId,
    txRef,
    planCode: checkoutEvent.planCode,
    periodStart,
    periodEnd,
    amountMinor: verifiedAmountMinor,
    currency: expectedCurrency,
    // The credit actually applied, carried over from the quote — absent
    // (undefined) for a plain subscribe or a pay-twice extension, neither
    // of which was ever quoted.
    creditAppliedMinor: quoteEvent?.creditAppliedMinor ?? undefined,
  });
  if (grantedEvent.outcome === "duplicate") {
    // PAYMENT_VERIFIED above was a fresh insert but this wasn't — not
    // expected in normal operation (the two are written back to back by
    // this same call), so this is logged rather than silently treated as
    // ordinary.
    console.error("ENTITLEMENT_GRANTED was a duplicate immediately after a fresh PAYMENT_VERIFIED", {
      transactionId,
    });
    return { outcome: "duplicate" };
  }

  // Subscription is a cache, never a source of truth (AGENTS.md) — this
  // keeps it in step with what was just granted, for cheap reads and the
  // brief's before/after screenshot. Every entitlement *decision* still
  // goes through deriveEntitlement, never this row.
  await refreshSubscriptionProjection(checkoutEvent.userId, now);

  return {
    outcome: "granted",
    planCode: checkoutEvent.planCode,
    periodStart,
    periodEnd,
  };
}
