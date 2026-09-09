import { randomUUID } from "node:crypto";
import type { Session, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { RATE_LIMITS } from "@/lib/rate-limit";

// The provider call is the one thing this suite never touches for real —
// everything else (session, plan lookup, the log writer, rate limiting)
// runs against the real local database, the same convention as
// lib/paymentLog.test.ts.
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/flutterwave/payments", () => ({ initiatePayment: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { initiatePayment } from "@/lib/flutterwave/payments";
import { POST } from "./route";

const mockGetSession = vi.mocked(getSession);
const mockInitiatePayment = vi.mocked(initiatePayment);

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/checkout", {
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
      email: `checkout-test-${randomUUID()}@example.test`,
      passwordHash: "not-a-real-hash",
      name: "Checkout Test User",
      emailVerifiedAt: new Date(),
    },
  });
  mockGetSession.mockReset();
  mockInitiatePayment.mockReset();
});

afterEach(async () => {
  await prisma.user.delete({ where: { id: user.id } }); // cascades PaymentEvent
  // RateLimitHit has no FK to User, so the cascade above doesn't reach it.
  await prisma.rateLimitHit.deleteMany({ where: { key: `checkout:user:${user.id}` } });
});

describe("POST /api/checkout", () => {
  it("rejects a signed-out request", async () => {
    mockGetSession.mockResolvedValue(null);

    const response = await POST(makeRequest({ planCode: "monthly" }));

    expect(response.status).toBe(401);
    expect(mockInitiatePayment).not.toHaveBeenCalled();
  });

  it("rejects the free plan", async () => {
    signIn();

    const response = await POST(makeRequest({ planCode: "free" }));
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toMatch(/free plan/i);
    expect(mockInitiatePayment).not.toHaveBeenCalled();
  });

  it("rejects an unknown plan code", async () => {
    signIn();

    const response = await POST(makeRequest({ planCode: "does-not-exist" }));

    expect(response.status).toBe(400);
    expect(mockInitiatePayment).not.toHaveBeenCalled();
  });

  it("writes exactly one CHECKOUT_INITIATED row keyed on the tx_ref, on success", async () => {
    signIn();
    mockInitiatePayment.mockResolvedValue({
      ok: true,
      checkoutUrl: "https://checkout.flutterwave.com/pay/abc123",
    });

    const response = await POST(makeRequest({ planCode: "monthly" }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.checkoutUrl).toBe("https://checkout.flutterwave.com/pay/abc123");

    const rows = await prisma.paymentEvent.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("CHECKOUT_INITIATED");
    expect(rows[0].txRef).toBeTruthy();
    expect(rows[0].idempotencyKey).toBe(`checkout:${rows[0].txRef}`);
  });

  it("writes PAYMENT_FAILED and returns a renderable error on a provider failure", async () => {
    signIn();
    mockInitiatePayment.mockResolvedValue({ ok: false, reason: "provider_error" });

    const response = await POST(makeRequest({ planCode: "monthly" }));
    const json = await response.json();

    expect(response.status).toBe(502);
    expect(typeof json.error).toBe("string");
    // The generic message, not Flutterwave's own text or this app's
    // internal reason label leaking into the client-facing body.
    expect(json.error).toBe("We couldn't reach the payment provider. Please try again.");

    const rows = await prisma.paymentEvent.findMany({
      where: { userId: user.id },
      orderBy: { seq: "asc" },
    });
    expect(rows.map((r) => r.type)).toEqual(["CHECKOUT_INITIATED", "PAYMENT_FAILED"]);
    expect(rows[1].reason).toBe("provider_error");
  });

  it("returns 429 with a retry indication once the per-user rate limit is exceeded", async () => {
    signIn();
    mockInitiatePayment.mockResolvedValue({
      ok: true,
      checkoutUrl: "https://checkout.flutterwave.com/pay/xyz",
    });

    const { limit } = RATE_LIMITS.checkout;
    let last: Response | undefined;
    for (let i = 0; i < limit + 1; i++) {
      last = await POST(makeRequest({ planCode: "monthly" }));
    }

    expect(last?.status).toBe(429);
    expect(last?.headers.get("Retry-After")).toBeTruthy();
  });
});
