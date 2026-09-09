import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { fromProviderAmount } from "./money";
import { monthlyPeriodEnd, yearlyPeriodEnd } from "./period";
import { appendPaymentEvent } from "./paymentLog";
import { verifyTransaction } from "./flutterwave/verify";

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
 * `now` is a parameter, not `new Date()` inside — this is the first grant
 * for a checkout, so its period anchor is the grant date, and a test needs
 * to control what that date is instead of racing the real clock.
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

  // This is the first grant for this checkout, so the anchor is the grant
  // date itself — periodStart is `now`, not derived from anything earlier.
  // The billing cycle length comes from the plan *code*, the same fixed
  // knowledge checked above — not from a second Plan read.
  const periodStart = now;
  const periodEnd = checkoutEvent.planCode === "yearly" ? yearlyPeriodEnd(now) : monthlyPeriodEnd(now);

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

  return {
    outcome: "granted",
    planCode: checkoutEvent.planCode,
    periodStart,
    periodEnd,
  };
}
