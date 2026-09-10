import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { cancellationReasonSchema } from "@/lib/validation/schemas";
import { provideCancellationReason } from "@/lib/cancellation";
import { methodNotAllowed } from "@/lib/methodNotAllowed";

/** See lib/methodNotAllowed.ts — a browser GET gets a real 405, not a
 * blank one. */
export async function GET() {
  return methodNotAllowed(["POST"]);
}

/**
 * The optional reason prompt, shown after cancellation is already
 * recorded. Skippable by simply never calling this — there is no
 * "skipped" request this route needs to handle.
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

  const parsed = cancellationReasonSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", fieldErrors: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const result = await provideCancellationReason({
    userId: session.user.id,
    reason: parsed.data.reason,
    now: new Date(),
  });

  switch (result.outcome) {
    case "recorded":
      return NextResponse.json({ ok: true });
    case "no_pending_cancellation":
      return NextResponse.json(
        { error: "There is no pending cancellation to attach a reason to." },
        { status: 400 },
      );
    case "inconsistent":
      return NextResponse.json(
        { error: "Could not record your reason. Please try again.", planCode: result.planCode },
        { status: 500 },
      );
    default: {
      const exhaustive: never = result;
      throw new Error(`Unhandled ProvideCancellationReasonResult outcome: ${JSON.stringify(exhaustive)}`);
    }
  }
}
