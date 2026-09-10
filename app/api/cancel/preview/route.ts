import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { previewCancellation } from "@/lib/cancellation";

/**
 * The confirmation step, before anything is written: what cancelling
 * means, the plan they stay on and the date access ends. Cancellation
 * must not be a single unconfirmed click — this is what the user sees
 * before POST /api/cancel/confirm is ever called.
 *
 * GET, not POST: this writes nothing (previewCancellation never calls
 * appendPaymentEvent), so there is no action here for POST's semantics to
 * protect. `no-store` because the answer depends on `now` versus
 * periodEnd and must never be served from a cache once that boundary
 * passes.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "You must be signed in." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  const result = await previewCancellation({ userId: session.user.id, now: new Date() });

  switch (result.outcome) {
    case "previewed":
      return NextResponse.json(
        { planCode: result.planCode, periodEnd: result.periodEnd },
        { headers: { "Cache-Control": "no-store" } },
      );
    case "no_active_paid_plan":
      return NextResponse.json(
        { error: "There is no active paid plan to cancel.", planCode: result.planCode },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    case "inconsistent":
      return NextResponse.json(
        { error: "Could not load your plan. Please try again." },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    default: {
      // Exhaustiveness check: if PreviewCancellationResult ever gains a new
      // outcome, this fails to compile instead of silently falling through
      // and returning undefined — the exact bug Q9 of the step 11 follow-up
      // found in /api/downgrade.
      const exhaustive: never = result;
      throw new Error(`Unhandled PreviewCancellationResult outcome: ${JSON.stringify(exhaustive)}`);
    }
  }
}
