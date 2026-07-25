import type {
  AdvanceRequest,
  AssetSymbol,
  FundingResult,
  MarketSnapshot,
  RiskDecision,
  RiskReceipt
} from "../../domain/schemas.js";

export interface MarketProvider {
  snapshot(assetSymbol: AssetSymbol): Promise<MarketSnapshot>;
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
  amountTinybar: bigint;
  employeeCommitment: string;
  decisionCommitment: string;
  marketCommitment: string;
  graphBlock: number;
  graphDeployment: string;
  zeroGRequestId: string;
  zeroGProvider: string;
  zeroGTeeVerified: boolean;
}

export interface PaymentProvider {
  fund(packet: FundingPacket): Promise<FundingResult>;
  ready(): Promise<boolean>;
}
