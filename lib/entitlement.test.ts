import type { PaymentEvent, PaymentEventType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { addCalendarMonths, monthlyPeriodEnd, yearlyPeriodEnd } from "./period";
import { deriveEntitlement, type Entitlement } from "./entitlement";

// No database: PaymentEvent rows are built by hand. Every field not given
// an override defaults to null/a placeholder, matching what an event type
// that doesn't use that column would actually have stored.
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

function grant(overrides: {
  planCode: string;
  periodStart: Date;
  periodEnd: Date;
  amountMinor?: number;
  providerReference?: string;
}): PaymentEvent {
  return makeEvent({
    type: "ENTITLEMENT_GRANTED",
    planCode: overrides.planCode,
    periodStart: overrides.periodStart,
    periodEnd: overrides.periodEnd,
    amountMinor: overrides.amountMinor ?? 250000,
    currency: "NGN",
    providerReference: overrides.providerReference ?? `ref_${seqCounter + 1}`,
  });
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const jan1 = new Date(Date.UTC(2026, 0, 1));
const jan1PeriodEnd = monthlyPeriodEnd(jan1); // 1 Feb 2026

const jan31 = new Date(Date.UTC(2026, 0, 31));
const jan31PeriodEnd = monthlyPeriodEnd(jan31); // 28 Feb 2026 (clamped, 2026 not leap)

// ---------------------------------------------------------------------------
// The nine required cases, plus explicit inconsistency coverage.
// One row per case; each row's `events` and `now` are independent (a fresh
// `seqCounter`-based id per call, so no row shares state with another).
// ---------------------------------------------------------------------------

interface Case {
  name: string;
  events: PaymentEvent[];
  now: Date;
  expected: Partial<Entitlement>;
}

describe("deriveEntitlement", () => {
  const cases: Case[] = [
    {
      name: "empty log -> free, no access",
      events: [],
      now: jan1,
      expected: {
        status: "ok",
        planCode: "free",
        accessGranted: false,
        periodStart: null,
        periodEnd: null,
      },
    },
    {
      name: "subscribe to monthly -> access, correct period",
      events: [grant({ planCode: "monthly", periodStart: jan1, periodEnd: jan1PeriodEnd })],
      now: new Date(Date.UTC(2026, 0, 15)),
      expected: {
        status: "ok",
        planCode: "monthly",
        accessGranted: true,
        periodStart: jan1,
        periodEnd: jan1PeriodEnd,
      },
    },
    {
      name: "same log, one day after period end -> no access, no event needed to expire it",
      events: [grant({ planCode: "monthly", periodStart: jan1, periodEnd: jan1PeriodEnd })],
      now: new Date(jan1PeriodEnd.getTime() + 24 * 60 * 60 * 1000),
      expected: {
        status: "ok",
        planCode: "monthly", // still on record — only access lapses, per AGENTS.md
        accessGranted: false,
        periodStart: jan1,
        periodEnd: jan1PeriodEnd,
      },
    },
    {
      name: "upgrade monthly to yearly mid-period -> yearly, new period",
      events: (() => {
        const upgradeAt = new Date(Date.UTC(2026, 0, 13)); // day 12 of the 31-day period
        return [
          grant({ planCode: "monthly", periodStart: jan1, periodEnd: jan1PeriodEnd }),
          grant({
            planCode: "yearly",
            periodStart: upgradeAt,
            periodEnd: yearlyPeriodEnd(upgradeAt),
          }),
        ];
      })(),
      now: new Date(Date.UTC(2026, 0, 20)),
      expected: {
        status: "ok",
        planCode: "yearly",
        accessGranted: true,
        periodStart: new Date(Date.UTC(2026, 0, 13)),
        periodEnd: yearlyPeriodEnd(new Date(Date.UTC(2026, 0, 13))),
      },
    },
    {
      name: "downgrade scheduled, before the boundary -> still on the old plan",
      events: [
        grant({ planCode: "yearly", periodStart: jan1, periodEnd: yearlyPeriodEnd(jan1) }),
        makeEvent({ type: "DOWNGRADE_SCHEDULED", planCode: "monthly" }),
      ],
      now: new Date(Date.UTC(2026, 5, 1)), // well before the yearly boundary
      expected: {
        status: "ok",
        planCode: "yearly",
        pendingPlanCode: "monthly",
        accessGranted: true,
      },
    },
    {
      name: "downgrade scheduled, after the boundary -> on the new plan, only `now` changed",
      events: [
        grant({ planCode: "yearly", periodStart: jan1, periodEnd: yearlyPeriodEnd(jan1) }),
        makeEvent({ type: "DOWNGRADE_SCHEDULED", planCode: "monthly" }),
      ],
      now: new Date(yearlyPeriodEnd(jan1).getTime() + 24 * 60 * 60 * 1000),
      expected: {
        status: "ok",
        planCode: "monthly",
        pendingPlanCode: null,
        accessGranted: false, // the boundary that passed is also periodEnd
      },
    },
    {
      name: "cancellation, before period end -> access retained",
      events: [
        grant({ planCode: "monthly", periodStart: jan1, periodEnd: jan1PeriodEnd }),
        makeEvent({ type: "CANCELLATION_REQUESTED" }),
      ],
      now: new Date(Date.UTC(2026, 0, 20)),
      expected: {
        status: "ok",
        planCode: "monthly",
        accessGranted: true,
        cancelAtPeriodEnd: true,
      },
    },
    {
      name: "cancellation, after period end -> no access",
      events: [
        grant({ planCode: "monthly", periodStart: jan1, periodEnd: jan1PeriodEnd }),
        makeEvent({ type: "CANCELLATION_REQUESTED" }),
      ],
      now: new Date(jan1PeriodEnd.getTime() + 24 * 60 * 60 * 1000),
      expected: {
        status: "ok",
        accessGranted: false,
        cancelAtPeriodEnd: true,
      },
    },
    {
      name: "paid twice -> one period, extended, not two subscriptions and not absorbed",
      events: [
        grant({ planCode: "monthly", periodStart: jan1, periodEnd: jan1PeriodEnd }),
        // Second payment before the first period ends. Per AGENTS.md, the
        // write path that produces this event sets its periodStart to the
        // existing periodEnd (not to "now") — that convention is what this
        // fixture simulates.
        grant({
          planCode: "monthly",
          periodStart: jan1PeriodEnd,
          periodEnd: monthlyPeriodEnd(jan1PeriodEnd),
        }),
      ],
      now: new Date(Date.UTC(2026, 0, 20)),
      expected: {
        status: "ok",
        planCode: "monthly",
        periodStart: jan1PeriodEnd,
        periodEnd: monthlyPeriodEnd(jan1PeriodEnd), // 1 Mar — extended, not absorbed
        accessGranted: true,
      },
    },
    {
      name: "duplicate-ignored and failed-payment events present -> no effect",
      events: [
        grant({ planCode: "monthly", periodStart: jan1, periodEnd: jan1PeriodEnd }),
        makeEvent({ type: "WEBHOOK_DUPLICATE_IGNORED", providerReference: "ref_dup" }),
        makeEvent({ type: "PAYMENT_FAILED", txRef: "tx_retry", reason: "insufficient funds" }),
      ],
      now: new Date(Date.UTC(2026, 0, 15)),
      expected: {
        status: "ok",
        planCode: "monthly",
        accessGranted: true,
        periodStart: jan1,
        periodEnd: jan1PeriodEnd,
      },
    },
    {
      name: "pay-twice, anchor 31st clamped to 28 Feb -> extension lands on 31 March, not 28 March",
      events: [
        grant({ planCode: "monthly", periodStart: jan31, periodEnd: jan31PeriodEnd }),
        grant({
          planCode: "monthly",
          periodStart: jan31PeriodEnd, // 28 Feb — the existing period end
          // Anchor-preserving: 2 calendar months from the ORIGINAL 31 Jan
          // anchor, not 1 month chained from the clamped 28 Feb.
          periodEnd: addCalendarMonths(jan31, 2),
        }),
      ],
      now: new Date(Date.UTC(2026, 2, 1)), // 1 March — inside the extended period
      expected: {
        status: "ok",
        planCode: "monthly",
        periodStart: jan31PeriodEnd,
        periodEnd: new Date(Date.UTC(2026, 2, 31)), // 31 March, not 28 March
        accessGranted: true,
      },
    },

    // --- Inconsistency detection: not one of the nine required rows, but
    // "return an explicit state" is itself a requirement, so it needs its
    // own coverage.
    {
      name: "inconsistent: downgrade scheduled with no active plan",
      events: [makeEvent({ type: "DOWNGRADE_SCHEDULED", planCode: "monthly" })],
      now: jan1,
      expected: { status: "inconsistent" },
    },
    {
      name: "inconsistent: cancellation reason with no matching cancellation request",
      events: [
        grant({ planCode: "monthly", periodStart: jan1, periodEnd: jan1PeriodEnd }),
        makeEvent({ type: "CANCELLATION_REASON_PROVIDED", reason: "too expensive" }),
      ],
      now: jan1,
      expected: { status: "inconsistent" },
    },
    {
      name: "inconsistent: ENTITLEMENT_GRANTED missing its period",
      events: [
        makeEvent({
          type: "ENTITLEMENT_GRANTED",
          planCode: "monthly",
          amountMinor: 250000,
          currency: "NGN",
          providerReference: "ref_bad",
          // periodStart/periodEnd omitted
        }),
      ],
      now: jan1,
      expected: { status: "inconsistent" },
    },
  ];

  it.each(cases)("$name", ({ events, now, expected }) => {
    const result = deriveEntitlement(events, now);
    expect(result).toMatchObject(expected);
  });
});
