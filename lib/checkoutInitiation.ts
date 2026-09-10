import { appendPaymentEvent } from "./paymentLog";
import { initiatePayment } from "./flutterwave/payments";

export interface InitiateChargeParams {
  userId: string;
  /** Generated fresh by the caller for a plain subscribe, or reused from an
   * earlier PRORATION_QUOTED for an upgrade — this function never generates
   * or invents one, it only writes what it's given. */
  txRef: string;
  planCode: string;
  amountMinor: number;
  currency: string;
  customerEmail: string;
  customerName: string;
  redirectUrl: string;
}

export type InitiateChargeResult =
  | { outcome: "initiated"; checkoutUrl: string }
  | { outcome: "duplicate_tx_ref" }
  | { outcome: "provider_error" };

/**
 * Writes CHECKOUT_INITIATED, then calls Flutterwave to start the charge.
 * The one place both the plain-subscribe route and the upgrade-confirm
 * route go through — "reuse the existing checkout initiation" (step 9),
 * not a second Flutterwave integration. Which amount gets charged (a
 * plan's flat price, or a prorated upgrade charge) is entirely the
 * caller's decision; this function only ever charges what it's told.
 */
export async function initiateCheckoutCharge(params: InitiateChargeParams): Promise<InitiateChargeResult> {
  // Written before Flutterwave is ever called. If the call below fails or
  // times out, there is still a row proving the attempt happened —
  // reversing this order would let a crash between the two lose that
  // record entirely, which is exactly what an append-only log exists to
  // prevent.
  const initiated = await appendPaymentEvent({
    type: "CHECKOUT_INITIATED",
    userId: params.userId,
    idempotencyKey: `checkout:${params.txRef}`,
    txRef: params.txRef,
    planCode: params.planCode,
    amountMinor: params.amountMinor,
    currency: params.currency,
  });
  if (initiated.outcome === "duplicate") {
    return { outcome: "duplicate_tx_ref" };
  }

  const result = await initiatePayment({
    txRef: params.txRef,
    amountMinor: params.amountMinor,
    currency: params.currency,
    customerEmail: params.customerEmail,
    customerName: params.customerName,
    redirectUrl: params.redirectUrl,
  });

  if (!result.ok) {
    await appendPaymentEvent({
      type: "PAYMENT_FAILED",
      userId: params.userId,
      idempotencyKey: `failed:${params.txRef}`,
      txRef: params.txRef,
      planCode: params.planCode,
      reason: result.reason,
    });
    return { outcome: "provider_error" };
  }

  return { outcome: "initiated", checkoutUrl: result.checkoutUrl };
}
