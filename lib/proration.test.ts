import { describe, expect, it } from "vitest";
import { prorate } from "./proration";

describe("prorate — day 12 of a 31-day monthly period, upgrading to yearly", () => {
  // The seeded prices from the initial migration: monthly = 250000 minor
  // units (₦2,500.00), yearly = 2500000 minor units (₦25,000.00).
  const periodStart = new Date(Date.UTC(2026, 0, 1)); // 1 January
  const periodEnd = new Date(Date.UTC(2026, 1, 1)); // 1 February — 31-day period
  const now = new Date(Date.UTC(2026, 0, 13)); // 13 January — 12 days elapsed

  it("reports 31 days in the period and 19 remaining", () => {
    const result = prorate({
      paidAmountMinor: 250000,
      periodStart,
      periodEnd,
      now,
      newPlanAmountMinor: 2500000,
    });
    expect(result.daysInPeriod).toBe(31);
    expect(result.daysRemaining).toBe(19);
  });

  it("credits ceil(250000 * 19 / 31) = 153226 minor units", () => {
    const result = prorate({
      paidAmountMinor: 250000,
      periodStart,
      periodEnd,
      now,
      newPlanAmountMinor: 2500000,
    });
    expect(result.creditMinor).toBe(153226);
  });

  it("charges 2500000 - 153226 = 2346774 minor units", () => {
    const result = prorate({
      paidAmountMinor: 250000,
      periodStart,
      periodEnd,
      now,
      newPlanAmountMinor: 2500000,
    });
    expect(result.chargeMinor).toBe(2346774);
  });
});

describe("prorate — edge cases", () => {
  it("floors the charge at zero when the credit exceeds the new plan's price", () => {
    const periodStart = new Date(Date.UTC(2026, 0, 1));
    const periodEnd = new Date(Date.UTC(2026, 1, 1));
    const now = periodStart; // no time elapsed: full credit
    const result = prorate({
      paidAmountMinor: 2500000,
      periodStart,
      periodEnd,
      now,
      newPlanAmountMinor: 250000, // cheaper plan than what was already paid
    });
    expect(result.creditMinor).toBeGreaterThan(250000);
    expect(result.chargeMinor).toBe(0);
  });

  it("credits nothing once the period has already ended", () => {
    const periodStart = new Date(Date.UTC(2026, 0, 1));
    const periodEnd = new Date(Date.UTC(2026, 1, 1));
    const result = prorate({
      paidAmountMinor: 250000,
      periodStart,
      periodEnd,
      now: periodEnd,
      newPlanAmountMinor: 2500000,
    });
    expect(result.creditMinor).toBe(0);
    expect(result.chargeMinor).toBe(2500000);
  });

  it("rejects a negative amount", () => {
    const periodStart = new Date(Date.UTC(2026, 0, 1));
    const periodEnd = new Date(Date.UTC(2026, 1, 1));
    expect(() =>
      prorate({
        paidAmountMinor: -1,
        periodStart,
        periodEnd,
        now: periodStart,
        newPlanAmountMinor: 250000,
      }),
    ).toThrow();
  });
});
