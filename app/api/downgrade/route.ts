import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { downgradeSchema } from "@/lib/validation/schemas";
import { scheduleDowngrade } from "@/lib/downgrade";

/**
 * Schedules a downgrade, effective at the current period's end. No
 * payment, no Flutterwave call — the user already paid for the period
 * they're in. Returns exactly what the user needs to be told: the plan
 * they stay on until the boundary, the plan they move to, and the date
 * (the current period's end) that happens.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "You must be signed in." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (body === null) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = downgradeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", fieldErrors: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const result = await scheduleDowngrade({
    userId: session.user.id,
    targetPlanCode: parsed.data.targetPlanCode,
    now: new Date(),
  });

  switch (result.outcome) {
    case "scheduled":
      return NextResponse.json({
        currentPlanCode: result.currentPlanCode,
        targetPlanCode: result.targetPlanCode,
        effectiveAt: result.effectiveAt,
      });
    case "same_plan":
      return NextResponse.json({ error: "You are already on that plan." }, { status: 400 });
    case "would_be_upgrade":
      return NextResponse.json(
        { error: "That plan costs more — upgrade instead of downgrading." },
        { status: 400 },
      );
    case "target_is_free":
      return NextResponse.json(
        { error: "Cancel your subscription instead of downgrading to the free plan." },
        { status: 400 },
      );
    case "no_active_paid_plan":
      return NextResponse.json(
        { error: "There is no active paid period to downgrade from." },
        { status: 400 },
      );
    case "already_cancelled":
      return NextResponse.json(
        { error: "Your subscription is already set to cancel — resubscribe instead of downgrading." },
        { status: 400 },
      );
    case "invalid_target":
      return NextResponse.json({ error: "Unknown or unavailable plan code." }, { status: 400 });
    case "inconsistent":
      return NextResponse.json({ error: "Could not schedule the downgrade. Please try again." }, { status: 500 });
  }
}
