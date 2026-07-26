import { describe, expect, it } from "vitest";
import {
  calculateLiquidationPriceMinor,
  positionMaturity,
  positionTimestampToIso
} from "../src/domain/positions.js";

describe("position calculations", () => {
  it("normalizes Hedera consensus timestamps for position dates", () => {
    expect(positionTimestampToIso("1785042109.123456789")).toBe("2026-07-26T05:01:49.123Z");
    expect(positionMaturity("1785042109.123456789", 14)).toBe("2026-08-09T05:01:49.123Z");
  });

  it("calculates an RSU threshold with conservative cent rounding", () => {
    expect(
      calculateLiquidationPriceMinor(100_00, {
        grantType: "RSU",
        vestedUnits: "10.000000",
        strikePriceMinor: 0
      })
    ).toBe(1_429);
  });

  it("adds the strike price for option collateral", () => {
    expect(
      calculateLiquidationPriceMinor(100_00, {
        grantType: "OPTION",
        vestedUnits: "10.000000",
        strikePriceMinor: 500
      })
    ).toBe(1_929);
  });

  it("moves the threshold down after a partial repayment", () => {
    const grant = {
      grantType: "OPTION" as const,
      vestedUnits: "20.000000",
      strikePriceMinor: 200
    };
    expect(calculateLiquidationPriceMinor(50_00, grant)).toBeLessThan(
      calculateLiquidationPriceMinor(100_00, grant)
    );
  });

  it("uses funding time rather than authorization time for maturity", () => {
    expect(positionMaturity("2026-07-26T12:00:00.000Z", 30)).toBe("2026-08-25T12:00:00.000Z");
  });
});
