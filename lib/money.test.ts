import { describe, expect, it } from "vitest";
import { formatForDisplay, fromProviderAmount, toProviderAmount } from "./money";

describe("toProviderAmount", () => {
  it("formats whole naira with two decimal places", () => {
    expect(toProviderAmount(250000, "NGN")).toBe("2500.00");
  });

  it("formats zero", () => {
    expect(toProviderAmount(0, "NGN")).toBe("0.00");
  });

  it("keeps a leading zero for amounts under one naira", () => {
    expect(toProviderAmount(5, "NGN")).toBe("0.05");
    expect(toProviderAmount(99, "NGN")).toBe("0.99");
  });

  it("does not add a spurious leading zero to a multi-digit whole part", () => {
    expect(toProviderAmount(1050, "NGN")).toBe("10.50");
  });

  it("rejects a negative or non-integer amount", () => {
    expect(() => toProviderAmount(-1, "NGN")).toThrow();
    expect(() => toProviderAmount(1.5, "NGN")).toThrow();
  });

  it("rejects an unsupported currency", () => {
    expect(() => toProviderAmount(100, "USD")).toThrow();
  });
});

describe("fromProviderAmount", () => {
  it("parses a decimal major-unit string back to minor units", () => {
    expect(fromProviderAmount("2500.00", "NGN")).toBe(250000);
  });

  it("parses a value with no decimal point", () => {
    expect(fromProviderAmount("2500", "NGN")).toBe(250000);
  });

  it("pads a short fractional part", () => {
    expect(fromProviderAmount("25.5", "NGN")).toBe(2550);
  });

  it("rejects more precision than the currency supports", () => {
    expect(() => fromProviderAmount("25.005", "NGN")).toThrow();
  });

  it("rejects a negative or malformed string", () => {
    expect(() => fromProviderAmount("-1.00", "NGN")).toThrow();
    expect(() => fromProviderAmount("1e3", "NGN")).toThrow();
    expect(() => fromProviderAmount("", "NGN")).toThrow();
  });
});

describe("conversion round-trip", () => {
  it("returns the original minor-unit amount for a range of values", () => {
    const amounts = [0, 1, 5, 50, 99, 100, 101, 250000, 2500000, 999999, 1000000];
    for (const minor of amounts) {
      const major = toProviderAmount(minor, "NGN");
      expect(fromProviderAmount(major, "NGN")).toBe(minor);
    }
  });
});

describe("formatForDisplay", () => {
  it("groups thousands and prefixes the currency symbol", () => {
    expect(formatForDisplay(250000, "NGN")).toBe("₦2,500.00");
    expect(formatForDisplay(2500000, "NGN")).toBe("₦25,000.00");
  });

  it("formats a small amount without a spurious comma", () => {
    expect(formatForDisplay(5, "NGN")).toBe("₦0.05");
  });

  it("rejects an unsupported currency the same way toProviderAmount does", () => {
    expect(() => formatForDisplay(100, "USD")).toThrow();
  });
});
