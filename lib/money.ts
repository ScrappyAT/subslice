/**
 * Money conversion — the single provider boundary named in AGENTS.md.
 *
 * Money is stored as integer minor units everywhere in this app. Flutterwave
 * v3 expects major units on the way in (POST /v3/payments) and returns major
 * units on the way out (the verify response). Every conversion between the
 * two happens here, and only here — never persisted, never re-derived
 * elsewhere.
 *
 * Every function below reaches the major/minor boundary through string
 * slicing, not division. A minor-units integer already carries every digit
 * we need; inserting a decimal point at a fixed offset is a string
 * operation, not arithmetic, and it cannot introduce the rounding surprises
 * that `x / 100` or `.toFixed(2)` can (e.g. amounts that don't round-trip
 * exactly through a float, or a locale's decimal separator leaking in).
 */

/**
 * Number of minor units per major unit, by ISO 4217 currency code. Only
 * currencies this project actually seeds or expects from Flutterwave belong
 * here — this is deliberately not a general-purpose ISO 4217 table, because
 * an entry for a currency this app never handles is untested and unused.
 */
const MINOR_UNITS_EXPONENT: Record<string, number> = {
  NGN: 2, // 100 kobo per naira
};

function exponentFor(currency: string): number {
  const exponent = MINOR_UNITS_EXPONENT[currency];
  if (exponent === undefined) {
    throw new Error(`Unsupported currency: ${currency}`);
  }
  return exponent;
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer, got ${value}`);
  }
}

/** Splits an integer minor-units amount into its whole and fractional digit
 * strings for `currency`, by string slicing alone — no division. */
function splitMinorUnits(
  minor: number,
  currency: string,
): { wholePart: string; fractionalPart: string } {
  assertNonNegativeInteger(minor, "minor");
  const exponent = exponentFor(currency);

  if (exponent === 0) {
    return { wholePart: String(minor), fractionalPart: "" };
  }

  // Pad so there are always more digits than the fractional part needs —
  // the only way "5 kobo" becomes "0.05" rather than losing its leading
  // zero, without ever dividing 5 by 100.
  const digits = String(minor).padStart(exponent + 1, "0");
  const wholePart = digits.slice(0, digits.length - exponent);
  const fractionalPart = digits.slice(digits.length - exponent);
  return { wholePart, fractionalPart };
}

/**
 * The major-unit string Flutterwave v3 expects in the payment-initiation
 * request body, e.g. `toProviderAmount(250000, "NGN") === "2500.00"`.
 * Integer arithmetic and string formatting only, per AGENTS.md — the
 * converted value must never be persisted, only sent.
 */
export function toProviderAmount(minor: number, currency: string): string {
  const { wholePart, fractionalPart } = splitMinorUnits(minor, currency);
  return fractionalPart === "" ? wholePart : `${wholePart}.${fractionalPart}`;
}

/**
 * The inverse: turns the major-unit amount from a verify response back into
 * integer minor units, for comparing against what was expected. Accepts the
 * value as a string deliberately — if the amount arrived as a JSON number,
 * the caller must pass `String(rawAmount)` rather than let this function
 * take a float, since a float has already lost the guarantee that its
 * decimal text is exact.
 *
 * Rejects (rather than rounds) a value with more fractional digits than the
 * currency's minor unit allows — e.g. "25.005" for NGN — since silently
 * rounding a provider's own reported amount is exactly the kind of
 * unnoticed money bug this conversion exists to prevent.
 */
export function fromProviderAmount(major: string, currency: string): number {
  if (!/^\d+(\.\d+)?$/.test(major)) {
    throw new Error(`major must be a non-negative decimal string, got ${JSON.stringify(major)}`);
  }
  const exponent = exponentFor(currency);
  const [wholePart, fractionalPart = ""] = major.split(".");

  if (fractionalPart.length > exponent) {
    throw new Error(
      `${major} has more precision than ${currency} (${exponent} decimal places) supports`,
    );
  }

  const paddedFractional = fractionalPart.padEnd(exponent, "0");
  const combined = `${wholePart}${paddedFractional}`.replace(/^0+(?=\d)/, "");
  const minor = Number(combined);

  if (!Number.isSafeInteger(minor)) {
    throw new Error(`${major} does not convert to a safe integer number of minor units`);
  }
  return minor;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  NGN: "₦",
};

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** What the user sees, e.g. `formatForDisplay(250000, "NGN") === "₦2,500.00"`. */
export function formatForDisplay(minor: number, currency: string): string {
  const { wholePart, fractionalPart } = splitMinorUnits(minor, currency);
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  const grouped = groupThousands(wholePart);
  return fractionalPart === "" ? `${symbol}${grouped}` : `${symbol}${grouped}.${fractionalPart}`;
}
