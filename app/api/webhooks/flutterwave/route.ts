import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { appendPaymentEvent } from "@/lib/paymentLog";
import { fulfilCheckout } from "@/lib/fulfilCheckout";
import { getFlutterwaveSecretHash } from "@/lib/flutterwave/config";

// No requireSession()/getSession() here, and no middleware.ts exists in this
// project (confirmed at step 6) — route protection is entirely opt-in per
// route, so nothing blocks an unauthenticated request to this path by
// default. That is correct for a webhook: Flutterwave carries no session
// cookie, and this endpoint's authenticity comes from the header check
// below plus independently re-verifying the transaction, not from a login.

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch rather than returning
  // false, and requires this check first — comparing lengths leaks only
  // the secret's length via timing, not its content, which is the
  // standard, accepted trade-off for this primitive.
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export async function POST(request: Request) {
  // AGENTS.md: this is a shared-secret equality check on the verif-hash
  // header, not a signature — it carries no tamper-evidence over the
  // request body, which is exactly why nothing below ever trusts the body.
  const providedHash = request.headers.get("verif-hash");
  const expectedHash = getFlutterwaveSecretHash();
  if (!providedHash || !constantTimeEquals(providedHash, expectedHash)) {
    // Wrong or missing header: write nothing. An unauthenticated request
    // must not be able to put rows in the log.
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();

  try {
    const body: unknown = await request.json().catch(() => null);
    const data =
      body !== null && typeof body === "object" ? (body as { data?: unknown }).data : null;
    if (data === null || typeof data !== "object") {
      // Authenticated but unparseable. Retrying delivers the same body, so
      // this is not a failure on this server's side — 200, logged, nothing
      // written.
      console.log("Webhook body had no usable data object");
      return NextResponse.json({ ok: true }, { status: 200 });
    }
    const record = data as Record<string, unknown>;

    // The only thing ever taken from the webhook body: an id used purely
    // as a pointer to independently verify. Amount, status and currency
    // are never read from here — only from the authenticated verify
    // response inside fulfilCheckout.
    const rawId = record.id;
    const transactionId =
      typeof rawId === "number" || typeof rawId === "string" ? String(rawId) : null;
    if (transactionId === null) {
      console.log("Webhook body had no transaction id");
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    // tx_ref is also read from the body here, but only as a lookup key to
    // find which local CHECKOUT_INITIATED this claims to be — not as a
    // trusted fact. If it's wrong or forged, fulfilCheckout's own check
    // (the verify response's tx_ref must match) catches the mismatch
    // independently; nothing below is decided by this value.
    const txRef = typeof record.tx_ref === "string" ? record.tx_ref : null;
    if (txRef === null) {
      console.log("Webhook body had no tx_ref", { transactionId });
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    // Resolve the id to a known checkout attempt. AGENTS.md:
    // PaymentEvent.userId is non-null with a foreign key, so a webhook
    // whose reference does not resolve to a known user cannot be recorded
    // — an unresolvable reference returns 200 with no row written, logged
    // to stdout only, rather than a write with nothing to attach it to.
    const checkoutEvent = await prisma.paymentEvent.findFirst({
      where: { txRef, type: "CHECKOUT_INITIATED" },
    });
    if (!checkoutEvent) {
      console.log("Webhook did not resolve to a known checkout attempt", { transactionId, txRef });
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    const received = await appendPaymentEvent({
      type: "WEBHOOK_RECEIVED",
      userId: checkoutEvent.userId,
      idempotencyKey: `webhook:${transactionId}`,
      providerReference: transactionId,
      txRef,
    });

    if (received.outcome === "duplicate") {
      // A repeat delivery of a webhook already recorded once. Recorded
      // again under its own key — including a third delivery, which gets
      // a key distinct from the second's — but never acted on twice.
      await appendPaymentEvent({
        type: "WEBHOOK_DUPLICATE_IGNORED",
        userId: checkoutEvent.userId,
        idempotencyKey: `webhook-dup:${transactionId}:${now.toISOString()}`,
        providerReference: transactionId,
        txRef,
      });
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    // First delivery. The webhook and the return view are two triggers for
    // one code path — reusing it here, rather than re-implementing the
    // five checks, is what makes it structurally impossible to grant
    // entitlement twice for the same transaction from two different
    // triggers.
    const result = await fulfilCheckout({
      userId: checkoutEvent.userId,
      txRef,
      transactionId,
      now,
    });

    // 200 for every outcome here, including "rejected": a failed
    // verification (tampered amount, wrong status, whatever it was) is a
    // real answer, not a failure on this server's side, and retrying the
    // same delivery would only produce the same answer again. A non-2xx
    // is reserved for the catch block below — an exception genuinely on
    // this server's side, which retrying later might resolve.
    console.log("Webhook processed", { transactionId, outcome: result.outcome });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error("Webhook handler threw", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
