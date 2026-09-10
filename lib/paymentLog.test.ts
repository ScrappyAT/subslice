import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { prisma } from "./prisma";
import { appendPaymentEvent, type EntitlementGrantedInput } from "./paymentLog";

// These tests run against the real database (per this step's instructions —
// idempotency under real concurrency cannot be proven against a mock). Each
// test gets its own user; deleting it cascades to whatever PaymentEvent rows
// the test created, so nothing is left behind in the dev database.

let user: User;

beforeEach(async () => {
  user = await prisma.user.create({
    data: {
      email: `paymentlog-test-${randomUUID()}@example.test`,
      passwordHash: "not-a-real-hash",
      name: "Payment Log Test User",
    },
  });
});

afterEach(async () => {
  await prisma.user.delete({ where: { id: user.id } });
});

describe("appendPaymentEvent", () => {
  it("returns the inserted event with a seq", async () => {
    const result = await appendPaymentEvent({
      type: "CHECKOUT_INITIATED",
      userId: user.id,
      idempotencyKey: `checkout:${randomUUID()}`,
      txRef: randomUUID(),
      planCode: "monthly",
      amountMinor: 250000,
      currency: "NGN",
    });

    expect(result.outcome).toBe("inserted");
    if (result.outcome !== "inserted") throw new Error("unreachable");
    expect(typeof result.event.seq).toBe("number");
    expect(Number.isInteger(result.event.seq)).toBe(true);
  });

  it("reports the second append of the same idempotencyKey as a duplicate, inserting one row", async () => {
    const idempotencyKey = `checkout:${randomUUID()}`;
    const input = {
      type: "CHECKOUT_INITIATED" as const,
      userId: user.id,
      idempotencyKey,
      txRef: randomUUID(),
      planCode: "monthly",
      amountMinor: 250000,
      currency: "NGN",
    };

    const first = await appendPaymentEvent(input);
    const second = await appendPaymentEvent(input);

    expect(first.outcome).toBe("inserted");
    expect(second).toEqual({ outcome: "duplicate", idempotencyKey });

    const rows = await prisma.paymentEvent.findMany({ where: { idempotencyKey } });
    expect(rows).toHaveLength(1);
  });

  it("resolves two concurrent appends of the same key to one insert and one duplicate", async () => {
    // This is the case a check-then-insert gets wrong: both calls would see
    // "no existing row" before either commits. Firing them together with
    // Promise.all is what actually exercises that race, rather than two
    // sequential awaits that never overlap.
    const idempotencyKey = `checkout:${randomUUID()}`;
    const input = {
      type: "CHECKOUT_INITIATED" as const,
      userId: user.id,
      idempotencyKey,
      txRef: randomUUID(),
      planCode: "monthly",
      amountMinor: 250000,
      currency: "NGN",
    };

    const [a, b] = await Promise.all([appendPaymentEvent(input), appendPaymentEvent(input)]);
    const outcomes = [a.outcome, b.outcome].sort();

    expect(outcomes).toEqual(["duplicate", "inserted"]);

    const rows = await prisma.paymentEvent.findMany({ where: { idempotencyKey } });
    expect(rows).toHaveLength(1);
  });

  it("rejects an ENTITLEMENT_GRANTED missing its period at the database, naming PaymentEvent_grant_complete", async () => {
    // periodStart/periodEnd are required by EntitlementGrantedInput, so
    // reaching this state at all requires deliberately bypassing the type —
    // exactly the scenario the check constraint exists for: a bug that
    // slips past the type checker must still be caught, here, by the
    // database. This is the one place in the test suite that constructs an
    // input the type system would otherwise refuse to compile.
    const malformed = {
      type: "ENTITLEMENT_GRANTED",
      userId: user.id,
      idempotencyKey: `granted:${randomUUID()}`,
      providerReference: randomUUID(),
      planCode: "monthly",
      amountMinor: 250000,
      currency: "NGN",
      // periodStart and periodEnd omitted
    } as unknown as EntitlementGrantedInput;

    await expect(appendPaymentEvent(malformed)).rejects.toThrow(/PaymentEvent_grant_complete/);

    const rows = await prisma.paymentEvent.findMany({
      where: { idempotencyKey: malformed.idempotencyKey },
    });
    expect(rows).toHaveLength(0);
  });

  // Step 11 follow-up 2, Q5: reason is scoped to its event type, and barred
  // from being empty or whitespace-only, at the database itself — not only
  // by cancellationReasonSchema (lib/validation/schemas.ts), which these
  // tests deliberately bypass the same way the grant_complete test above
  // does, to prove the database catches it independently.

  it("rejects an empty-string reason on CANCELLATION_REASON_PROVIDED, naming PaymentEvent_reason_not_blank", async () => {
    const input = {
      type: "CANCELLATION_REASON_PROVIDED",
      userId: user.id,
      idempotencyKey: `cancel-reason:${randomUUID()}`,
      reason: "",
    } as unknown as import("./paymentLog").CancellationReasonProvidedInput;

    await expect(appendPaymentEvent(input)).rejects.toThrow(/PaymentEvent_reason_not_blank/);

    const rows = await prisma.paymentEvent.findMany({ where: { idempotencyKey: input.idempotencyKey } });
    expect(rows).toHaveLength(0);
  });

  it("rejects a whitespace-only reason on CANCELLATION_REASON_PROVIDED, naming PaymentEvent_reason_not_blank", async () => {
    const input = {
      type: "CANCELLATION_REASON_PROVIDED",
      userId: user.id,
      idempotencyKey: `cancel-reason:${randomUUID()}`,
      reason: "   ",
    } as unknown as import("./paymentLog").CancellationReasonProvidedInput;

    await expect(appendPaymentEvent(input)).rejects.toThrow(/PaymentEvent_reason_not_blank/);

    const rows = await prisma.paymentEvent.findMany({ where: { idempotencyKey: input.idempotencyKey } });
    expect(rows).toHaveLength(0);
  });

  it("rejects a reason on a fulfilment row (ENTITLEMENT_GRANTED), naming PaymentEvent_reason_scoped_to_type", async () => {
    // EntitlementGrantedInput has no `reason` field, and toCreateData's
    // ENTITLEMENT_GRANTED case (lib/paymentLog.ts) whitelists exactly the
    // columns that type declares — so a `reason` smuggled in via a cast
    // through appendPaymentEvent is silently dropped before it ever
    // reaches Prisma, not rejected. That's correct application-layer
    // behaviour, but it means this specific constraint can only be
    // exercised by going under this file entirely, with the one raw
    // `prisma.paymentEvent.create` this test file is exempted from the
    // no-restricted-syntax rule for (eslint.config.mjs) — proving the
    // database itself refuses this, independent of anything paymentLog.ts
    // does or doesn't whitelist.
    const idempotencyKey = `granted:${randomUUID()}`;

    await expect(
      prisma.paymentEvent.create({
        data: {
          type: "ENTITLEMENT_GRANTED",
          userId: user.id,
          idempotencyKey,
          providerReference: randomUUID(),
          planCode: "monthly",
          periodStart: new Date(Date.UTC(2026, 0, 1)),
          periodEnd: new Date(Date.UTC(2026, 1, 1)),
          amountMinor: 250000,
          currency: "NGN",
          reason: "should never be here",
        },
      }),
    ).rejects.toThrow(/PaymentEvent_reason_scoped_to_type/);

    const rows = await prisma.paymentEvent.findMany({ where: { idempotencyKey } });
    expect(rows).toHaveLength(0);
  });
});
