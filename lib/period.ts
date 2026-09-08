/**
 * Period arithmetic. A monthly period is one calendar month, a yearly
 * period is one calendar year — never a fixed day count. Every function
 * takes `now` (or another reference date) as a parameter; nothing in here
 * calls `new Date()`, so derivation stays a pure function of its inputs and
 * a test can put "now" anywhere it likes, including the day-12-of-31 case.
 *
 * All arithmetic is done in UTC (via the Date UTC getters/setters), not the
 * server's local timezone. Period boundaries are instants stored as
 * `timestamp(3)` columns; deriving "which calendar day is this" from a
 * timezone that could differ between the machine that wrote the row and the
 * one reading it would make the derivation not actually pure.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The end-of-month rule, chosen and rejected alternatives:
 *
 * CHOSEN — anchor-preserving clamp (the rule Stripe and most subscription
 * billers use): `addCalendarMonths(anchor, months)` keeps anchor's
 * day-of-month fixed and re-clamps it against *each target month's own*
 * last day. 31 Jan + 1 month = 28 Feb (2026, not a leap year). Critically,
 * 31 Jan + 2 months = 31 Mar — the "31" survives the trip through February
 * because it is re-applied to March fresh, not carried forward from
 * February's clamped result.
 *
 * REJECTED — chaining from the previous (possibly already-clamped) date:
 * computing 31 Jan + 1 month = 28 Feb, then feeding *that* back in as the
 * next anchor and adding another month, gives 28 Feb + 1 month = 28 Mar.
 * That is the "stuck on the 28th" bug — every renewal after the first
 * short month permanently loses the 31st, 30th, or 29th, even in months
 * that have that day. This is exactly what the anchor-preserving rule
 * avoids, but only if the caller always adds from the true original
 * anchor and a cycle count rather than from the last computed date. A
 * period rollover that instead does
 * `addCalendarMonths(currentPeriodEnd, 1)` on an already-clamped
 * `currentPeriodEnd` reintroduces this bug — the fix lives in what date
 * gets passed in here, not only in this function.
 *
 * REJECTED — 30-day approximation: adding a fixed number of days instead of
 * a calendar month. Rejected outright per AGENTS.md; a monthly period must
 * track the calendar, not an assumed cycle length, or a plan billed on the
 * 31st silently drifts earlier every time it crosses a short month.
 */
export function addCalendarMonths(anchor: Date, months: number): Date {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  const day = anchor.getUTCDate();

  const targetIndex = month + months;
  const targetYear = year + Math.floor(targetIndex / 12);
  const targetMonth = ((targetIndex % 12) + 12) % 12;

  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfTargetMonth);

  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      clampedDay,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

/** One calendar month after `periodStart`. Correct for computing a single
 * period's end from its own start — see `addCalendarMonths` above for the
 * multi-cycle chaining caveat. */
export function monthlyPeriodEnd(periodStart: Date): Date {
  return addCalendarMonths(periodStart, 1);
}

/** One calendar year after `periodStart` (12 calendar months — the same
 * clamp rule applies, e.g. 29 Feb of a leap year + 1 year = 28 Feb). */
export function yearlyPeriodEnd(periodStart: Date): Date {
  return addCalendarMonths(periodStart, 12);
}

/** Whole days spanned by [periodStart, periodEnd). Exact, not approximate,
 * because addCalendarMonths preserves time-of-day, so the millisecond
 * difference is always an exact multiple of a day for periods produced by
 * this module. */
export function daysInPeriod(periodStart: Date, periodEnd: Date): number {
  if (periodEnd.getTime() <= periodStart.getTime()) {
    throw new Error("periodEnd must be after periodStart");
  }
  return Math.round((periodEnd.getTime() - periodStart.getTime()) / MS_PER_DAY);
}

/**
 * Whole days left in [periodStart, periodEnd) as of `now`, clamped to
 * [0, daysInPeriod]. Elapsed time is floored — a partial day already lived
 * in doesn't count as fully used — so remaining time is never
 * under-counted. That bias is deliberate: it is the same "customer's
 * favour" direction AGENTS.md requires of the proration credit itself.
 */
export function daysRemaining(periodStart: Date, periodEnd: Date, now: Date): number {
  const total = daysInPeriod(periodStart, periodEnd);
  const elapsedMs = now.getTime() - periodStart.getTime();
  const elapsedDays = Math.floor(elapsedMs / MS_PER_DAY);
  return Math.max(0, Math.min(total, total - elapsedDays));
}
