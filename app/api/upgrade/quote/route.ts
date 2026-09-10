import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { quoteUpgrade } from "@/lib/upgradeQuote";
import { methodNotAllowed } from "@/lib/methodNotAllowed";

/** See lib/methodNotAllowed.ts — a browser GET gets a real 405, not a
 * blank one. */
export async function GET() {
  return methodNotAllowed(["POST"]);
}

/**
 * The quote step. Writes PRORATION_QUOTED and returns the numbers to show
 * the user — days remaining, credit, charge — but initiates no payment.
 * Confirmation is a separate, explicit call (POST /api/upgrade/confirm).
 */
export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "You must be signed in." }, { status: 401 });
  }

  const result = await quoteUpgrade({ userId: session.user.id, now: new Date() });

  switch (result.outcome) {
    case "quoted":
      return NextResponse.json({
        txRef: result.txRef,
        daysInPeriod: result.daysInPeriod,
        daysRemaining: result.daysRemaining,
        creditMinor: result.creditMinor,
        chargeMinor: result.chargeMinor,
        currency: result.currency,
      });
    case "already_yearly":
      return NextResponse.json({ error: "You are already on the yearly plan." }, { status: 400 });
    case "no_paid_plan":
      return NextResponse.json(
        { error: "Subscribe to a plan first — there is nothing to upgrade from." },
        { status: 400 },
      );
    case "inconsistent":
      return NextResponse.json(
        { error: "Could not compute a quote. Please try again." },
        { status: 500 },
      );
    default: {
      const exhaustive: never = result;
      throw new Error(`Unhandled QuoteUpgradeResult outcome: ${JSON.stringify(exhaustive)}`);
    }
  }
}
