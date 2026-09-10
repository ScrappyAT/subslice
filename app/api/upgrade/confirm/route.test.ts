import { randomUUID } from "node:crypto";
import type { Session, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { appendPaymentEvent } from "@/lib/paymentLog";
import { monthlyPeriodEnd } from "@/lib/period";
import { quoteUpgrade } from "@/lib/upgradeQuote";

// Only the provider call is stubbed — session, the seeded monthly grant,
// the quote, and the route's own recomputation all run for real, matching
// app/api/checkout/route.test.ts's convention.
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/flutterwave/payments", () => ({ initiatePayment: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { initiatePayment } from "@/lib/flutterwave/payments";
import { POST } from "./route";

const mockGetSession = vi.mocked(getSession);
const mockInitiatePayment = vi.mocked(initiatePayment);

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/upgrade/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

let user: User;

function signIn() {
  const session: Session & { user: User } = {
    id: `sess_${randomUUID()}`,
    tokenHash: "irrelevant-not-read-by-the-route",
    userId: user.id,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    user,
  };
  mockGetSession.mockResolvedValue(session);
}

beforeEach(async () => {
  user = await prisma.user.create({
    data: {
      email: `upgrade-confirm-test-${randomUUID()}@example.test`,
      passwordHash: "not-a-real-hash",
      name: "Upgrade Confirm Test User",
      emailVerifiedAt: new Date(),
    },
  });
  mockGetSession.mockReset();
  mockInitiatePayment.mockReset();
  mockInitiatePayment.mockResolvedValue({
    ok: true,
    checkoutUrl: "https://checkout.flutterwave.com/pay/upgrade",
  });
});

afterEach(async () => {
  await prisma.user.delete({ where: { id: user.id } });
});

describe("POST /api/upgrade/confirm", () => {
  it("a client-submitted charge amount is ignored — the recomputed amount is what gets charged", async () => {
    // periodStart anchored a few days before "real now", so the route's
    // own new Date() and this test's quote both land inside the same
    // still-open period and (being the same test, run within
    // milliseconds) the same calendar day — no day boundary can pass
    // between the quote and the confirm below.
    const periodStart = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const periodEnd = monthlyPeriodEnd(periodStart);
    await appendPaymentEvent({
      type: "ENTITLEMENT_GRANTED",
      userId: user.id,
      idempotencyKey: `granted:seed-${randomUUID()}`,
      providerReference: `seed-${randomUUID()}`,
      planCode: "monthly",
      periodStart,
      periodEnd,
      amountMinor: 250000,
      currency: "NGN",
    });

    const quote = await quoteUpgrade({ userId: user.id, now: new Date() });
    if (quote.outcome !== "quoted") throw new Error("test setup failed");

    signIn();
    // A client submitting its own amount alongside the real field.
    // confirmUpgradeSchema only ever parses txRef out of this body.
    const response = await POST(
      makeRequest({ txRef: quote.txRef, amountMinor: 1, chargeMinor: 1 }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.checkoutUrl).toBeTruthy();
    expect(mockInitiatePayment).toHaveBeenCalledWith(
      expect.objectContaining({ amountMinor: quote.chargeMinor, currency: "NGN" }),
    );
    expect(mockInitiatePayment).not.toHaveBeenCalledWith(expect.objectContaining({ amountMinor: 1 }));

    const checkoutRow = await prisma.paymentEvent.findFirst({
      where: { idempotencyKey: `checkout:${quote.txRef}` },
    });
    expect(checkoutRow?.amountMinor).toBe(quote.chargeMinor);
  });
});
