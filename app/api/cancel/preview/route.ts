import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { previewCancellation } from "@/lib/cancellation";

/**
 * The confirmation step, before anything is written: what cancelling
 * means, the plan they stay on and the date access ends. Cancellation
 * must not be a single unconfirmed click — this is what the user sees
 * before POST /api/cancel/confirm is ever called, and calling this
 * endpoint itself writes nothing.
 */
export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "You must be signed in." }, { status: 401 });
  }

  const result = await previewCancellation({ userId: session.user.id, now: new Date() });

  switch (result.outcome) {
    case "previewed":
      return NextResponse.json({ planCode: result.planCode, periodEnd: result.periodEnd });
    case "no_active_paid_plan":
      return NextResponse.json({ error: "There is no active paid plan to cancel." }, { status: 400 });
    case "inconsistent":
      return NextResponse.json({ error: "Could not load your plan. Please try again." }, { status: 500 });
  }
}
