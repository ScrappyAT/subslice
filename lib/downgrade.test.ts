import { randomUUID } from "node:crypto";
import type { PaymentEvent, PaymentEventType, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "./prisma";
import { appendPaymentEvent } from "./paymentLog";
import { deriveEntitlement } from "./entitlement";
import { yearlyPeriodEnd } from "./period";
import { scheduleDowngrade, cancelScheduledDowngrade } from "./downgrade";
import { requestCancellation } from "./cancellation";

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

  it("DOWNGRADE_CANCELLED with nothing pending is reported as inconsistent, not treated as a no-op", () => {
    const grantOnly: PaymentEvent[] = [
      makeEvent({
        type: "ENTITLEMENT_GRANTED",
        planCode: "yearly",
        periodStart: yearlyStart,
        periodEnd: yearlyEnd,
        amountMinor: 2500000,
        currency: "NGN",
        providerReference: "ref_2",
      }),
      makeEvent({ type: "DOWNGRADE_CANCELLED", planCode: "monthly" }),
    ];

    const result = deriveEntitlement(grantOnly, new Date(Date.UTC(2026, 5, 1)));

    expect(result.status).toBe("inconsistent");
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

  it("a cancelled subscription cannot schedule a downgrade — without this guard, DOWNGRADE_SCHEDULED's unconditional cancelAtPeriodEnd=false would silently un-cancel the user", async () => {
    const start = new Date(Date.UTC(2026, 0, 1));
    const end = yearlyPeriodEnd(start);
    await subscribe(user, "yearly", start, end);
    const now = new Date(Date.UTC(2026, 5, 1));

    const cancelled = await requestCancellation({ userId: user.id, now });
    expect(cancelled.outcome).toBe("cancelled");

    const result = await scheduleDowngrade({ userId: user.id, targetPlanCode: "monthly", now });
    expect(result.outcome).toBe("already_cancelled");

    // Pin the actual guard, not just the result: no DOWNGRADE_SCHEDULED row
    // was written, and re-deriving from the full log still shows the
    // subscription cancelled with nothing pending — the exact state a
    // missing guard would have silently overturned.
    const rows = await prisma.paymentEvent.findMany({ where: { userId: user.id, type: "DOWNGRADE_SCHEDULED" } });
    expect(rows).toHaveLength(0);

    const events = await prisma.paymentEvent.findMany({ where: { userId: user.id }, orderBy: { seq: "asc" } });
    const entitlement = deriveEntitlement(events, now);
    expect(entitlement).toMatchObject({ cancelAtPeriodEnd: true, pendingPlanCode: null });
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

  it("schedule, cancel, reschedule, cancel again within one period does not collide on the idempotency key", async () => {
    const start = new Date(Date.UTC(2026, 0, 1));
    const end = yearlyPeriodEnd(start);
    await subscribe(user, "yearly", start, end);

    // The same instant for all four actions, deliberately — the whole
    // point of anchoring keys on an already-committed seq rather than a
    // timestamp is that this no longer needs staggering to avoid
    // colliding. If this test used four different `now` values and still
    // passed, that would prove nothing about the seq-anchoring; using one
    // shared instant is what actually exercises it.
    const now = new Date(Date.UTC(2026, 5, 1));

    const scheduled1 = await scheduleDowngrade({ userId: user.id, targetPlanCode: "monthly", now });
    expect(scheduled1.outcome).toBe("scheduled");

    const cancelled1 = await cancelScheduledDowngrade({ userId: user.id, now });
    expect(cancelled1.outcome).toBe("cancelled");

    const scheduled2 = await scheduleDowngrade({ userId: user.id, targetPlanCode: "monthly", now });
    expect(scheduled2.outcome).toBe("scheduled");

    const cancelled2 = await cancelScheduledDowngrade({ userId: user.id, now });
    expect(cancelled2.outcome).toBe("cancelled");

    const rows = await prisma.paymentEvent.findMany({
      where: { userId: user.id, type: { in: ["DOWNGRADE_SCHEDULED", "DOWNGRADE_CANCELLED"] } },
      orderBy: { seq: "asc" },
    });
    // Four distinct actions, four rows — none silently swallowed as a
    // duplicate of an earlier, different decision.
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(4);
    expect(rows.map((r) => r.type)).toEqual([
      "DOWNGRADE_SCHEDULED",
      "DOWNGRADE_CANCELLED",
      "DOWNGRADE_SCHEDULED",
      "DOWNGRADE_CANCELLED",
    ]);

    // The very first schedule uses the bare per-period key exactly as
    // AGENTS.md states it; everything after anchors on the seq of the
    // event it follows, not on `now` (which is identical for all four).
    expect(rows[0].idempotencyKey).toBe(`downgrade:${user.id}:${end.toISOString()}`);
    expect(rows[1].idempotencyKey).toBe(`downgrade-cancel:${user.id}:${end.toISOString()}:${rows[0].seq}`);
    expect(rows[2].idempotencyKey).toBe(`downgrade:${user.id}:${end.toISOString()}:${rows[1].seq}`);
    expect(rows[3].idempotencyKey).toBe(`downgrade-cancel:${user.id}:${end.toISOString()}:${rows[2].seq}`);

    // The final decision — cancelled again — correctly reflects nothing
    // pending, not the reschedule two steps back.
    const events = await prisma.paymentEvent.findMany({ where: { userId: user.id }, orderBy: { seq: "asc" } });
    const entitlement = deriveEntitlement(events, now);
    expect(entitlement).toMatchObject({ planCode: "yearly", pendingPlanCode: null });
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
