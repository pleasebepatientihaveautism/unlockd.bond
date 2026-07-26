import type { CustomerAdvance } from "./public.js";
import type { AdvanceRequest, FundingTransaction, RepaymentResult } from "./schemas.js";

export const POSITION_LTV_BPS = 7_000n;
const BPS_SCALE = 10_000n;
const UNIT_SCALE = 1_000_000n;

export type ValuationObservationKind = "LIVE" | "VALUATION" | "EMULATED";

export interface ValuationObservation {
  observedAt: string;
  priceUsdMinor: number;
  source: string;
  kind: ValuationObservationKind;
  evidenceUrl: string | null;
}

export interface CollateralEvidence {
  tokenId: string;
  serial: string;
  escrowAccountId: string;
  label: "Synthetic demo collateral — no real shares or value";
  mirrorUrl: string;
  hashscanUrl: string;
}

export interface RepaymentLedgerEntry {
  repaymentId: string;
  amountMinor: number;
  previousPrincipalMinor: number;
  remainingPrincipalMinor: number;
  createdAt: string;
  result: RepaymentResult;
}

export interface LiquidationEvidence {
  version: 1;
  liquidationId: string;
  advanceId: string;
  emulatedPriceMinor: number;
  liquidationPriceMinor: number;
  remainingPrincipalMinor: 0;
  collateral: CollateralEvidence & { transferredToPool: true };
  note: {
    tokenId: string;
    serial: string;
    retired: true;
    mirrorUrl: string;
    hashscanUrl: string;
  };
  transactions: {
    authorization: FundingTransaction;
    settlement: FundingTransaction;
    noteBurn: FundingTransaction;
    liquidatedEvent: FundingTransaction;
  };
  simulated: boolean;
}

export interface PositionView {
  advance: CustomerAdvance;
  grantSummary: {
    assetSymbol: string;
    grantType: "RSU" | "OPTION";
    strikePriceMinor: number;
  };
  originalPrincipalMinor: number;
  remainingPrincipalMinor: number;
  fundedAt: string;
  maturityAt: string;
  liquidationPriceMinor: number;
  valuations: ValuationObservation[];
  collateral: CollateralEvidence | null;
}

function decimalToMicrounits(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * UNIT_SCALE + BigInt(fraction.padEnd(6, "0").slice(0, 6));
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("LIQUIDATION_UNITS_INVALID");
  return (numerator + denominator - 1n) / denominator;
}

export function calculateLiquidationPriceMinor(
  remainingPrincipalMinor: number,
  grant: Pick<AdvanceRequest["grant"], "grantType" | "vestedUnits" | "strikePriceMinor">
): number {
  if (!Number.isSafeInteger(remainingPrincipalMinor) || remainingPrincipalMinor < 0) {
    throw new Error("REMAINING_PRINCIPAL_INVALID");
  }
  if (remainingPrincipalMinor === 0) return 0;
  const units = decimalToMicrounits(grant.vestedUnits);
  if (units <= 0n) throw new Error("LIQUIDATION_UNITS_INVALID");
  const intrinsicPriceMinor = ceilDiv(
    BigInt(remainingPrincipalMinor) * BPS_SCALE * UNIT_SCALE,
    units * POSITION_LTV_BPS
  );
  const price =
    grant.grantType === "OPTION"
      ? BigInt(grant.strikePriceMinor) + intrinsicPriceMinor
      : intrinsicPriceMinor;
  if (price > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("LIQUIDATION_PRICE_OVERFLOW");
  return Number(price);
}

export function positionTimestampToIso(value: string): string {
  const hederaTimestamp = /^(\d+)\.(\d{1,9})$/.exec(value);
  if (hederaTimestamp) {
    const seconds = Number(hederaTimestamp[1]);
    const nanoseconds = Number(hederaTimestamp[2].padEnd(9, "0"));
    const milliseconds = seconds * 1_000 + Math.floor(nanoseconds / 1_000_000);
    if (!Number.isFinite(milliseconds)) throw new Error("FUNDED_AT_INVALID");
    return new Date(milliseconds).toISOString();
  }
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw new Error("FUNDED_AT_INVALID");
  return new Date(milliseconds).toISOString();
}

export function positionMaturity(fundedAt: string, termDays: number): string {
  const fundedTime = new Date(positionTimestampToIso(fundedAt)).getTime();
  if (!Number.isFinite(fundedTime)) throw new Error("FUNDED_AT_INVALID");
  return new Date(fundedTime + termDays * 86_400_000).toISOString();
}
