import { randomUUID } from "node:crypto";
import type { PaymentEvent, PaymentEventType, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "./prisma";
import { appendPaymentEvent } from "./paymentLog";
import { deriveEntitlement } from "./entitlement";
import { yearlyPeriodEnd } from "./period";
import { scheduleDowngrade, cancelScheduledDowngrade } from "./downgrade";

// --- Pure derivation cases: no database, matching lib/entitlement.test.ts's
// own style, since this is confirming that module's already-built
// DOWNGRADE_SCHEDULED handling with this step's specific numbers
// (yearly -> monthly) rather than adding new logic of its own. ---

let seqCounter = 0;
function makeEvent(overrides: Partial<PaymentEvent> & { type: PaymentEventType }): PaymentEvent {
  seqCounter += 1;
  return {
    id: `evt_${seqCounter}`,
    seq: seqCounter,
    userId: "user_1",
    planCode: null,
    txRef: null,
    providerReference: null,
    amountMinor: null,
    currency: null,
    creditAppliedMinor: null,
    periodStart: null,
    periodEnd: null,
    reason: null,
    payload: null,
    idempotencyKey: `key_${seqCounter}`,
    createdAt: new Date(Date.UTC(2026, 0, 1)),
    ...overrides,
  };
}

describe("deriveEntitlement — downgrade scheduled (pure, no database)", () => {
  const yearlyStart = new Date(Date.UTC(2026, 0, 1));
  const yearlyEnd = yearlyPeriodEnd(yearlyStart);

  // The exact same `events` array for both cases below — only `now`
  // differs between them.
  const events: PaymentEvent[] = [
    makeEvent({
      type: "ENTITLEMENT_GRANTED",
      planCode: "yearly",
      periodStart: yearlyStart,
      periodEnd: yearlyEnd,
      amountMinor: 2500000,
      currency: "NGN",
      providerReference: "ref_1",
    }),
    makeEvent({ type: "DOWNGRADE_SCHEDULED", planCode: "monthly" }),
  ];

  it("scheduling a downgrade from yearly to monthly leaves today's access and plan unchanged", () => {
    const stillWithinPeriod = new Date(Date.UTC(2026, 5, 1)); // well before yearlyEnd
    const result = deriveEntitlement(events, stillWithinPeriod);

    expect(result).toMatchObject({
      status: "ok",
      planCode: "yearly",
      accessGranted: true,
      pendingPlanCode: "monthly",
    });
  });

  it("the same log evaluated with now past the period end shows monthly, with pendingPlanCode cleared", () => {
    const pastTheBoundary = new Date(yearlyEnd.getTime() + 24 * 60 * 60 * 1000);
    const result = deriveEntitlement(events, pastTheBoundary);

    expect(result).toMatchObject({
      status: "ok",
      planCode: "monthly",
      pendingPlanCode: null,
    });
  });
});

// --- Guard and idempotency-key cases: real database, matching every other
// suite's convention (scheduleDowngrade/cancelScheduledDowngrade write to
// the log for real). ---

let user: User;

beforeEach(async () => {
  user = await prisma.user.create({
    data: {
      email: `downgrade-test-${randomUUID()}@example.test`,
      passwordHash: "not-a-real-hash",
      name: "Downgrade Test User",
    },
  });
});

afterEach(async () => {
  await prisma.user.delete({ where: { id: user.id } }); // cascades PaymentEvent, Subscription
});

async function subscribe(forUser: User, planCode: "monthly" | "yearly", periodStart: Date, periodEnd: Date) {
  const result = await appendPaymentEvent({
    type: "ENTITLEMENT_GRANTED",
    userId: forUser.id,
    idempotencyKey: `granted:seed-${randomUUID()}`,
    providerReference: `seed-${randomUUID()}`,
    planCode,
    periodStart,
    periodEnd,
    amountMinor: planCode === "yearly" ? 2500000 : 250000,
    currency: "NGN",
  });
  if (result.outcome !== "inserted") throw new Error("test setup failed");
}

describe("scheduleDowngrade", () => {
  it("downgrading to the same plan is rejected", async () => {
    const start = new Date(Date.UTC(2026, 0, 1));
    await subscribe(user, "yearly", start, yearlyPeriodEnd(start));

    const result = await scheduleDowngrade({
      userId: user.id,
      targetPlanCode: "yearly",
      now: new Date(Date.UTC(2026, 5, 1)),
    });

    expect(result.outcome).toBe("same_plan");
  });

  it("downgrading to a more expensive plan is rejected", async () => {
    const start = new Date(Date.UTC(2026, 0, 1));
    await subscribe(user, "monthly", start, new Date(Date.UTC(2026, 1, 1)));

    const result = await scheduleDowngrade({
      userId: user.id,
      targetPlanCode: "yearly",
      now: new Date(Date.UTC(2026, 0, 15)),
    });

    expect(result.outcome).toBe("would_be_upgrade");
  });

  it("downgrading with no active period is rejected", async () => {
    // No ENTITLEMENT_GRANTED at all — planCode is "free" and always has
    // been.
    const result = await scheduleDowngrade({
      userId: user.id,
      targetPlanCode: "monthly",
      now: new Date(Date.UTC(2026, 0, 15)),
    });

    expect(result.outcome).toBe("no_active_paid_plan");
  });

  it("scheduling, cancelling, and re-scheduling within one period does not collide on the idempotency key", async () => {
    const start = new Date(Date.UTC(2026, 0, 1));
    const end = yearlyPeriodEnd(start);
    await subscribe(user, "yearly", start, end);
    // Three separate actions, so three separate moments — as they would
    // be in reality (each a distinct HTTP request capturing its own
    // `new Date()`), not three calls sharing one artificially identical
    // instant. The follow-up key includes `now`, so two follow-ups at the
    // exact same millisecond would collide; that is not a realistic
    // scenario for three human decisions, or even three fast automated
    // ones, in a way the schedule-then-charge tx_ref pattern elsewhere in
    // this codebase has to guard against (there, a network retry really
    // can resubmit the identical request).
    const now = new Date(Date.UTC(2026, 5, 1));
    const aMomentLater = new Date(now.getTime() + 1000);
    const laterStill = new Date(now.getTime() + 2000);

    const first = await scheduleDowngrade({ userId: user.id, targetPlanCode: "monthly", now });
    expect(first.outcome).toBe("scheduled");

    const cancelled = await cancelScheduledDowngrade({ userId: user.id, now: aMomentLater });
    expect(cancelled.outcome).toBe("cancelled");

    const second = await scheduleDowngrade({ userId: user.id, targetPlanCode: "monthly", now: laterStill });
    expect(second.outcome).toBe("scheduled");

    const rows = await prisma.paymentEvent.findMany({
      where: { userId: user.id, type: "DOWNGRADE_SCHEDULED" },
      orderBy: { seq: "asc" },
    });
    // Three distinct actions, three rows — none silently swallowed as a
    // duplicate of an earlier, different decision.
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(3);
    // The first uses the bare per-period key exactly as AGENTS.md states
    // it; the follow-ups (cancel, reschedule) each carry their own moment.
    expect(rows[0].idempotencyKey).toBe(`downgrade:${user.id}:${end.toISOString()}`);
    expect(rows[1].planCode).toBe("yearly"); // the cancel: back to the current plan
    expect(rows[2].planCode).toBe("monthly"); // the reschedule: the real, final intent

    // The latest decision (seq order, not action order) is what wins.
    const events = await prisma.paymentEvent.findMany({ where: { userId: user.id }, orderBy: { seq: "asc" } });
    const entitlement = deriveEntitlement(events, laterStill);
    expect(entitlement).toMatchObject({ planCode: "yearly", pendingPlanCode: "monthly" });
  });
});

describe("cancelScheduledDowngrade", () => {
  it("rejects when nothing is pending", async () => {
    const start = new Date(Date.UTC(2026, 0, 1));
    await subscribe(user, "yearly", start, yearlyPeriodEnd(start));

    const result = await cancelScheduledDowngrade({ userId: user.id, now: new Date(Date.UTC(2026, 5, 1)) });

    expect(result.outcome).toBe("no_pending_downgrade");
  });
});
