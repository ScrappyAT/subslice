import { randomUUID } from "node:crypto";
import type { User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { appendPaymentEvent } from "@/lib/paymentLog";

// A fixed, known value rather than whatever's actually in .env — this
// keeps the test deterministic and never depends on (or needs to read) a
// real secret. Only verifyTransaction and the secret accessors are
// stubbed; the checkout event, the log writer, and fulfilCheckout's own
// verification/fulfilment logic all run for real, the same convention as
// the other suites.
const TEST_SECRET_HASH = "test-secret-hash-value";

vi.mock("@/lib/flutterwave/config", () => ({
  getFlutterwaveSecretHash: () => TEST_SECRET_HASH,
  getFlutterwaveSecretKey: () => "unused-in-these-tests",
  FLW_BASE_URL: "https://api.flutterwave.com/v3",
}));
vi.mock("@/lib/flutterwave/verify", () => ({ verifyTransaction: vi.fn() }));

import { verifyTransaction } from "@/lib/flutterwave/verify";
import { fulfilCheckout } from "@/lib/fulfilCheckout";
import { POST } from "./route";

const mockVerify = vi.mocked(verifyTransaction);

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/webhooks/flutterwave", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function webhookBody(overrides: { id?: string | number; tx_ref?: string } = {}) {
  // A realistic shape (mirrors the verify response's own data object) —
  // amount/currency/status are included because a real webhook would send
  // them, not because this route ever reads them from here.
  return {
    event: "charge.completed",
    data: {
      id: overrides.id ?? 100000,
      tx_ref: overrides.tx_ref ?? "chk_unknown",
      amount: 2500,
      currency: "NGN",
      status: "successful",
    },
  };
}

let user: User;

async function initiateCheckout(forUser: User): Promise<string> {
  const txRef = `chk_${randomUUID()}`;
  const result = await appendPaymentEvent({
    type: "CHECKOUT_INITIATED",
    userId: forUser.id,
    idempotencyKey: `checkout:${txRef}`,
    txRef,
    planCode: "monthly",
    amountMinor: 250000,
    currency: "NGN",
  });
  if (result.outcome !== "inserted") throw new Error("test setup failed");
  return txRef;
}

function successfulVerify(
  txRef: string,
  overrides: Partial<{ status: string; amount: string; currency: string }> = {},
) {
  mockVerify.mockResolvedValue({
    ok: true,
    data: {
      status: overrides.status ?? "successful",
      txRef,
      amount: overrides.amount ?? "2500.00",
      currency: overrides.currency ?? "NGN",
    },
    raw: { status: "success", data: {} },
  });
}

beforeEach(async () => {
  user = await prisma.user.create({
    data: {
      email: `webhook-test-${randomUUID()}@example.test`,
      passwordHash: "not-a-real-hash",
      name: "Webhook Test User",
    },
  });
  mockVerify.mockReset();
});

afterEach(async () => {
  await prisma.user.delete({ where: { id: user.id } }); // cascades PaymentEvent
});

