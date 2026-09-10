import { randomUUID } from "node:crypto";
import type { PaymentEvent, PaymentEventType, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "./prisma";
import { appendPaymentEvent } from "./paymentLog";
import { deriveEntitlement } from "./entitlement";
import { refreshSubscriptionProjection } from "./subscriptionProjection";
import { monthlyPeriodEnd, yearlyPeriodEnd } from "./period";
import {
  previewCancellation,
  requestCancellation,
  provideCancellationReason,
} from "./cancellation";
import { scheduleDowngrade } from "./downgrade";

// --- Pure derivation cases: no database, matching lib/entitlement.test.ts's
// and lib/downgrade.test.ts's own style — confirming entitlement.ts's
// already-built CANCELLATION_REQUESTED/CANCELLATION_REASON_PROVIDED
// handling with this step's specific scenarios. ---

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

describe("deriveEntitlement — cancellation (pure, no database)", () => {
  const start = new Date(Date.UTC(2026, 0, 1));
  const end = yearlyPeriodEnd(start);

  // The exact same `events` array for both "before" and "after" cases —
  // only `now` differs between them.
  const cancelledOnly: PaymentEvent[] = [
    makeEvent({
      type: "ENTITLEMENT_GRANTED",
      planCode: "yearly",
      periodStart: start,
      periodEnd: end,
      amountMinor: 2500000,
      currency: "NGN",
      providerReference: "ref_1",
    }),
    makeEvent({ type: "CANCELLATION_REQUESTED", planCode: "yearly" }),
  ];

  it("cancelling retains access: now before period end, accessGranted true and cancelAtPeriodEnd true", () => {
    const beforeEnd = new Date(Date.UTC(2026, 5, 1));
    const result = deriveEntitlement(cancelledOnly, beforeEnd);

    expect(result).toMatchObject({
      status: "ok",
      planCode: "yearly",
      accessGranted: true,
      cancelAtPeriodEnd: true,
    });
  });

  it("same log, now after period end: no access", () => {
    const afterEnd = new Date(end.getTime() + 24 * 60 * 60 * 1000);
    const result = deriveEntitlement(cancelledOnly, afterEnd);

    expect(result).toMatchObject({
      status: "ok",
      accessGranted: false,
    });
  });

  it("a reason skipped leaves it null", () => {
    const result = deriveEntitlement(cancelledOnly, new Date(Date.UTC(2026, 5, 1)));
    expect(result).toMatchObject({ cancellationReason: null });
  });

  it("a reason provided after cancellation appears in the derived state", () => {
    const withReason: PaymentEvent[] = [
      ...cancelledOnly,
      makeEvent({ type: "CANCELLATION_REASON_PROVIDED", reason: "too expensive" }),
    ];

    const result = deriveEntitlement(withReason, new Date(Date.UTC(2026, 5, 1)));

    expect(result).toMatchObject({ cancellationReason: "too expensive" });
  });

  it("CANCELLATION_REASON_PROVIDED with no prior cancellation is inconsistent", () => {
    const noCancellation: PaymentEvent[] = [
      makeEvent({
        type: "ENTITLEMENT_GRANTED",
        planCode: "yearly",
        periodStart: start,
        periodEnd: end,
        amountMinor: 2500000,
        currency: "NGN",
        providerReference: "ref_2",
      }),
      makeEvent({ type: "CANCELLATION_REASON_PROVIDED", reason: "too expensive" }),
    ];

    const result = deriveEntitlement(noCancellation, new Date(Date.UTC(2026, 5, 1)));

    expect(result.status).toBe("inconsistent");
  });

  it("a fulfilment event wins over an earlier cancellation regardless of which has the later createdAt — seq order decides, not wall-clock time", () => {
    // createdAt is deliberately backwards: the fulfilment event (seq 2)
    // carries an EARLIER createdAt than the cancellation it must still
    // beat (seq 1). If deriveEntitlement ever started consulting
    // createdAt instead of array/seq order, this is the test that would
    // catch it — a correct implementation ignores createdAt entirely and
    // this passes anyway.
    const cancelledAt = new Date(Date.UTC(2026, 0, 2));
    const paidAgainAt = new Date(Date.UTC(2026, 0, 1)); // earlier wall-clock time, later seq

    const events: PaymentEvent[] = [
      makeEvent({
        type: "ENTITLEMENT_GRANTED",
        planCode: "yearly",
        periodStart: start,
        periodEnd: end,
        amountMinor: 2500000,
        currency: "NGN",
        providerReference: "ref_seq_order",
        createdAt: new Date(Date.UTC(2025, 11, 1)),
      }),
      makeEvent({ type: "CANCELLATION_REQUESTED", planCode: "yearly", createdAt: cancelledAt }),
      makeEvent({
        type: "ENTITLEMENT_GRANTED",
        planCode: "yearly",
        periodStart: end,
        periodEnd: yearlyPeriodEnd(end),
        amountMinor: 2500000,
        currency: "NGN",
        providerReference: "ref_seq_order_2",
        createdAt: paidAgainAt,
      }),
    ];

    const result = deriveEntitlement(events, new Date(Date.UTC(2026, 5, 1)));

    // The later-in-the-log fulfilment wins: cancellation cleared, period
    // extended to the new grant's end — exactly as ENTITLEMENT_GRANTED's
    // unconditional `cancelAtPeriodEnd = false` dictates, unaffected by
    // createdAt being "before" the cancellation it supersedes.
    expect(result).toMatchObject({
      status: "ok",
      cancelAtPeriodEnd: false,
      periodEnd: yearlyPeriodEnd(end),
    });
  });

  it("cancelling supersedes a pending downgrade", () => {
    const withPendingDowngrade: PaymentEvent[] = [
      makeEvent({
        type: "ENTITLEMENT_GRANTED",
        planCode: "yearly",
        periodStart: start,
        periodEnd: end,
        amountMinor: 2500000,
        currency: "NGN",
        providerReference: "ref_3",
      }),
      makeEvent({ type: "DOWNGRADE_SCHEDULED", planCode: "monthly" }),
      makeEvent({ type: "CANCELLATION_REQUESTED", planCode: "yearly" }),
    ];

    const result = deriveEntitlement(withPendingDowngrade, new Date(Date.UTC(2026, 5, 1)));

    expect(result).toMatchObject({ cancelAtPeriodEnd: true, pendingPlanCode: null });
  });
});

// --- Guard and write-path cases: real database, matching every other
// suite's convention. ---

let user: User;

beforeEach(async () => {
  user = await prisma.user.create({
    data: {
      email: `cancellation-test-${randomUUID()}@example.test`,
      passwordHash: "not-a-real-hash",
      name: "Cancellation Test User",
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

describe("previewCancellation", () => {
  it("shows the plan and the date access ends, without writing anything", async () => {
    const start = new Date(Date.UTC(2026, 0, 1));
    const end = yearlyPeriodEnd(start);
    await subscribe(user, "yearly", start, end);

    const result = await previewCancellation({ userId: user.id, now: new Date(Date.UTC(2026, 5, 1)) });

    expect(result).toEqual({ outcome: "previewed", planCode: "yearly", periodEnd: end });
    const rows = await prisma.paymentEvent.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1); // only the seeded grant — preview wrote nothing
  });

  it("rejects when there is no active paid plan, naming the plan rather than omitting it", async () => {
    const result = await previewCancellation({ userId: user.id, now: new Date() });
    expect(result).toEqual({ outcome: "no_active_paid_plan", planCode: "free" });
  });
});

describe("requestCancellation", () => {
  it("writes CANCELLATION_REQUESTED and refreshes the projection, without touching the period", async () => {
    const start = new Date(Date.UTC(2026, 0, 1));
    const end = yearlyPeriodEnd(start);
    await subscribe(user, "yearly", start, end);
    const now = new Date(Date.UTC(2026, 5, 1));

    const result = await requestCancellation({ userId: user.id, now });

    expect(result).toEqual({ outcome: "cancelled", planCode: "yearly", periodEnd: end });

    const rows = await prisma.paymentEvent.findMany({ where: { userId: user.id, type: "CANCELLATION_REQUESTED" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyKey).toBe(`cancel:${user.id}:${end.toISOString()}`);

    const sub = await prisma.subscription.findUnique({ where: { userId: user.id } });
    expect(sub).toMatchObject({ cancelAtPeriodEnd: true, status: "CANCELLING" });
    expect(sub?.cancelledAt).not.toBeNull();
  });

  it("rejects a second cancellation of an already-cancelled subscription, naming the plan and date", async () => {
    const start = new Date(Date.UTC(2026, 0, 1));
    const end = yearlyPeriodEnd(start);
    await subscribe(user, "yearly", start, end);
    const now = new Date(Date.UTC(2026, 5, 1));

    await requestCancellation({ userId: user.id, now });
    const second = await requestCancellation({ userId: user.id, now });

    expect(second).toEqual({ outcome: "already_cancelled", planCode: "yearly", periodEnd: end });
  });

  it("rejects when there is no active paid plan, naming the plan rather than omitting it", async () => {
    const result = await requestCancellation({ userId: user.id, now: new Date() });
    expect(result).toEqual({ outcome: "no_active_paid_plan", planCode: "free" });
  });

  it("cancel, resubscribe, cancel again in a later period: no key collision", async () => {
    const start1 = new Date(Date.UTC(2026, 0, 1));
    const end1 = monthlyPeriodEnd(start1);
    await subscribe(user, "monthly", start1, end1);

    const first = await requestCancellation({ userId: user.id, now: new Date(Date.UTC(2026, 0, 15)) });
    expect(first.outcome).toBe("cancelled");

    // A fresh subscribe — a new period, a new currentPeriodEnd.
    const start2 = new Date(Date.UTC(2026, 2, 1));
    const end2 = monthlyPeriodEnd(start2);
    await subscribe(user, "monthly", start2, end2);

    const second = await requestCancellation({ userId: user.id, now: new Date(Date.UTC(2026, 2, 15)) });
    expect(second.outcome).toBe("cancelled");

    const rows = await prisma.paymentEvent.findMany({
      where: { userId: user.id, type: "CANCELLATION_REQUESTED" },
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(2);
    expect(rows.map((r) => r.idempotencyKey).sort()).toEqual(
      [`cancel:${user.id}:${end1.toISOString()}`, `cancel:${user.id}:${end2.toISOString()}`].sort(),
    );
  });

  it("cancel anchored to P1, then a fulfilment event extends the period to P2: the anchor moves, cancelAtPeriodEnd clears, and a second cancellation writes cleanly under P2", async () => {
    const start = new Date(Date.UTC(2026, 0, 1));
    const end1 = monthlyPeriodEnd(start); // P1
    await subscribe(user, "monthly", start, end1);
    const now = new Date(Date.UTC(2026, 0, 15)); // still within P1

    const first = await requestCancellation({ userId: user.id, now });
    expect(first).toEqual({ outcome: "cancelled", planCode: "monthly", periodEnd: end1 });

    // A fulfilment event — a real payment, not a UI action — extends the
    // existing period rather than closing it: same convention
    // lib/entitlement.test.ts's "paid twice" case uses (periodStart set to
    // the existing periodEnd, not to `now`).
    const end2 = monthlyPeriodEnd(end1); // P2
    await subscribe(user, "monthly", end1, end2);

    // The new grant unconditionally clears cancelAtPeriodEnd
    // (lib/entitlement.ts's ENTITLEMENT_GRANTED case) — confirmed directly
    // before acting on it again, so this test pins *why* a second
    // CANCELLATION_REQUESTED is even legal here: it is cancelling a live,
    // uncancelled subscription, not re-cancelling a dead one.
    const midEvents = await prisma.paymentEvent.findMany({ where: { userId: user.id }, orderBy: { seq: "asc" } });
    const midEntitlement = deriveEntitlement(midEvents, now);
    expect(midEntitlement).toMatchObject({ cancelAtPeriodEnd: false, planCode: "monthly", periodEnd: end2 });

    const second = await requestCancellation({ userId: user.id, now });
    expect(second).toEqual({ outcome: "cancelled", planCode: "monthly", periodEnd: end2 });

    // Two CANCELLATION_REQUESTED rows for one subscription: a valid state,
    // not an inconsistency — each is scoped to the period it was requested
    // in, and the anchor (currentPeriodEnd) is exactly what moved, from P1
    // to P2, once a genuine new payment moved it.
    const rows = await prisma.paymentEvent.findMany({
      where: { userId: user.id, type: "CANCELLATION_REQUESTED" },
      orderBy: { seq: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].idempotencyKey).toBe(`cancel:${user.id}:${end1.toISOString()}`);
    expect(rows[1].idempotencyKey).toBe(`cancel:${user.id}:${end2.toISOString()}`);
    expect(rows[0].idempotencyKey).not.toBe(rows[1].idempotencyKey);
  });
});

describe("provideCancellationReason", () => {
  it("a cancellation with a reason produces exactly two rows", async () => {
    const start = new Date(Date.UTC(2026, 0, 1));
    const end = yearlyPeriodEnd(start);
    await subscribe(user, "yearly", start, end);
    const now = new Date(Date.UTC(2026, 5, 1));

    await requestCancellation({ userId: user.id, now });
    const result = await provideCancellationReason({ userId: user.id, reason: "too expensive", now });
    expect(result.outcome).toBe("recorded");

    const rows = await prisma.paymentEvent.findMany({
      where: { userId: user.id, type: { in: ["CANCELLATION_REQUESTED", "CANCELLATION_REASON_PROVIDED"] } },
      orderBy: { seq: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].type).toBe("CANCELLATION_REQUESTED");
    expect(rows[1]).toMatchObject({ type: "CANCELLATION_REASON_PROVIDED", reason: "too expensive" });

    // The full history (including the seeded grant), not just these two
    // rows — deriveEntitlement needs the grant to know there's a period at
    // all.
    const allEvents = await prisma.paymentEvent.findMany({ where: { userId: user.id }, orderBy: { seq: "asc" } });
    const entitlement = deriveEntitlement(allEvents, now);
    expect(entitlement).toMatchObject({ cancellationReason: "too expensive" });

    const sub = await prisma.subscription.findUnique({ where: { userId: user.id } });
    expect(sub?.cancellationReason).toBe("too expensive");
  });

  it("a full rebuild from events alone repopulates the projected cancellationReason", async () => {
    const start = new Date(Date.UTC(2026, 0, 1));
    const end = yearlyPeriodEnd(start);
    await subscribe(user, "yearly", start, end);
    const now = new Date(Date.UTC(2026, 5, 1));

    await requestCancellation({ userId: user.id, now });
    await provideCancellationReason({ userId: user.id, reason: "too expensive", now });

    // Destroy the cache outright — not just stale, gone — to prove the
    // projection is genuinely rebuildable and not merely incrementally
    // patched. Subscription is a derived cache (AGENTS.md); the event log
    // is the only place this fact is allowed to actually live.
    await prisma.subscription.delete({ where: { userId: user.id } });
    expect(await prisma.subscription.findUnique({ where: { userId: user.id } })).toBeNull();

    await refreshSubscriptionProjection(user.id, now);

    const rebuilt = await prisma.subscription.findUnique({ where: { userId: user.id } });
    expect(rebuilt).toMatchObject({
      planCode: "yearly",
      cancelAtPeriodEnd: true,
      cancellationReason: "too expensive",
    });
  });

  it("rejects a reason with no pending cancellation", async () => {
    const start = new Date(Date.UTC(2026, 0, 1));
    await subscribe(user, "yearly", start, yearlyPeriodEnd(start));

    const result = await provideCancellationReason({
      userId: user.id,
      reason: "too expensive",
      now: new Date(Date.UTC(2026, 5, 1)),
    });

    expect(result.outcome).toBe("no_pending_cancellation");
  });
});

describe("cancellation and a pending downgrade", () => {
  it("cancelling clears a scheduled downgrade (write path, not just derivation)", async () => {
    const start = new Date(Date.UTC(2026, 0, 1));
    const end = yearlyPeriodEnd(start);
    await subscribe(user, "yearly", start, end);
    const now = new Date(Date.UTC(2026, 5, 1));

    const scheduled = await scheduleDowngrade({ userId: user.id, targetPlanCode: "monthly", now });
    expect(scheduled.outcome).toBe("scheduled");

    const cancelled = await requestCancellation({ userId: user.id, now });
    expect(cancelled.outcome).toBe("cancelled");

    const events = await prisma.paymentEvent.findMany({ where: { userId: user.id }, orderBy: { seq: "asc" } });
    const entitlement = deriveEntitlement(events, now);
    expect(entitlement).toMatchObject({ cancelAtPeriodEnd: true, pendingPlanCode: null });

    const sub = await prisma.subscription.findUnique({ where: { userId: user.id } });
    expect(sub).toMatchObject({ cancelAtPeriodEnd: true, pendingPlanCode: null });
  });
});
