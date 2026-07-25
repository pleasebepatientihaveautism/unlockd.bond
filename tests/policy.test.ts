import { describe, expect, it } from "vitest";
import { authorizeAdvance, decimalToMicrounits, PolicyError } from "../src/domain/policy.js";
import type { RiskDecision } from "../src/domain/schemas.js";
import { marketFixture, requestFixture } from "./fixtures.js";

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
    expect(result.marketHaircutBps).toBe(3100);
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
