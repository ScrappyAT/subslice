import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { checkoutSchema } from "@/lib/validation/schemas";
import { appendPaymentEvent } from "@/lib/paymentLog";
import { initiatePayment } from "@/lib/flutterwave/payments";

// Unique per attempt (128 bits of randomness — a collision is not a
// practical concern), unguessable (a guessable tx_ref would let one
// request probe for another user's in-flight checkout), and traceable back
// to the user and plan without embedding either: traceability comes from
// looking this value up as PaymentEvent.txRef, where userId and planCode
// are already columns on that row, not from decoding the string itself.
function generateTxRef(): string {
  return `chk_${randomBytes(16).toString("hex")}`;
}

export async function POST(request: Request) {
  // getSession(), not requireSession(): this is a JSON API route, not a
  // page. requireSession() redirects on failure, which is the wrong
  // response for a fetch() caller — an unauthenticated request here gets a
  // 401 body it can actually render, not a 307 it has to special-case.
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "You must be signed in." }, { status: 401 });
  }
  const user = session.user;

  const body = await request.json().catch(() => null);
  if (body === null) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = checkoutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", fieldErrors: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  // Keyed on the user, not the IP — unlike the anonymous auth endpoints,
  // this route requires a session, so the user is the identity that
  // actually matters here.
  const { limit, windowSeconds } = RATE_LIMITS.checkout;
  const rate = await checkRateLimit(`checkout:user:${user.id}`, limit, windowSeconds);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

  // Validated against the Plan table, not a hardcoded list — a second list
  // of plan codes in source would be exactly the two-sources-of-truth bug
  // lib/plans.ts already exists to avoid on the read side.
  const plan = await prisma.plan.findUnique({ where: { code: parsed.data.planCode } });
  if (!plan || !plan.active) {
    return NextResponse.json({ error: "Unknown plan code" }, { status: 400 });
  }
  if (plan.interval === "NONE") {
    // The free plan. This endpoint exists to start a Flutterwave charge —
    // there is nothing to charge for here.
    return NextResponse.json({ error: "The free plan has nothing to charge for." }, { status: 400 });
  }

  const txRef = generateTxRef();

  // Written before Flutterwave is ever called. If the call below fails or
  // times out, there is still a row proving the attempt happened —
  // reversing this order would let a crash between the two lose that
  // record entirely, which is exactly what an append-only log exists to
  // prevent.
  const initiated = await appendPaymentEvent({
    type: "CHECKOUT_INITIATED",
    userId: user.id,
    idempotencyKey: `checkout:${txRef}`,
    txRef,
    planCode: plan.code,
    // The amount quoted right now — verification (step 7) compares against
    // this recorded value, never against Plan's price at verify time.
    amountMinor: plan.amountMinor,
    currency: plan.currency.trim(),
  });
  if (initiated.outcome === "duplicate") {
    // txRef is freshly generated with 128 bits of randomness. Reaching
    // this branch means a genuine collision or a bug in generateTxRef, not
    // a normal client-facing condition — there is no meaningful retry for
    // the caller here, only something to investigate server-side.
    console.error("Freshly generated txRef collided with an existing idempotencyKey", { txRef });
    return NextResponse.json({ error: "Could not start checkout. Please try again." }, { status: 500 });
  }

  const appBaseUrl = process.env.APP_BASE_URL;
  if (!appBaseUrl) {
    throw new Error("APP_BASE_URL is not set");
  }

  const result = await initiatePayment({
    txRef,
    amountMinor: plan.amountMinor,
    currency: plan.currency.trim(), // CHAR(3) pads short values on read
    customerEmail: user.email,
    customerName: user.name,
    // Carries nothing the server cannot verify independently: no amount,
    // no plan, no entitlement claim. Flutterwave appends its own tx_ref,
    // transaction_id and status query params on the way back; the return
    // view (step 7) re-derives everything else from a server-side verify
    // call, never from what's on this URL.
    redirectUrl: `${appBaseUrl}/checkout/return`,
  });

  if (!result.ok) {
    await appendPaymentEvent({
      type: "PAYMENT_FAILED",
      userId: user.id,
      idempotencyKey: `failed:${txRef}`,
      txRef,
      planCode: plan.code,
      reason: result.reason,
    });
    // Never the raw provider string — result.reason is one of this app's
    // own three labels, not anything Flutterwave sent.
    return NextResponse.json(
      { error: "We couldn't reach the payment provider. Please try again." },
      { status: 502 },
    );
  }

  return NextResponse.json({ checkoutUrl: result.checkoutUrl }, { status: 200 });
}
