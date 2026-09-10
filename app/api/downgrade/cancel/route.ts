import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { cancelScheduledDowngrade } from "@/lib/downgrade";

/** Cancels a pending downgrade before it takes effect — see the module
 * comment in lib/downgrade.ts for how this is represented in the log. */
export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "You must be signed in." }, { status: 401 });
  }

  const result = await cancelScheduledDowngrade({ userId: session.user.id, now: new Date() });

  switch (result.outcome) {
    case "cancelled":
      return NextResponse.json({ planCode: result.planCode });
    case "no_pending_downgrade":
      return NextResponse.json({ error: "There is no scheduled downgrade to cancel." }, { status: 400 });
    case "inconsistent":
      return NextResponse.json({ error: "Could not cancel the downgrade. Please try again." }, { status: 500 });
  }
}
