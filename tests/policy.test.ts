import { describe, expect, it } from "vitest";
import { authorizeAdvance, decimalToMicrounits, PolicyError } from "../src/domain/policy.js";
import type { RiskDecision } from "../src/domain/schemas.js";
import {
  marketFixture,
  privateMarketFixture,
  privateRequestFixture,
  requestFixture
} from "./fixtures.js";

const risk: RiskDecision = {
  schemaVersion: "unlockd-bond-risk-v1",
  decision: "approve",
  riskBand: "MEDIUM",
  recommendedAdvanceMinor: 140_000,
  volatilityHaircutBps: 1400,
  liquidityHaircutBps: 700,
  reasonCodes: ["TENURE_STABLE", "VESTED_VALUE_SUFFICIENT"],
  assumptions: []
};

describe("deterministic policy", () => {
  it("parses decimal quantities without floating point", () => {
    expect(decimalToMicrounits("125.000001")).toBe(125_000_001n);
  });

  it("caps the model recommendation by requested amount and policy limits", () => {
    const result = authorizeAdvance(requestFixture(), marketFixture(), risk, {
      fixedCapMinor: 200_000,
      maxGraphAgeSeconds: 180,
      minGraphSamples: 2
    });
    expect(result.decision).toBe("AUTHORIZED");
    expect(result.amountMinor).toBeLessThanOrEqual(140_000);
    expect(result.amountMinor).toBeLessThanOrEqual(result.policyMaxMinor);
    expect(result.marketHaircutBps).toBe(0);
  });

  it("fails closed on stale Graph evidence", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(() =>
      authorizeAdvance(
        requestFixture(),
        marketFixture({ priceUpdatedAt: now - 181 }),
        risk,
        { fixedCapMinor: 200_000, maxGraphAgeSeconds: 180, minGraphSamples: 2 },
        now
      )
    ).toThrowError(new PolicyError("GRAPH_DATA_STALE", "Market evidence is stale"));
  });

  it("fails closed when the oracle is paused", () => {
    expect(() =>
      authorizeAdvance(requestFixture(), marketFixture({ oraclePaused: true }), risk, {
        fixedCapMinor: 200_000,
        maxGraphAgeSeconds: 180,
        minGraphSamples: 2
      })
    ).toThrowError("Market oracle is paused");
  });

  it("caps private options at 70% of vested intrinsic equity value", () => {
    const privateRisk: RiskDecision = {
      ...risk,
      recommendedAdvanceMinor: 150_000,
      volatilityHaircutBps: 0,
      liquidityHaircutBps: 6000,
      reasonCodes: ["PRIVATE_COMPANY_ILLIQUID"]
    };
    const result = authorizeAdvance(privateRequestFixture(), privateMarketFixture(), privateRisk, {
      fixedCapMinor: 200_000,
      maxGraphAgeSeconds: 180,
      minGraphSamples: 2
    });
    expect(result.decision).toBe("AUTHORIZED");
    expect(result.eligibleEquityValueMinor).toBe(7_200_000);
    expect(result.policyMaxMinor).toBe(5_040_000);
    expect(result.marketHaircutBps).toBe(0);
    expect(result.amountMinor).toBe(150_000);
  });

  it("fails closed when private-company valuation evidence is over one year old", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(() =>
      authorizeAdvance(
        privateRequestFixture(),
        privateMarketFixture({
          priceUpdatedAt: now - 366 * 24 * 60 * 60,
          indexedBlockTimestamp: now - 366 * 24 * 60 * 60
        }),
        { ...risk, volatilityHaircutBps: 0, liquidityHaircutBps: 6000 },
        { fixedCapMinor: 200_000, maxGraphAgeSeconds: 180, minGraphSamples: 2 },
        now
      )
    ).toThrowError(new PolicyError("PRIVATE_VALUATION_STALE", "Market evidence is stale"));
  });

  it("does not authorize a rejected model decision", () => {
    const result = authorizeAdvance(
      requestFixture(),
      marketFixture(),
      { ...risk, decision: "reject", recommendedAdvanceMinor: 0 },
      { fixedCapMinor: 200_000, maxGraphAgeSeconds: 180, minGraphSamples: 2 }
    );
    expect(result).toMatchObject({ decision: "REJECTED", amountMinor: 0 });
  });
});
