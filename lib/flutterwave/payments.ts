import { toProviderAmount } from "@/lib/money";
import { FLW_BASE_URL, getFlutterwaveSecretKey } from "./config";

export interface InitiatePaymentInput {
  txRef: string;
  amountMinor: number;
  currency: string;
  customerEmail: string;
  customerName: string;
  redirectUrl: string;
}

export type InitiatePaymentResult =
  | { ok: true; checkoutUrl: string }
  | { ok: false; reason: "provider_error" | "network_error" | "timeout" };

// Long enough that a slow but genuine response isn't mistaken for a hung
// one; short enough that a paying user isn't left staring at a spinner for
// a provider that isn't going to answer. There is no retry here — the
// caller writes PAYMENT_FAILED and the user tries again, which is also
// what happens on a real provider error, so one timeout value covering
// both keeps this simple.
const PROVIDER_TIMEOUT_MS = 10_000;

/**
 * POST /v3/payments — the v3 Standard hosted-checkout endpoint. Card data
 * never reaches this function or this server; it only ever gets back a URL
 * for the browser to be sent to.
 *
 * The only place in this codebase that talks to Flutterwave for initiation,
 * which is what makes it the seam the checkout route's tests stub instead
 * of hitting the real API.
 */
export async function initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  try {
    const response = await fetch(`${FLW_BASE_URL}/payments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getFlutterwaveSecretKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tx_ref: input.txRef,
        // The one function at the provider boundary (AGENTS.md) — v3 wants
        // major units, the amount this app holds is always minor units.
        amount: toProviderAmount(input.amountMinor, input.currency),
        currency: input.currency,
        redirect_url: input.redirectUrl,
        customer: { email: input.customerEmail, name: input.customerName },
      }),
      signal: controller.signal,
    });

    const body: unknown = await response.json().catch(() => null);
    const link =
      body !== null && typeof body === "object" && "data" in body
        ? (body as { data?: { link?: unknown } }).data?.link
        : undefined;

    if (!response.ok || typeof link !== "string" || link === "") {
      // Logged for our own debugging only — the caller never sees this
      // body, and it never contains the secret key (only the response
      // Flutterwave sent back).
      console.error("Flutterwave payment initiation failed", {
        status: response.status,
        body,
      });
      return { ok: false, reason: "provider_error" };
    }

    return { ok: true, checkoutUrl: link };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    console.error("Flutterwave payment initiation threw", err);
    return { ok: false, reason: timedOut ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timeout);
  }
}
