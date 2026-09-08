import { daysInPeriod, daysRemaining } from "./period";

export interface ProrateInput {
  /** What the customer actually paid for the current period, in minor units. */
  paidAmountMinor: number;
  periodStart: Date;
  periodEnd: Date;
  now: Date;
  /** The full price of the plan being upgraded to, in minor units. */
  newPlanAmountMinor: number;
}

export interface ProrateResult {
  daysInPeriod: number;
  daysRemaining: number;
  /** Unused value on the current plan, carried over as a credit. Rounds up. */
  creditMinor: number;
  /** What the upgrade actually costs after the credit. Floored at zero. */
  chargeMinor: number;
}

/**
 * Day-accurate proration for a mid-cycle upgrade. Returns the intermediate
 * values, not just the charge — the brief requires the calculation to be
 * shown to the user before they confirm, and PRORATION_QUOTED records
 * exactly this shape so the quote is reconstructable from the log alone.
 *
 * Rounding, per AGENTS.md: the credit rounds up (in the customer's favour),
 * and the resulting charge is floored at zero — it can never go negative,
 * and there is no refund path if the credit exceeds the new plan's price.
 *
 * The credit is computed as ceil(paidAmountMinor * daysRemaining /
 * daysInPeriod). Every quantity here is a small integer (minor-unit prices,
 * day counts), so their product is far inside Number.MAX_SAFE_INTEGER and
 * this division is exact — this is ordinary integer ratio scaling, not the
 * major/minor decimal-string conversion at the Flutterwave boundary, which
 * is the one place AGENTS.md rules out `/` and `.toFixed` specifically to
 * avoid decimal-string surprises.
 */
export function prorate(input: ProrateInput): ProrateResult {
  const { paidAmountMinor, periodStart, periodEnd, now, newPlanAmountMinor } = input;

  if (!Number.isInteger(paidAmountMinor) || paidAmountMinor < 0) {
    throw new Error(`paidAmountMinor must be a non-negative integer, got ${paidAmountMinor}`);
  }
  if (!Number.isInteger(newPlanAmountMinor) || newPlanAmountMinor < 0) {
    throw new Error(`newPlanAmountMinor must be a non-negative integer, got ${newPlanAmountMinor}`);
  }

  const total = daysInPeriod(periodStart, periodEnd);
  const remaining = daysRemaining(periodStart, periodEnd, now);

  const creditMinor = Math.ceil((paidAmountMinor * remaining) / total);
  const chargeMinor = Math.max(0, newPlanAmountMinor - creditMinor);

  return {
    daysInPeriod: total,
    daysRemaining: remaining,
    creditMinor,
    chargeMinor,
  };
}
