import {
  calculateAdvancePricing,
  calculateCompanyRiskSignal,
  fallbackCompanyFinancialLookup
} from "./pricing.js";
import type { AdvanceRequest, MarketSnapshot, RiskDecision } from "./schemas.js";

export class PolicyError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export interface PolicyConfig {
  fixedCapMinor: number;
  maxGraphAgeSeconds: number;
  minGraphSamples: number;
}

export interface Authorization {
  decision: "AUTHORIZED" | "REJECTED";
  amountMinor: number;
  policyMaxMinor: number;
  eligibleEquityValueMinor: number;
  marketHaircutBps: number;
  reasonCodes: string[];
}

export function decimalToMicrounits(value: string): bigint {
  const [whole = "0", decimal = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(decimal.padEnd(6, "0"));
}

export function authorizeAdvance(
  request: AdvanceRequest,
  market: MarketSnapshot,
  risk: RiskDecision,
  config: PolicyConfig,
  nowSeconds = Math.floor(Date.now() / 1000)
): Authorization {
  if (market.hasIndexingErrors)
    throw new PolicyError("GRAPH_INDEXING_ERROR", "Graph indexing is unhealthy");
  if (market.oraclePaused) throw new PolicyError("ORACLE_PAUSED", "Market oracle is paused");
  if (market.assetSymbol !== request.grant.assetSymbol) {
    throw new PolicyError("ASSET_MISMATCH", "Market evidence does not match the request");
  }
  const evidenceAge = nowSeconds - Math.min(market.priceUpdatedAt, market.indexedBlockTimestamp);
  const maxEvidenceAgeSeconds =
    market.evidenceType === "PRIVATE_VALUATION" ? 365 * 24 * 60 * 60 : config.maxGraphAgeSeconds;
  if (evidenceAge < 0 || evidenceAge > maxEvidenceAgeSeconds) {
    throw new PolicyError(
      market.evidenceType === "PRIVATE_VALUATION" ? "PRIVATE_VALUATION_STALE" : "GRAPH_DATA_STALE",
      "Market evidence is stale"
    );
  }
  if (market.evidenceType === "PUBLIC_MARKET" && market.sampleCount < config.minGraphSamples) {
    throw new PolicyError("INSUFFICIENT_MARKET_HISTORY", "Not enough live samples");
  }
  try {
    return calculateAdvancePricing(
      request,
      market,
      risk,
      calculateCompanyRiskSignal(fallbackCompanyFinancialLookup()),
      { fixedCapMinor: config.fixedCapMinor }
    ).authorization;
  } catch (error) {
    if (error instanceof Error && error.message === "POLICY_OVERFLOW") {
      throw new PolicyError("POLICY_OVERFLOW", "Calculated amount exceeds safe integer bounds");
    }
    throw error;
  }
}