describe("POST /api/webhooks/flutterwave", () => {
  it("missing verif-hash header -> 401, no rows written", async () => {
    const txRef = await initiateCheckout(user);

    const response = await POST(makeRequest(webhookBody({ tx_ref: txRef })));

    expect(response.status).toBe(401);
    const rows = await prisma.paymentEvent.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1); // only the CHECKOUT_INITIATED from setup
  });

  it("wrong verif-hash -> 401, no rows written", async () => {
    const txRef = await initiateCheckout(user);

    const response = await POST(
      makeRequest(webhookBody({ tx_ref: txRef }), { "verif-hash": "not-the-secret" }),
    );

    expect(response.status).toBe(401);
    const rows = await prisma.paymentEvent.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
  });

  it("correct header, unknown transaction id/tx_ref -> 200, no rows written", async () => {
    const response = await POST(
      makeRequest(webhookBody({ tx_ref: "chk_invented" }), { "verif-hash": TEST_SECRET_HASH }),
    );

    expect(response.status).toBe(200);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("correct header, valid first delivery -> WEBHOOK_RECEIVED, then verification and fulfilment events", async () => {
    const txRef = await initiateCheckout(user);
    const transactionId = 500001;
    successfulVerify(txRef);

    const response = await POST(
      makeRequest(webhookBody({ id: transactionId, tx_ref: txRef }), { "verif-hash": TEST_SECRET_HASH }),
    );

    expect(response.status).toBe(200);
    const rows = await prisma.paymentEvent.findMany({
      where: { userId: user.id },
      orderBy: { seq: "asc" },
    });
    expect(rows.map((r) => r.type)).toEqual([
      "CHECKOUT_INITIATED",
      "WEBHOOK_RECEIVED",
      "PAYMENT_VERIFIED",
      "ENTITLEMENT_GRANTED",
    ]);
    expect(rows[1].idempotencyKey).toBe(`webhook:${transactionId}`);
  });

  it("same webhook fired twice -> one WEBHOOK_RECEIVED, one WEBHOOK_DUPLICATE_IGNORED, exactly one ENTITLEMENT_GRANTED", async () => {
    const txRef = await initiateCheckout(user);
    const transactionId = 500002;
    successfulVerify(txRef);
    const body = webhookBody({ id: transactionId, tx_ref: txRef });

    const first = await POST(makeRequest(body, { "verif-hash": TEST_SECRET_HASH }));
    const second = await POST(makeRequest(body, { "verif-hash": TEST_SECRET_HASH }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const rows = await prisma.paymentEvent.findMany({ where: { userId: user.id } });
    expect(rows.filter((r) => r.type === "WEBHOOK_RECEIVED")).toHaveLength(1);
    expect(rows.filter((r) => r.type === "WEBHOOK_DUPLICATE_IGNORED")).toHaveLength(1);
    expect(rows.filter((r) => r.type === "ENTITLEMENT_GRANTED")).toHaveLength(1);
  });

  it("same webhook fired a third time -> a second WEBHOOK_DUPLICATE_IGNORED row, key composition does not collide", async () => {
    const txRef = await initiateCheckout(user);
    const transactionId = 500003;
    successfulVerify(txRef);
    const body = webhookBody({ id: transactionId, tx_ref: txRef });

    await POST(makeRequest(body, { "verif-hash": TEST_SECRET_HASH }));
    await POST(makeRequest(body, { "verif-hash": TEST_SECRET_HASH }));
    const third = await POST(makeRequest(body, { "verif-hash": TEST_SECRET_HASH }));

    expect(third.status).toBe(200);
    const dupRows = await prisma.paymentEvent.findMany({
      where: { userId: user.id, type: "WEBHOOK_DUPLICATE_IGNORED" },
    });
    expect(dupRows).toHaveLength(2);
    // Distinct idempotencyKeys — the receivedAt-ms suffix is what stops
    // the third delivery colliding with the second's key.
    expect(new Set(dupRows.map((r) => r.idempotencyKey)).size).toBe(2);
  });

  it("a webhook arriving after the return view already fulfilled the same transaction -> duplicate, no second grant", async () => {
    const txRef = await initiateCheckout(user);
    const transactionId = 500004;
    successfulVerify(txRef);

    // The return view got there first.
    const preResult = await fulfilCheckout({
      userId: user.id,
      txRef,
      transactionId: String(transactionId),
      now: new Date(),
    });
    expect(preResult.outcome).toBe("granted");

    const response = await POST(
      makeRequest(webhookBody({ id: transactionId, tx_ref: txRef }), { "verif-hash": TEST_SECRET_HASH }),
    );

    expect(response.status).toBe(200);
    const rows = await prisma.paymentEvent.findMany({ where: { userId: user.id } });
    // The webhook is still its own first delivery (recorded once), but
    // fulfilCheckout's own PAYMENT_VERIFIED/ENTITLEMENT_GRANTED writes
    // collide with what the return view already wrote — no second grant.
    expect(rows.filter((r) => r.type === "WEBHOOK_RECEIVED")).toHaveLength(1);
    expect(rows.filter((r) => r.type === "ENTITLEMENT_GRANTED")).toHaveLength(1);
  });

  it("a tampered body claiming a different amount has no effect -- amount is read from the verify call, not the body", async () => {
    const txRef = await initiateCheckout(user);
    const transactionId = 500005;
    // The authenticated verify call reports the correct, recorded amount...
    successfulVerify(txRef, { amount: "2500.00" });
    // ...while the webhook body itself claims something else entirely.
    const tamperedBody = {
      event: "charge.completed",
      data: { id: transactionId, tx_ref: txRef, amount: 1, currency: "NGN", status: "successful" },
    };

    const response = await POST(makeRequest(tamperedBody, { "verif-hash": TEST_SECRET_HASH }));

    expect(response.status).toBe(200);
    const granted = await prisma.paymentEvent.findFirst({
      where: { userId: user.id, type: "ENTITLEMENT_GRANTED" },
    });
    expect(granted?.amountMinor).toBe(250000); // the verified amount, not the tampered 1
  });
});
