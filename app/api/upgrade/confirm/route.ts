import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { confirmUpgradeSchema } from "@/lib/validation/schemas";
import { confirmUpgrade } from "@/lib/upgradeConfirm";

/**
 * Confirmation. Takes only the tx_ref from an earlier quote — no amount
 * field exists on this request at all, so there is nothing client-
 * submitted to distrust; the charge is recomputed entirely server-side
 * inside confirmUpgrade.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "You must be signed in." }, { status: 401 });
  }
  const user = session.user;

  const body = await request.json().catch(() => null);
  if (body === null) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = confirmUpgradeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", fieldErrors: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  // Keyed on the user, not the IP — same reasoning as /api/checkout: this
  // route always has a session, and it makes a real request to
  // Flutterwave.
  const { limit, windowSeconds } = RATE_LIMITS.upgradeConfirm;
  const rate = await checkRateLimit(`upgrade-confirm:user:${user.id}`, limit, windowSeconds);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

  const appBaseUrl = process.env.APP_BASE_URL;
  if (!appBaseUrl) {
    throw new Error("APP_BASE_URL is not set");
  }

  const result = await confirmUpgrade({
    userId: user.id,
    txRef: parsed.data.txRef,
    now: new Date(),
    customerEmail: user.email,
    customerName: user.name,
    redirectUrl: `${appBaseUrl}/checkout/return`,
  });

  switch (result.outcome) {
    case "initiated":
      return NextResponse.json({ checkoutUrl: result.checkoutUrl });
    case "quote_not_found":
      return NextResponse.json({ error: "Quote not found. Please request a new quote." }, { status: 400 });
    case "already_confirmed":
      return NextResponse.json({ error: "This upgrade has already been initiated." }, { status: 409 });
    case "stale":
      return NextResponse.json(
        { error: "This quote has expired. Please request a new quote." },
        { status: 409 },
      );
    case "not_eligible":
      return NextResponse.json({ error: result.reason }, { status: 400 });
    case "provider_error":
      return NextResponse.json(
        { error: "We couldn't reach the payment provider. Please try again." },
        { status: 502 },
      );
  }
}
