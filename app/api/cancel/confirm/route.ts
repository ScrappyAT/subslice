import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { requestCancellation } from "@/lib/cancellation";
import { methodNotAllowed } from "@/lib/methodNotAllowed";

/** A browser GET here — a direct visit, not this app's own fetch() call —
 * gets a real 405 with an Allow header, not Next's blank default. See
 * lib/methodNotAllowed.ts. */
export async function GET() {
  return methodNotAllowed(["POST"]);
}

/**
 * On explicit confirmation only — nothing before this point wrote
 * anything. Writes CANCELLATION_REQUESTED: an intent, not a revocation.
 * Access is retained to the end of the paid period; see
 * lib/cancellation.ts for why (the brief's named trap).
 */
export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "You must be signed in." }, { status: 401 });
  }

  const result = await requestCancellation({ userId: session.user.id, now: new Date() });

  switch (result.outcome) {
    case "cancelled":
      return NextResponse.json({ planCode: result.planCode, periodEnd: result.periodEnd });
    case "already_cancelled":
      return NextResponse.json(
        { error: "Your subscription is already set to cancel.", planCode: result.planCode, periodEnd: result.periodEnd },
        { status: 400 },
      );
    case "no_active_paid_plan":
      return NextResponse.json(
        { error: "There is no active paid plan to cancel.", planCode: result.planCode },
        { status: 400 },
      );
    case "inconsistent":
      return NextResponse.json(
        { error: "Could not cancel your subscription. Please try again." },
        { status: 500 },
      );
    default: {
      const exhaustive: never = result;
      throw new Error(`Unhandled RequestCancellationResult outcome: ${JSON.stringify(exhaustive)}`);
    }
  }
}
