import { randomUUID } from "node:crypto";
import type { User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./prisma";
import { appendPaymentEvent } from "./paymentLog";
import { yearlyPeriodEnd } from "./period";
import { refreshSubscriptionProjection } from "./subscriptionProjection";

// Only the two Flutterwave network calls are stubbed — everything else
// (the seeded monthly grant, the quote, the confirm, fulfilCheckout, the
// projection) runs for real against the local database, matching every
// other suite's convention.
vi.mock("./flutterwave/verify", () => ({ verifyTransaction: vi.fn() }));
vi.mock("./flutterwave/payments", () => ({ initiatePayment: vi.fn() }));

import { verifyTransaction } from "./flutterwave/verify";
import { initiatePayment } from "./flutterwave/payments";
import { quoteUpgrade } from "./upgradeQuote";
import { confirmUpgrade } from "./upgradeConfirm";
import { fulfilCheckout } from "./fulfilCheckout";

const mockVerify = vi.mocked(verifyTransaction);
const mockInitiatePayment = vi.mocked(initiatePayment);

let user: User;

// The seeded monthly plan's real price (see the initial migration).
const MONTHLY_PAID = 250000;

const periodStart = new Date(Date.UTC(2026, 0, 1)); // 1 Jan
const periodEnd = new Date(Date.UTC(2026, 1, 1)); // 1 Feb — a 31-day period
const day12Now = new Date(Date.UTC(2026, 0, 13)); // 13 Jan — 12 days elapsed

async function subscribeMonthly(forUser: User): Promise<void> {
  const result = await appendPaymentEvent({
    type: "ENTITLEMENT_GRANTED",
    userId: forUser.id,
    idempotencyKey: `granted:seed-${randomUUID()}`,
    providerReference: `seed-${randomUUID()}`,
    planCode: "monthly",
    periodStart,
    periodEnd,
    amountMinor: MONTHLY_PAID,
    currency: "NGN",
  });
  if (result.outcome !== "inserted") throw new Error("test setup failed");
}

beforeEach(async () => {
  user = await prisma.user.create({
    data: {
      email: `upgrade-test-${randomUUID()}@example.test`,
      passwordHash: "not-a-real-hash",
      name: "Upgrade Test User",
    },
  });
  mockVerify.mockReset();
  mockInitiatePayment.mockReset();
  mockInitiatePayment.mockResolvedValue({
    ok: true,
    checkoutUrl: "https://checkout.flutterwave.com/pay/upgrade",
  });
});

afterEach(async () => {
  await prisma.user.delete({ where: { id: user.id } }); // cascades PaymentEvent, Subscription
});

describe("quoteUpgrade", () => {
  it("day 12 of a 31-day monthly period: 19 days remaining, credit 153226, charge 2346774", async () => {
    await subscribeMonthly(user);

    const result = await quoteUpgrade({ userId: user.id, now: day12Now });

    expect(result.outcome).toBe("quoted");
    if (result.outcome !== "quoted") throw new Error("unreachable");
    expect(result.daysInPeriod).toBe(31);
    expect(result.daysRemaining).toBe(19);
    expect(result.creditMinor).toBe(153226);
    expect(result.chargeMinor).toBe(2346774);
  });

  it("the quote event records the same numbers the user was shown", async () => {
    await subscribeMonthly(user);

    const result = await quoteUpgrade({ userId: user.id, now: day12Now });
    if (result.outcome !== "quoted") throw new Error("unreachable");

    const quoteRow = await prisma.paymentEvent.findFirst({
      where: { idempotencyKey: `quote:${result.txRef}` },
    });
    expect(quoteRow).toMatchObject({
      type: "PRORATION_QUOTED",
      planCode: "yearly",
      amountMinor: 2346774,
      creditAppliedMinor: 153226,
      currency: "NGN",
    });
  });

  it("already on yearly -> rejected", async () => {
    await appendPaymentEvent({
      type: "ENTITLEMENT_GRANTED",
      userId: user.id,
      idempotencyKey: `granted:seed-yearly-${randomUUID()}`,
      providerReference: `seed-yearly-${randomUUID()}`,
      planCode: "yearly",
      periodStart,
      periodEnd: yearlyPeriodEnd(periodStart),
      amountMinor: 2500000,
      currency: "NGN",
    });

    const result = await quoteUpgrade({ userId: user.id, now: day12Now });

    expect(result.outcome).toBe("already_yearly");
  });
});

describe("confirmUpgrade + fulfilCheckout: the full upgrade", () => {
  it("fulfilment sets plan yearly, a one-year period from now, creditAppliedMinor 153226, and the projection updates to match", async () => {
    await subscribeMonthly(user);

    // Before: the projection reflects the monthly subscribe. subscribeMonthly
    // seeds the grant directly (not through fulfilCheckout), so the
    // projection is refreshed the same way step 9 requires — after any
    // event append that could change entitlement.
    await refreshSubscriptionProjection(user.id, day12Now);
    const before = await prisma.subscription.findUnique({ where: { userId: user.id } });
    expect(before).toMatchObject({ planCode: "monthly", status: "ACTIVE" });
    expect(before?.currentPeriodStart).toEqual(periodStart);
    expect(before?.currentPeriodEnd).toEqual(periodEnd);

    const quote = await quoteUpgrade({ userId: user.id, now: day12Now });
    if (quote.outcome !== "quoted") throw new Error("unreachable");

    // Confirmed immediately — same instant as the quote, so no day
    // boundary can have passed between them.
    const confirmNow = day12Now;
    const confirmed = await confirmUpgrade({
      userId: user.id,
      txRef: quote.txRef,
      now: confirmNow,
      customerEmail: "upgrade-test@example.test",
      customerName: "Upgrade Test User",
      redirectUrl: "http://localhost:3000/checkout/return",
    });
    expect(confirmed.outcome).toBe("initiated");
    expect(mockInitiatePayment).toHaveBeenCalledWith(
      expect.objectContaining({ amountMinor: 2346774, currency: "NGN" }),
    );

    // The return view (or webhook) verifying and fulfilling the charge.
    const transactionId = randomUUID();
    mockVerify.mockResolvedValue({
      ok: true,
      data: { status: "successful", txRef: quote.txRef, amount: "23467.74", currency: "NGN" },
      raw: { status: "success", data: {} },
    });

    const fulfilled = await fulfilCheckout({
      userId: user.id,
      txRef: quote.txRef,
      transactionId,
      now: confirmNow,
    });
    expect(fulfilled.outcome).toBe("granted");

    const grant = await prisma.paymentEvent.findFirst({
      where: { idempotencyKey: `granted:${transactionId}` },
    });
    expect(grant).toMatchObject({
      planCode: "yearly",
      amountMinor: 2346774,
      creditAppliedMinor: 153226,
      currency: "NGN",
    });
    // The new period starts now, not at the old monthly period's end — the
    // old period is superseded, not extended (see the comment in
    // lib/fulfilCheckout.ts for why this differs from paying twice).
    expect(grant?.periodStart).toEqual(confirmNow);
    expect(grant?.periodEnd).toEqual(yearlyPeriodEnd(confirmNow));

    // After: the projection shows yearly and the moved period end.
    const after = await prisma.subscription.findUnique({ where: { userId: user.id } });
    expect(after).toMatchObject({ planCode: "yearly", status: "ACTIVE" });
    expect(after?.currentPeriodStart).toEqual(confirmNow);
    expect(after?.currentPeriodEnd).toEqual(yearlyPeriodEnd(confirmNow));
  });
});
