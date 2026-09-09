import { randomUUID } from "node:crypto";
import type { User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./prisma";
import { appendPaymentEvent } from "./paymentLog";
import { deriveEntitlement } from "./entitlement";
import { addCalendarMonths, monthlyPeriodEnd } from "./period";

// The verify call is the one thing this suite never touches for real —
// everything else (session's worth of user data, the checkout event, the
// log writer, entitlement derivation) runs against the real local
// database, the same convention as the other step's test suites.
vi.mock("./flutterwave/verify", () => ({ verifyTransaction: vi.fn() }));

import { verifyTransaction } from "./flutterwave/verify";
import { fulfilCheckout } from "./fulfilCheckout";

const mockVerify = vi.mocked(verifyTransaction);

let user: User;

beforeEach(async () => {
  user = await prisma.user.create({
    data: {
      email: `fulfil-test-${randomUUID()}@example.test`,
      passwordHash: "not-a-real-hash",
      name: "Fulfil Test User",
    },
  });
  mockVerify.mockReset();
});

afterEach(async () => {
  await prisma.user.delete({ where: { id: user.id } }); // cascades PaymentEvent
});

// Simulates what the checkout route (step 6) already does: write
// CHECKOUT_INITIATED — recording the amount and currency quoted at that
// moment — for a real user/plan before Flutterwave is ever involved.
// amountMinor/currency default to the monthly plan's actual seeded price,
// but several tests below override them to something else entirely, to
// prove verification checks against *this recorded value*, not Plan.
async function initiateCheckout(
  forUser: User,
  overrides: { planCode?: string; amountMinor?: number; currency?: string } = {},
): Promise<string> {
  const txRef = `chk_${randomUUID()}`;
  const result = await appendPaymentEvent({
    type: "CHECKOUT_INITIATED",
    userId: forUser.id,
    idempotencyKey: `checkout:${txRef}`,
    txRef,
    planCode: overrides.planCode ?? "monthly",
    amountMinor: overrides.amountMinor ?? 250000,
    currency: overrides.currency ?? "NGN",
  });
  if (result.outcome !== "inserted") throw new Error("test setup failed");
  return txRef;
}

// Matches initiateCheckout's default amountMinor (250000) — the amount a
// verify response has to report, in NGN major units, to pass check 3
// against the *recorded* value.
const RECORDED_MAJOR = "2500.00";

function successfulVerify(overrides: Partial<{ status: string; txRef: string; amount: string; currency: string }> = {}, txRef: string) {
  mockVerify.mockResolvedValue({
    ok: true,
    data: {
      status: overrides.status ?? "successful",
      txRef: overrides.txRef ?? txRef,
      amount: overrides.amount ?? RECORDED_MAJOR,
      currency: overrides.currency ?? "NGN",
    },
    raw: { status: "success", data: { status: overrides.status ?? "successful" } },
  });
}

describe("fulfilCheckout", () => {
  it("happy path: writes PAYMENT_VERIFIED and ENTITLEMENT_GRANTED, and entitlement derives correctly", async () => {
    const txRef = await initiateCheckout(user);
    const transactionId = randomUUID();
    successfulVerify({}, txRef);

    const result = await fulfilCheckout({ userId: user.id, txRef, transactionId, now: new Date(2026, 0, 1) });

    expect(result.outcome).toBe("granted");

    const rows = await prisma.paymentEvent.findMany({
      where: { userId: user.id },
      orderBy: { seq: "asc" },
    });
    expect(rows.map((r) => r.type)).toEqual([
      "CHECKOUT_INITIATED",
      "PAYMENT_VERIFIED",
      "ENTITLEMENT_GRANTED",
    ]);
    expect(rows[1].idempotencyKey).toBe(`verified:${transactionId}`);
    expect(rows[2].idempotencyKey).toBe(`granted:${transactionId}`);
    expect(rows[2].planCode).toBe("monthly");

    const entitlement = deriveEntitlement(rows, new Date(2026, 0, 15));
    expect(entitlement).toMatchObject({ status: "ok", planCode: "monthly", accessGranted: true });
  });

  it("replaying the same transaction_id -> one set of events, second reported as duplicate", async () => {
    const txRef = await initiateCheckout(user);
    const transactionId = randomUUID();
    successfulVerify({}, txRef);

    const first = await fulfilCheckout({ userId: user.id, txRef, transactionId, now: new Date(2026, 0, 1) });
    const second = await fulfilCheckout({ userId: user.id, txRef, transactionId, now: new Date(2026, 0, 1) });

    expect(first.outcome).toBe("granted");
    expect(second.outcome).toBe("duplicate");

    const rows = await prisma.paymentEvent.findMany({ where: { userId: user.id } });
    // Still exactly one CHECKOUT_INITIATED, one PAYMENT_VERIFIED, one
    // ENTITLEMENT_GRANTED — the replay added nothing.
    expect(rows).toHaveLength(3);
  });

  it("two grants for monthly -> one continuous period, not two overlapping ones", async () => {
    const anchor = new Date(Date.UTC(2026, 0, 1)); // 1 Jan
    const txRef1 = await initiateCheckout(user);
    successfulVerify({}, txRef1);
    const first = await fulfilCheckout({
      userId: user.id,
      txRef: txRef1,
      transactionId: randomUUID(),
      now: anchor,
    });
    expect(first.outcome).toBe("granted");

    // Eighty minutes later, well inside the first (still open) period —
    // the case from life: paying for monthly twice in one sitting.
    const secondNow = new Date(anchor.getTime() + 80 * 60 * 1000);
    const txRef2 = await initiateCheckout(user);
    successfulVerify({}, txRef2);
    const second = await fulfilCheckout({
      userId: user.id,
      txRef: txRef2,
      transactionId: randomUUID(),
      now: secondNow,
    });

    expect(second.outcome).toBe("granted");
    if (second.outcome !== "granted") throw new Error("unreachable");

    // Continuous, not overlapping: the second period starts exactly where
    // the first ends — not at secondNow, which would silently absorb the
    // second payment into a period that already covered that moment.
    expect(second.periodStart).toEqual(monthlyPeriodEnd(anchor));
    // Two months from the anchor in total, not one month from secondNow.
    expect(second.periodEnd).toEqual(addCalendarMonths(anchor, 2));

    const entitlement = deriveEntitlement(
      await prisma.paymentEvent.findMany({ where: { userId: user.id } }),
      secondNow,
    );
    expect(entitlement).toMatchObject({ status: "ok", planCode: "monthly", accessGranted: true });
  });

  it("anchor case: 31 Jan clamped to 28 Feb, second payment extends to 31 Mar, not 28 Mar", async () => {
    const anchor = new Date(Date.UTC(2026, 0, 31)); // 31 Jan 2026 (2026 is not a leap year)
    const txRef1 = await initiateCheckout(user);
    successfulVerify({}, txRef1);
    const first = await fulfilCheckout({
      userId: user.id,
      txRef: txRef1,
      transactionId: randomUUID(),
      now: anchor,
    });
    expect(first.outcome).toBe("granted");
    if (first.outcome !== "granted") throw new Error("unreachable");
    expect(first.periodEnd).toEqual(new Date(Date.UTC(2026, 1, 28))); // clamped

    // A second payment inside the (clamped) first period.
    const secondNow = new Date(Date.UTC(2026, 1, 10));
    const txRef2 = await initiateCheckout(user);
    successfulVerify({}, txRef2);
    const second = await fulfilCheckout({
      userId: user.id,
      txRef: txRef2,
      transactionId: randomUUID(),
      now: secondNow,
    });

    expect(second.outcome).toBe("granted");
    if (second.outcome !== "granted") throw new Error("unreachable");
    expect(second.periodStart).toEqual(new Date(Date.UTC(2026, 1, 28)));
    // The point of this test: extended from the true anchor (31 Jan, two
    // cycles) rather than chained from the clamped 28 Feb (one cycle),
    // which would land on 28 Mar instead.
    expect(second.periodEnd).toEqual(new Date(Date.UTC(2026, 2, 31)));
  });

  it("a grant after the period has expired -> a fresh period from now, not an extension of a dead one", async () => {
    const anchor = new Date(Date.UTC(2026, 0, 1));
    const txRef1 = await initiateCheckout(user);
    successfulVerify({}, txRef1);
    const first = await fulfilCheckout({
      userId: user.id,
      txRef: txRef1,
      transactionId: randomUUID(),
      now: anchor,
    });
    expect(first.outcome).toBe("granted");

    // Months after the first period (1 Feb) ended, with nothing in
    // between — no renewal to extend, so this must not chain off the
    // long-expired periodEnd.
    const lateNow = new Date(Date.UTC(2026, 5, 1));
    const txRef2 = await initiateCheckout(user);
    successfulVerify({}, txRef2);
    const second = await fulfilCheckout({
      userId: user.id,
      txRef: txRef2,
      transactionId: randomUUID(),
      now: lateNow,
    });

    expect(second.outcome).toBe("granted");
    if (second.outcome !== "granted") throw new Error("unreachable");
    expect(second.periodStart).toEqual(lateNow);
    expect(second.periodEnd).toEqual(monthlyPeriodEnd(lateNow));
  });

  it("amount tampered in the verify response -> rejected, PAYMENT_FAILED written, no entitlement", async () => {
    // Recorded at checkout as 250000 (2500.00); tampered here against
    // *that* value, not Plan's current price — a distinction the next
    // test makes provable by using a recorded amount that differs from
    // Plan's actual seeded price.
    const txRef = await initiateCheckout(user);
    successfulVerify({ amount: "1.00" }, txRef); // far below the recorded 2500.00

    const result = await fulfilCheckout({
      userId: user.id,
      txRef,
      transactionId: randomUUID(),
      now: new Date(2026, 0, 1),
    });

    expect(result.outcome).toBe("rejected");
    const rows = await prisma.paymentEvent.findMany({ where: { userId: user.id } });
    expect(rows.map((r) => r.type)).toEqual(["CHECKOUT_INITIATED", "PAYMENT_FAILED"]);
  });

  it("verifies against the amount and currency recorded at checkout, not Plan's current price", async () => {
    // Deliberately different from the monthly plan's actual seeded price
    // (250000, per the initial migration). If this function ever read
    // Plan again during verification, a verify response reporting exactly
    // this recorded amount would still fail check 3 against 250000 — it
    // must not, because the only thing checked against is what
    // CHECKOUT_INITIATED itself recorded.
    const recordedAmountMinor = 300000;
    const txRef = await initiateCheckout(user, { amountMinor: recordedAmountMinor });
    const transactionId = randomUUID();
    successfulVerify({ amount: "3000.00" }, txRef);

    const result = await fulfilCheckout({ userId: user.id, txRef, transactionId, now: new Date(2026, 0, 1) });

    expect(result.outcome).toBe("granted");
    const verifiedRow = await prisma.paymentEvent.findFirst({
      where: { idempotencyKey: `verified:${transactionId}` },
    });
    expect(verifiedRow?.amountMinor).toBe(recordedAmountMinor);
  });

  it("currency mismatch -> rejected", async () => {
    const txRef = await initiateCheckout(user);
    successfulVerify({ currency: "USD" }, txRef);

    const result = await fulfilCheckout({
      userId: user.id,
      txRef,
      transactionId: randomUUID(),
      now: new Date(2026, 0, 1),
    });

    expect(result.outcome).toBe("rejected");
    const rows = await prisma.paymentEvent.findMany({ where: { userId: user.id } });
    expect(rows.map((r) => r.type)).toEqual(["CHECKOUT_INITIATED", "PAYMENT_FAILED"]);
  });

  it("status=successful claimed in the URL is irrelevant if the verify call itself says otherwise -> rejected", async () => {
    // The trap: nothing in fulfilCheckout ever reads a URL status at all
    // (the return page discards it before this is even called) — this
    // proves rejection follows the *verify response's* status regardless
    // of what anyone might have typed into the query string.
    const txRef = await initiateCheckout(user);
    successfulVerify({ status: "failed" }, txRef);

    const result = await fulfilCheckout({
      userId: user.id,
      txRef,
      transactionId: randomUUID(),
      now: new Date(2026, 0, 1),
    });

    expect(result.outcome).toBe("rejected");
    const rows = await prisma.paymentEvent.findMany({ where: { userId: user.id } });
    expect(rows.map((r) => r.type)).toEqual(["CHECKOUT_INITIATED", "PAYMENT_FAILED"]);
  });

  it("tx_ref belonging to another user -> rejected", async () => {
    const otherUser = await prisma.user.create({
      data: {
        email: `fulfil-test-other-${randomUUID()}@example.test`,
        passwordHash: "not-a-real-hash",
        name: "Other User",
      },
    });
    const txRef = await initiateCheckout(otherUser);
    successfulVerify({}, txRef);

    try {
      // Signed in as `user`, but the tx_ref was initiated by `otherUser`.
      const result = await fulfilCheckout({
        userId: user.id,
        txRef,
        transactionId: randomUUID(),
        now: new Date(2026, 0, 1),
      });

      expect(result.outcome).toBe("rejected");
      const rows = await prisma.paymentEvent.findMany({ where: { txRef } });
      expect(rows.map((r) => r.type)).toEqual(["CHECKOUT_INITIATED", "PAYMENT_FAILED"]);
      // Attributed to the tx_ref's real owner, not the user who tried it.
      expect(rows[1].userId).toBe(otherUser.id);
    } finally {
      await prisma.user.delete({ where: { id: otherUser.id } });
    }
  });

  it("unknown transaction_id -> rejected (verify call fails)", async () => {
    const txRef = await initiateCheckout(user);
    mockVerify.mockResolvedValue({ ok: false, reason: "provider_error" });

    const result = await fulfilCheckout({
      userId: user.id,
      txRef,
      transactionId: "does-not-exist",
      now: new Date(2026, 0, 1),
    });

    expect(result.outcome).toBe("rejected");
    const rows = await prisma.paymentEvent.findMany({ where: { userId: user.id } });
    expect(rows.map((r) => r.type)).toEqual(["CHECKOUT_INITIATED", "PAYMENT_FAILED"]);
  });

  it("unknown tx_ref (no checkout attempt on record) -> rejected, nothing written", async () => {
    const result = await fulfilCheckout({
      userId: user.id,
      txRef: "chk_invented",
      transactionId: randomUUID(),
      now: new Date(2026, 0, 1),
    });

    expect(result.outcome).toBe("rejected");
    expect(mockVerify).not.toHaveBeenCalled();
    const rows = await prisma.paymentEvent.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(0);
  });

  it("pending status -> reports pending, writes nothing", async () => {
    const txRef = await initiateCheckout(user);
    successfulVerify({ status: "pending" }, txRef);

    const result = await fulfilCheckout({
      userId: user.id,
      txRef,
      transactionId: randomUUID(),
      now: new Date(2026, 0, 1),
    });

    expect(result.outcome).toBe("pending");
    const rows = await prisma.paymentEvent.findMany({ where: { userId: user.id } });
    expect(rows.map((r) => r.type)).toEqual(["CHECKOUT_INITIATED"]);
  });
});
