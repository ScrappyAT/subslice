import { describe, expect, it } from "vitest";
import { addCalendarMonths, daysInPeriod, daysRemaining, monthlyPeriodEnd, yearlyPeriodEnd } from "./period";

const iso = (d: Date) => d.toISOString();

describe("addCalendarMonths — end-of-month handling", () => {
  it("clamps 31 January + 1 month to 28 February in a non-leap year", () => {
    const jan31 = new Date(Date.UTC(2026, 0, 31));
    expect(iso(addCalendarMonths(jan31, 1))).toBe(iso(new Date(Date.UTC(2026, 1, 28))));
  });

  it("clamps 31 January + 1 month to 29 February in a leap year", () => {
    const jan31 = new Date(Date.UTC(2028, 0, 31));
    expect(iso(addCalendarMonths(jan31, 1))).toBe(iso(new Date(Date.UTC(2028, 1, 29))));
  });

  it("the chosen rule: adding from the original anchor recovers the 31st in March", () => {
    // This is the requirement AGENTS.md called out explicitly: the renewal
    // after a clamped short month must not get stuck on the clamped day.
    const jan31 = new Date(Date.UTC(2026, 0, 31));
    expect(iso(addCalendarMonths(jan31, 2))).toBe(iso(new Date(Date.UTC(2026, 2, 31))));
  });

  it("the rejected rule: chaining from the previous (clamped) result gets stuck on the 28th", () => {
    // Documents why callers must not do this — feeding addCalendarMonths'
    // own output back in as the next anchor loses the original day.
    const jan31 = new Date(Date.UTC(2026, 0, 31));
    const feb28 = addCalendarMonths(jan31, 1);
    const chained = addCalendarMonths(feb28, 1);
    expect(iso(chained)).toBe(iso(new Date(Date.UTC(2026, 2, 28)))); // 28 March, not 31
  });

  it("clamps 29 February of a leap year + 1 year to 28 February the next year", () => {
    const feb29 = new Date(Date.UTC(2028, 1, 29));
    expect(iso(addCalendarMonths(feb29, 12))).toBe(iso(new Date(Date.UTC(2029, 1, 28))));
  });

  it("preserves time-of-day across the clamp", () => {
    const jan31 = new Date(Date.UTC(2026, 0, 31, 13, 45, 30));
    expect(iso(addCalendarMonths(jan31, 1))).toBe(iso(new Date(Date.UTC(2026, 1, 28, 13, 45, 30))));
  });

  it("rolls over into the next year", () => {
    const nov15 = new Date(Date.UTC(2026, 10, 15));
    expect(iso(addCalendarMonths(nov15, 3))).toBe(iso(new Date(Date.UTC(2027, 1, 15))));
  });
});

describe("monthlyPeriodEnd / yearlyPeriodEnd", () => {
  it("computes one calendar month from a period start", () => {
    const start = new Date(Date.UTC(2026, 0, 1));
    expect(iso(monthlyPeriodEnd(start))).toBe(iso(new Date(Date.UTC(2026, 1, 1))));
  });

  it("computes one calendar year from a period start", () => {
    const start = new Date(Date.UTC(2026, 0, 1));
    expect(iso(yearlyPeriodEnd(start))).toBe(iso(new Date(Date.UTC(2027, 0, 1))));
  });
});

describe("daysInPeriod / daysRemaining", () => {
  it("counts a full 31-day January period", () => {
    const start = new Date(Date.UTC(2026, 0, 1));
    const end = new Date(Date.UTC(2026, 1, 1));
    expect(daysInPeriod(start, end)).toBe(31);
  });

  it("counts a 28-day February period in a non-leap year", () => {
    const start = new Date(Date.UTC(2026, 1, 1));
    const end = new Date(Date.UTC(2026, 2, 1));
    expect(daysInPeriod(start, end)).toBe(28);
  });

  it("computes days remaining on day 12 of a 31-day period", () => {
    const start = new Date(Date.UTC(2026, 0, 1));
    const end = new Date(Date.UTC(2026, 1, 1));
    const now = new Date(Date.UTC(2026, 0, 13)); // 12 days elapsed
    expect(daysRemaining(start, end, now)).toBe(19);
  });

  it("clamps to zero once now is at or past periodEnd", () => {
    const start = new Date(Date.UTC(2026, 0, 1));
    const end = new Date(Date.UTC(2026, 1, 1));
    expect(daysRemaining(start, end, end)).toBe(0);
    expect(daysRemaining(start, end, new Date(Date.UTC(2026, 5, 1)))).toBe(0);
  });

  it("clamps to daysInPeriod if now is before periodStart", () => {
    const start = new Date(Date.UTC(2026, 0, 1));
    const end = new Date(Date.UTC(2026, 1, 1));
    expect(daysRemaining(start, end, new Date(Date.UTC(2025, 11, 1)))).toBe(31);
  });

  it("rejects a period where end is not after start", () => {
    const d = new Date(Date.UTC(2026, 0, 1));
    expect(() => daysInPeriod(d, d)).toThrow();
  });
});
