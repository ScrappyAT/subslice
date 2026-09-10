import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { checkoutSchema } from "@/lib/validation/schemas";
import { generateTxRef } from "@/lib/txRef";
import { initiateCheckoutCharge } from "@/lib/checkoutInitiation";
import { methodNotAllowed } from "@/lib/methodNotAllowed";

/** See lib/methodNotAllowed.ts — a browser GET gets a real 405, not a
 * blank one. */
export async function GET() {
  return methodNotAllowed(["POST"]);
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

  const appBaseUrl = process.env.APP_BASE_URL;
  if (!appBaseUrl) {
    throw new Error("APP_BASE_URL is not set");
  }

  const result = await initiateCheckoutCharge({
    userId: user.id,
    txRef: generateTxRef(),
    planCode: plan.code,
    // The amount quoted right now — verification (step 7) compares against
    // this recorded value, never against Plan's price at verify time.
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

  if (result.outcome === "duplicate_tx_ref") {
    // tx_ref is freshly generated with 128 bits of randomness. Reaching
    // this branch means a genuine collision, not a normal client-facing
    // condition — there is no meaningful retry for the caller here, only
    // something to investigate server-side.
    console.error("Freshly generated txRef collided with an existing idempotencyKey");
    return NextResponse.json({ error: "Could not start checkout. Please try again." }, { status: 500 });
  }
  if (result.outcome === "provider_error") {
    // Never the raw provider string — initiateCheckoutCharge's failure
    // reasons are this app's own labels, not anything Flutterwave sent.
    return NextResponse.json(
      { error: "We couldn't reach the payment provider. Please try again." },
      { status: 502 },
    );
  }

  return NextResponse.json({ checkoutUrl: result.checkoutUrl }, { status: 200 });
}
