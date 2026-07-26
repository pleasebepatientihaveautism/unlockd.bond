import type { AdvanceRequest, MarketSnapshot, RiskDecision } from "./schemas.js";

export const BASE_UPSIDE_SHARE_BPS = 1_500;
export const RISK_MULTIPLIER_BPS = 5_000;
export const MIN_UPSIDE_SHARE_BPS = 1_000;
export const MAX_UPSIDE_SHARE_BPS = 6_000;
export const FALLBACK_UPSIDE_SHARE_BPS = 3_500;
export const POLICY_BUFFER_BPS = 0;
export const EQUITY_ADVANCE_LTV_BPS = 7_000;

export type CompanyDataSource = "coresignal" | "fallback_default";
export type CompanyCacheStatus = "hit" | "miss" | "stale" | "budget_blocked" | "disabled";

export interface CompanyFinancialSnapshot {
  preferredStock: number | null;
  commonStock: number | null;
  totalAssets: number | null;
  sharesOutstanding: number | null;
  asOfDate: string | null;
  sourceLabel: string | null;
  sourceUrl: string | null;
}

export interface CompanyFinancialLookup {
  financials: CompanyFinancialSnapshot | null;
  dataSource: CompanyDataSource;
  cacheStatus: CompanyCacheStatus;
  remainingApiCalls: number;
  fallbackReason: string | null;
}

export interface CompanyRiskSignal {
  preferredOverhangRatioBps: number | null;
  poolUpsideShareBps: number;
  dataSource: CompanyDataSource;
  asOfDate: string | null;
  cacheStatus: CompanyCacheStatus;
  remainingApiCalls: number;
  fallbackReason: string | null;
}

export interface EquityPricingQuote {
  referenceSharePriceMinor: number;
  strikePriceMinor: number;
  netValuePerOptionMinor: number;
  grossEquityValueMinor: number;
  volatilityHaircutBps: number;
  liquidityHaircutBps: number;
  policyBufferBps: number;
  totalHaircutBps: number;
  eligibleEquityValueMinor: number;
  equityBasedCreditLimitMinor: number;
  fixedCreditLimitMinor: number;
  finalCreditLineMinor: number;
  poolUpsideShareBps: number;
  preferredOverhangRatioBps: number | null;
  valuationSource:
    | NonNullable<AdvanceRequest["grant"]["valuationSource"]>
    | "PUBLIC_MARKET"
    | "YAHOO_PRIVATE_MARKET";
  companyRiskSource: CompanyDataSource;
  evidenceDate: string | null;
  cacheStatus: CompanyCacheStatus;
  remainingApiCalls: number;
  fallbackReason: string | null;
}

export interface PricingPolicyConfig {
  fixedCapMinor: number;
}

export interface PricingAuthorization {
  decision: "AUTHORIZED" | "REJECTED";
  amountMinor: number;
  policyMaxMinor: number;
  eligibleEquityValueMinor: number;
  marketHaircutBps: number;
  reasonCodes: string[];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function safeMinor(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("POLICY_OVERFLOW");
  }
  return Number(value);
}

