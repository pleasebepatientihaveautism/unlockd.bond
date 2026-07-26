import { describe, expect, it } from "vitest";
import {
  STABLE_TOKEN_DECIMALS,
  STABLE_UNITS_PER_USD_MINOR,
  usdMinorToStableUnits
} from "../src/server/adapters/types.js";

describe("Hedera stable funding units", () => {
  it("maps USD cents exactly to six-decimal Demo USDC units", () => {
    expect(STABLE_TOKEN_DECIMALS).toBe(6);
    expect(STABLE_UNITS_PER_USD_MINOR).toBe(10_000n);
    expect(usdMinorToStableUnits(1)).toBe(10_000n);
    expect(usdMinorToStableUnits(1_000)).toBe(10_000_000n);
    expect(usdMinorToStableUnits(150_000)).toBe(1_500_000_000n);
  });

  it("rejects non-positive, fractional, and unsafe minor-unit inputs", () => {
    expect(() => usdMinorToStableUnits(0)).toThrow("STABLE_AMOUNT_INVALID");
    expect(() => usdMinorToStableUnits(-1)).toThrow("STABLE_AMOUNT_INVALID");
    expect(() => usdMinorToStableUnits(1.5)).toThrow("STABLE_AMOUNT_INVALID");
    expect(() => usdMinorToStableUnits(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      "STABLE_AMOUNT_INVALID"
    );
  });
});
