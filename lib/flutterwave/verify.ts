import { FLW_BASE_URL, getFlutterwaveSecretKey } from "./config";

/**
 * What this app reads off a verify response. AGENTS.md flags the complete
 * field list as unconfirmed against a live sandbox — so this only reads the
 * handful of fields the five checks in lib/fulfilCheckout.ts actually need,
 * typed loosely (freeform strings, not a status enum), and the fulfilment
 * layer logs the *entire* raw body into PaymentEvent.payload separately.
 * That raw body, not this narrowed shape, is the actual record of what
 * Flutterwave returned.
 */
export interface VerifiedTransactionData {
  /** Flutterwave's transaction status — expected to be "successful",
   * "failed" or "pending", but read as plain text rather than an enum
   * since the exact set of values is unconfirmed. Compared against exactly
   * one value ("successful") that counts as a pass. */
  status: string;
  txRef: string | undefined;
  /** The raw major-unit amount exactly as returned, coerced to a string
   * (never trusted as a number) so fromProviderAmount — which refuses a
   * float on principle — is the only thing that ever parses it. */
  amount: string | undefined;
  currency: string | undefined;
}

export type VerifyTransactionResult =
  | { ok: true; data: VerifiedTransactionData; raw: unknown }
  | { ok: false; reason: "provider_error" | "network_error" | "timeout"; raw?: unknown };

// Same rationale as lib/flutterwave/payments.ts's PROVIDER_TIMEOUT_MS: long
// enough for a genuine response, short enough that a hung request doesn't
// leave the return view stalled indefinitely.
const PROVIDER_TIMEOUT_MS = 10_000;

/**
 * GET /v3/transactions/{id}/verify on the pinned v3 base URL. The only call
 * to this endpoint in the codebase, and the seam the return view's tests
 * stub instead of hitting Flutterwave.
 */
export async function verifyTransaction(transactionId: string): Promise<VerifyTransactionResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${FLW_BASE_URL}/transactions/${encodeURIComponent(transactionId)}/verify`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${getFlutterwaveSecretKey()}` },
        signal: controller.signal,
      },
    );

    const body: unknown = await response.json().catch(() => null);

    if (!response.ok || body === null || typeof body !== "object") {
      console.error("Flutterwave verify failed", { status: response.status, body });
      return { ok: false, reason: "provider_error", raw: body };
    }

    const data = (body as { data?: unknown }).data;
    if (data === null || typeof data !== "object") {
      console.error("Flutterwave verify returned no data", { body });
      return { ok: false, reason: "provider_error", raw: body };
    }

    const record = data as Record<string, unknown>;
    const rawAmount = record.amount;

    return {
      ok: true,
      data: {
        status: typeof record.status === "string" ? record.status : "",
        txRef: typeof record.tx_ref === "string" ? record.tx_ref : undefined,
        amount:
          typeof rawAmount === "number" || typeof rawAmount === "string"
            ? String(rawAmount)
            : undefined,
        currency: typeof record.currency === "string" ? record.currency : undefined,
      },
      raw: body,
    };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    console.error("Flutterwave verify threw", err);
    return { ok: false, reason: timedOut ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timeout);
  }
}
