import type { Authorization } from "./policy.js";
import type { EquityPricingQuote } from "./pricing.js";
import type {
  FundingProgress,
  FundingResult,
  MarketSnapshot,
  RiskDecision,
  RiskReceipt
} from "./schemas.js";

export type AdvanceState = "AUTHORIZED" | "FUNDING" | "FUNDED" | "FUNDING_FAILED" | "REJECTED";

export interface AdvanceRecord {
  advanceId: string;
  requestId: string;
  state: AdvanceState;
  mode: "demo" | "hedera-demo" | "live";
  recipientAccountId: string;
  termDays: number;
  createdAt: string;
  expiresAt: string;
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
  failureCode: string | null;
}

export type CustomerAdvance = Omit<AdvanceRecord, "confirmationTokenHash" | "commitmentNonces">;
export type PublicAdvance = Omit<CustomerAdvance, "pricing">;

export function toCustomerAdvance(record: AdvanceRecord): CustomerAdvance {
  const {
    confirmationTokenHash: _secret,
    commitmentNonces: _commitmentNonces,
    ...publicRecord
  } = record;
  return publicRecord;
}

export function toPublicAdvance(record: AdvanceRecord): PublicAdvance {
  const { pricing: _pricing, ...publicRecord } = toCustomerAdvance(record);
  return publicRecord;
}
