import type { Authorization } from "./policy.js";
import type {
  CollateralEvidence,
  LiquidationEvidence,
  RepaymentLedgerEntry,
  ValuationObservation
} from "./positions.js";
import type { EquityPricingQuote } from "./pricing.js";
import type {
  AdvanceRequest,
  FundingProgress,
  FundingResult,
  LiquidationProgress,
  MarketSnapshot,
  RepaymentProgress,
  RepaymentResult,
  RiskDecision,
  RiskReceipt
} from "./schemas.js";

export type AdvanceState =
  | "AUTHORIZED"
  | "FUNDING"
  | "FUNDED"
  | "FUNDING_FAILED"
  | "REPAYMENT_PENDING"
  | "REPAYMENT_REVIEW_REQUIRED"
  | "LIQUIDATION_PENDING"
  | "LIQUIDATION_REVIEW_REQUIRED"
  | "LIQUIDATED"
  | "REPAID"
  | "REJECTED";

export interface AdvanceRecord {
  advanceId: string;
  requestId: string;
  state: AdvanceState;
  mode: "demo" | "hedera-demo" | "live";
  recipientAccountId: string;
  termDays: number;
  createdAt: string;
  expiresAt: string;
  ownerSessionHash?: string;
  grant?: AdvanceRequest["grant"];
  fundedAt?: string | null;
  maturityAt?: string | null;
  remainingPrincipalMinor?: number;
  valuations?: ValuationObservation[];
  collateral?: CollateralEvidence | null;
  repayments?: RepaymentLedgerEntry[];
  liquidation?: LiquidationEvidence | null;
  liquidationId?: string | null;
  liquidationProgress?: LiquidationProgress | null;
  employeeCommitment: string;
  decisionCommitment: string;
  marketCommitment: string;
  commitmentNonces: {
    employee: string;
    decision: string;
    market: string;
  };
  confirmationTokenHash: string;
  market: MarketSnapshot;
  risk: RiskDecision;
  riskReceipt: RiskReceipt;
  pricing: EquityPricingQuote;
  authorization: Authorization;
  funding: FundingResult | null;
  fundingProgress: FundingProgress | null;
  repayment: RepaymentResult | null;
  repaymentProgress: RepaymentProgress | null;
  repaymentId: string | null;
  failureCode: string | null;
}

export type CustomerAdvance = Omit<
  AdvanceRecord,
  "confirmationTokenHash" | "commitmentNonces" | "ownerSessionHash" | "grant"
>;
export type PublicAdvance = Omit<CustomerAdvance, "pricing">;

export function toCustomerAdvance(record: AdvanceRecord): CustomerAdvance {
  const {
    confirmationTokenHash: _secret,
    commitmentNonces: _commitmentNonces,
    ownerSessionHash: _ownerSessionHash,
    grant: _grant,
    ...publicRecord
  } = record;
  return publicRecord;
}

export function toPublicAdvance(record: AdvanceRecord): PublicAdvance {
  const { pricing: _pricing, ...publicRecord } = toCustomerAdvance(record);
  return publicRecord;
}