function decimalToMicrounits(value: string): bigint {
  const [whole = "0", decimal = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(decimal.padEnd(6, "0"));
}

export function calculateEquityLtvCapMinor(
  request: AdvanceRequest,
  market: MarketSnapshot
): number {
  const units = decimalToMicrounits(request.grant.vestedUnits);
  const referencePrice = BigInt(market.priceUsdMinor);
  const strike = BigInt(request.grant.strikePriceMinor);
  const netValuePerOption =
    request.grant.grantType === "RSU"
      ? referencePrice
      : referencePrice > strike
        ? referencePrice - strike
        : 0n;
  const grossEquityValue = (units * netValuePerOption) / 1_000_000n;
  return safeMinor((grossEquityValue * BigInt(EQUITY_ADVANCE_LTV_BPS)) / 10_000n);
}

export function fallbackCompanyFinancialLookup(
  fallbackReason = "COMPANY_DATA_UNAVAILABLE",
  cacheStatus: CompanyCacheStatus = "disabled",
  remainingApiCalls = 100
): CompanyFinancialLookup {
  return {
    financials: null,
    dataSource: "fallback_default",
    cacheStatus,
    remainingApiCalls,
    fallbackReason
  };
}

export function calculateCompanyRiskSignal(lookup: CompanyFinancialLookup): CompanyRiskSignal {
  const preferred = lookup.financials?.preferredStock;
  const common = lookup.financials?.commonStock;
  const denominator =
    preferred !== null && preferred !== undefined && common !== null && common !== undefined
      ? preferred + common
      : 0;

  if (
    lookup.dataSource !== "coresignal" ||
    preferred === null ||
    preferred === undefined ||
    common === null ||
    common === undefined ||
    !Number.isFinite(preferred) ||
    !Number.isFinite(common) ||
    preferred < 0 ||
    common < 0 ||
    denominator <= 0
  ) {
    return {
      preferredOverhangRatioBps: null,
      poolUpsideShareBps: FALLBACK_UPSIDE_SHARE_BPS,
      dataSource: "fallback_default",
      asOfDate: lookup.financials?.asOfDate ?? null,
      cacheStatus: lookup.cacheStatus,
      remainingApiCalls: lookup.remainingApiCalls,
      fallbackReason: lookup.fallbackReason ?? "PREFERRED_OVERHANG_UNAVAILABLE"
    };
  }

  const preferredOverhangRatioBps = clamp(
    Math.round((preferred / denominator) * 10_000),
    0,
    10_000
  );
  const poolUpsideShareBps = clamp(
    BASE_UPSIDE_SHARE_BPS + Math.round((RISK_MULTIPLIER_BPS * preferredOverhangRatioBps) / 10_000),
    MIN_UPSIDE_SHARE_BPS,
    MAX_UPSIDE_SHARE_BPS
  );
  return {
    preferredOverhangRatioBps,
    poolUpsideShareBps,
    dataSource: "coresignal",
    asOfDate: lookup.financials?.asOfDate ?? null,
    cacheStatus: lookup.cacheStatus,
    remainingApiCalls: lookup.remainingApiCalls,
    fallbackReason: null
  };
}

export function calculateAdvancePricing(
  request: AdvanceRequest,
  market: MarketSnapshot,
  risk: RiskDecision,
  companyRisk: CompanyRiskSignal,
  _config: PricingPolicyConfig
): { quote: EquityPricingQuote; authorization: PricingAuthorization } {
  const units = decimalToMicrounits(request.grant.vestedUnits);
  const referencePrice = BigInt(market.priceUsdMinor);
  const strike = BigInt(request.grant.strikePriceMinor);
  const netValuePerOption =
    request.grant.grantType === "RSU"
      ? referencePrice
      : referencePrice > strike
        ? referencePrice - strike
        : 0n;
  const grossEquityValue = (units * netValuePerOption) / 1_000_000n;
  // Private-company borrowing is intentionally transparent: Yahoo reference
  // price × vested shares, with no compensation input or opaque haircut in the cap.
  const totalHaircutBps = 0;
  const eligibleEquityValue = grossEquityValue;
  const equityBasedLimit = BigInt(calculateEquityLtvCapMinor(request, market));
  const requestedAmount = BigInt(request.request.amountMinor);
  const policyMax = equityBasedLimit;
  const modelLimit =
    risk.decision === "reject" ? 0n : BigInt(Math.max(0, risk.recommendedAdvanceMinor));
  const finalCreditLine = [requestedAmount, modelLimit, policyMax].reduce((lowest, current) =>
    current < lowest ? current : lowest
  );
  const rejected = risk.decision === "reject" || finalCreditLine <= 0n;

  const quote: EquityPricingQuote = {
    referenceSharePriceMinor: market.priceUsdMinor,
    strikePriceMinor: request.grant.strikePriceMinor,
    netValuePerOptionMinor: safeMinor(netValuePerOption),
    grossEquityValueMinor: safeMinor(grossEquityValue),
    volatilityHaircutBps: 0,
    liquidityHaircutBps: 0,
    policyBufferBps: POLICY_BUFFER_BPS,
    totalHaircutBps,
    eligibleEquityValueMinor: safeMinor(eligibleEquityValue),
    equityBasedCreditLimitMinor: safeMinor(equityBasedLimit),
    fixedCreditLimitMinor: safeMinor(equityBasedLimit),
    finalCreditLineMinor: rejected ? 0 : safeMinor(finalCreditLine),
    poolUpsideShareBps: companyRisk.poolUpsideShareBps,
    preferredOverhangRatioBps: companyRisk.preferredOverhangRatioBps,
    valuationSource:
      market.evidenceType === "PUBLIC_MARKET"
        ? "PUBLIC_MARKET"
        : market.source === "yahoo-finance-private"
          ? "YAHOO_PRIVATE_MARKET"
          : (request.grant.valuationSource ?? "SYNTHETIC"),
    companyRiskSource: companyRisk.dataSource,
    evidenceDate:
      market.source === "issuer-valuation"
        ? request.grant.valuationDate
        : new Date(market.priceUpdatedAt * 1000).toISOString().slice(0, 10),
    cacheStatus: companyRisk.cacheStatus,
    remainingApiCalls: companyRisk.remainingApiCalls,
    fallbackReason: companyRisk.fallbackReason
  };

  return {
    quote,
    authorization: {
      decision: rejected ? "REJECTED" : "AUTHORIZED",
      amountMinor: quote.finalCreditLineMinor,
      policyMaxMinor: safeMinor(policyMax),
      eligibleEquityValueMinor: quote.eligibleEquityValueMinor,
      marketHaircutBps: totalHaircutBps,
      reasonCodes: rejected
        ? [...risk.reasonCodes, ...(finalCreditLine <= 0n ? ["POLICY_AMOUNT_ZERO"] : [])]
        : risk.reasonCodes
    }
  };
}
