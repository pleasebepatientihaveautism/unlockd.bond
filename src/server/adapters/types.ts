import type { CompanyFinancialLookup } from "../../domain/pricing.js";
import type {
  AdvanceRequest,
  AssetSymbol,
  FundingProgress,
  FundingResult,
  LiquidationProgress,
  LiquidationResult,
  MarketSnapshot,
  PrivateCompanyListing,
  RepaymentProgress,
  RepaymentResult,
  RiskDecision,
  RiskReceipt
} from "../../domain/schemas.js";

export interface MarketProvider {
  snapshot(assetSymbol: AssetSymbol, grant?: AdvanceRequest["grant"]): Promise<MarketSnapshot>;
  listPrivateCompanies?(): Promise<PrivateCompanyListing[]>;
  ready(): Promise<boolean>;
}

export interface CompanyFinancialProvider {
  fetchCompanyFinancials(companyIdentifier: string): Promise<CompanyFinancialLookup>;
  ready(): Promise<boolean>;
}

export interface RiskProvider {
  evaluate(
    request: AdvanceRequest,
    market: MarketSnapshot,
    policyMaxMinor: number
  ): Promise<{ decision: RiskDecision; receipt: RiskReceipt }>;
  ready(): Promise<boolean>;
}

export interface FundingPacket {
  advanceId: string;
  recipientAccountId: string;
  amountMinor: number;
  amountStableUnits: bigint;
  employeeCommitment: string;
  decisionCommitment: string;
  marketCommitment: string;
  graphBlock: number;
  graphDeployment: string;
  zeroGRequestId: string;
  zeroGProvider: string;
  zeroGTeeVerified: boolean;
  assetSymbol: AssetSymbol;
  grantType: AdvanceRequest["grant"]["grantType"];
  vestedUnits: string;
  strikePriceMinor: number;
}

export type FundingProgressRecorder = (progress: FundingProgress) => Promise<void>;

export interface RepaymentPacket {
  repaymentId: string;
  advanceId: string;
  payerAccountId: string;
  amountMinor: number;
  amountStableUnits: bigint;
  previousPrincipalMinor: number;
  remainingPrincipalMinor: number;
  noteTokenId: string;
  noteSerial: string;
  issuanceSettlementTransactionId: string;
  collateralTokenId?: string;
  collateralSerial?: string;
  collateralEscrowAccountId?: string;
}

export type RepaymentProgressRecorder = (progress: RepaymentProgress) => Promise<void>;

export interface LiquidationPacket {
  liquidationId: string;
  advanceId: string;
  emulatedPriceMinor: number;
  liquidationPriceMinor: number;
  remainingPrincipalMinor: number;
  noteTokenId: string;
  noteSerial: string;
  collateralTokenId: string;
  collateralSerial: string;
  collateralEscrowAccountId: string;
}

export type LiquidationProgressRecorder = (progress: LiquidationProgress) => Promise<void>;

export interface PaymentProvider {
  fund(packet: FundingPacket, recordProgress?: FundingProgressRecorder): Promise<FundingResult>;
  repay(
    packet: RepaymentPacket,
    recordProgress?: RepaymentProgressRecorder
  ): Promise<RepaymentResult>;
  liquidate?(
    packet: LiquidationPacket,
    recordProgress?: LiquidationProgressRecorder
  ): Promise<LiquidationResult>;
  ready(): Promise<boolean>;
}

export const STABLE_TOKEN_DECIMALS = 6 as const;
export const STABLE_UNITS_PER_USD_MINOR = 10_000n;

export function usdMinorToStableUnits(amountMinor: number): bigint {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new Error("STABLE_AMOUNT_INVALID");
  }
  return BigInt(amountMinor) * STABLE_UNITS_PER_USD_MINOR;
}
