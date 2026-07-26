import { describe, expect, it } from "vitest";
import {
  calculateAdvancePricing,
  calculateCompanyRiskSignal,
  FALLBACK_UPSIDE_SHARE_BPS,
  fallbackCompanyFinancialLookup
} from "../src/domain/pricing.js";
import type { RiskDecision } from "../src/domain/schemas.js";
import { privateMarketFixture, privateRequestFixture } from "./fixtures.js";

const privateRisk: RiskDecision = {
  schemaVersion: "unlockd-bond-risk-v1",
  decision: "approve",
  riskBand: "LOW",
  recommendedAdvanceMinor: 150_000,
  volatilityHaircutBps: 0,
  liquidityHaircutBps: 6000,
  reasonCodes: ["PRIVATE_COMPANY_ILLIQUID"],
  assumptions: []
};

describe("equity pricing", () => {
  it("values vested options from common FMV less strike before applying risk controls", () => {
    const companyRisk = calculateCompanyRiskSignal({
      financials: {
        preferredStock: 300,
        commonStock: 700,
        totalAssets: 10_000,
        sharesOutstanding: 1_000,
        asOfDate: "2025-12-31",
        sourceLabel: "Company filing",
        sourceUrl: null
      },
      dataSource: "coresignal",
      cacheStatus: "hit",
      remainingApiCalls: 99,
      fallbackReason: null
    });
    const result = calculateAdvancePricing(
      privateRequestFixture(),
      privateMarketFixture(),
      privateRisk,
      companyRisk,
      { fixedCapMinor: 200_000 }
    );

    expect(result.quote).toMatchObject({
      referenceSharePriceMinor: 480,
      strikePriceMinor: 120,
      netValuePerOptionMinor: 360,
      grossEquityValueMinor: 7_200_000,
      totalHaircutBps: 0,
      eligibleEquityValueMinor: 7_200_000,
      equityBasedCreditLimitMinor: 5_040_000,
      preferredOverhangRatioBps: 3000,
      poolUpsideShareBps: 3000,
      finalCreditLineMinor: 150_000
    });
  });

  it("uses an explicit conservative upside fallback without changing share price", () => {
    const companyRisk = calculateCompanyRiskSignal(fallbackCompanyFinancialLookup());
    expect(companyRisk.poolUpsideShareBps).toBe(FALLBACK_UPSIDE_SHARE_BPS);
    expect(companyRisk.preferredOverhangRatioBps).toBeNull();
  });

  it("never assigns intrinsic option value below the strike price", () => {
    const request = privateRequestFixture({
      grant: {
        ...privateRequestFixture().grant,
        strikePriceMinor: 600
      }
    });
    const result = calculateAdvancePricing(
      request,
      privateMarketFixture(),
      privateRisk,
      calculateCompanyRiskSignal(fallbackCompanyFinancialLookup()),
      { fixedCapMinor: 200_000 }
    );
    expect(result.quote.netValuePerOptionMinor).toBe(0);
    expect(result.quote.grossEquityValueMinor).toBe(0);
    expect(result.authorization.decision).toBe("REJECTED");
  });
});
