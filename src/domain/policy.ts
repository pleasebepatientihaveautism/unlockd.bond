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
  const graphAge = nowSeconds - Math.min(market.priceUpdatedAt, market.indexedBlockTimestamp);
  if (graphAge < 0 || graphAge > config.maxGraphAgeSeconds) {
    throw new PolicyError("GRAPH_DATA_STALE", "Market evidence is stale");
  }
  if (market.sampleCount < config.minGraphSamples) {
    throw new PolicyError("INSUFFICIENT_MARKET_HISTORY", "Not enough live samples");
  }
  if (risk.decision === "reject" || risk.recommendedAdvanceMinor <= 0) {
    return {
      decision: "REJECTED",
      amountMinor: 0,
      policyMaxMinor: 0,
      eligibleEquityValueMinor: 0,
      marketHaircutBps: 10_000,
      reasonCodes: risk.reasonCodes
    };
  }

  const units = decimalToMicrounits(request.grant.vestedUnits);
  const price = BigInt(market.priceUsdMinor);
  const strike = BigInt(request.grant.strikePriceMinor);
  const perUnit = request.grant.grantType === "RSU" ? price : price > strike ? price - strike : 0n;
  const grossMinor = (units * perUnit) / 1_000_000n;
  const marketHaircutBps = Math.min(
    9_500,
    risk.volatilityHaircutBps + risk.liquidityHaircutBps + 1_000
  );
  const eligibleMinor = (grossMinor * BigInt(10_000 - marketHaircutBps)) / 10_000n;
  const policyMax = [
    BigInt(request.request.amountMinor),
    BigInt(Math.floor(request.employment.monthlyNetIncomeMinor / 2)),
    eligibleMinor / 4n,
    BigInt(config.fixedCapMinor)
  ].reduce((lowest, current) => (current < lowest ? current : lowest));
  const executed =
    BigInt(risk.recommendedAdvanceMinor) < policyMax
      ? BigInt(risk.recommendedAdvanceMinor)
      : policyMax;

  if (executed <= 0n) {
    return {
      decision: "REJECTED",
      amountMinor: 0,
      policyMaxMinor: Number(policyMax),
      eligibleEquityValueMinor: Number(eligibleMinor),
      marketHaircutBps,
      reasonCodes: [...risk.reasonCodes, "POLICY_AMOUNT_ZERO"]
    };
  }
  if (
    executed > BigInt(Number.MAX_SAFE_INTEGER) ||
    eligibleMinor > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new PolicyError("POLICY_OVERFLOW", "Calculated amount exceeds safe integer bounds");
  }
  return {
    decision: "AUTHORIZED",
    amountMinor: Number(executed),
    policyMaxMinor: Number(policyMax),
    eligibleEquityValueMinor: Number(eligibleMinor),
    marketHaircutBps,
    reasonCodes: risk.reasonCodes
  };
}
