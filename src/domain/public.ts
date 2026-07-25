import type { Authorization } from "./policy.js";
import type { FundingResult, MarketSnapshot, RiskDecision, RiskReceipt } from "./schemas.js";

export type AdvanceState = "AUTHORIZED" | "FUNDING" | "FUNDED" | "FUNDING_FAILED" | "REJECTED";

export interface AdvanceRecord {
  advanceId: string;
  requestId: string;
  state: AdvanceState;
  mode: "demo" | "live";
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
  authorization: Authorization;
  funding: FundingResult | null;
  failureCode: string | null;
}

export type PublicAdvance = Omit<AdvanceRecord, "confirmationTokenHash" | "commitmentNonces">;

export function toPublicAdvance(record: AdvanceRecord): PublicAdvance {
  const {
    confirmationTokenHash: _secret,
    commitmentNonces: _commitmentNonces,
    ...publicRecord
  } = record;
  return publicRecord;
}
