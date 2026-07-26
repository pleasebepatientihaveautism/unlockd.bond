import { createHmac, randomUUID } from "node:crypto";
import { confirmationDigest, saltedCommitment, sha256 } from "../domain/canonical.js";
import { authorizeAdvance } from "../domain/policy.js";
import {
  calculateAdvancePricing,
  calculateCompanyRiskSignal,
  calculateEquityLtvCapMinor,
  fallbackCompanyFinancialLookup
} from "../domain/pricing.js";
import {
  type AdvanceRecord,
  type CustomerAdvance,
  type PublicAdvance,
  toCustomerAdvance,
  toPublicAdvance
} from "../domain/public.js";
import type {
  AdvanceRequest,
  AssetSymbol,
  FundingResultV2,
  MarketSnapshot,
  PrivateCompanyListing
} from "../domain/schemas.js";
import type {
  CompanyFinancialProvider,
  MarketProvider,
  PaymentProvider,
  RiskProvider
} from "./adapters/types.js";
import { usdMinorToStableUnits } from "./adapters/types.js";
import type { AppConfig } from "./config.js";
import type { AdvanceStore } from "./store.js";

export interface ServiceDependencies {
  config: AppConfig;
  store: AdvanceStore;
  market: MarketProvider;
  companyFinancials: CompanyFinancialProvider;
  risk: RiskProvider;
  payment: PaymentProvider;
}

function confirmationToken(requestId: string, secret: string): string {
  return createHmac("sha256", secret).update(`fund:${requestId}`).digest("base64url");
}

function safeFailureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)) {
    return error.message;
  }
  if (error && typeof error === "object" && "status" in error) {
    const status = String(error.status);
    if (/^[A-Z][A-Z0-9_]{2,80}$/.test(status)) return `HEDERA_${status}`;
  }
  return "PARTNER_OPERATION_FAILED";
}

function hasSuccessfulConsensus(result: NonNullable<AdvanceRecord["funding"]>): boolean {
  if ("version" in result) {
    return Object.values(result.transactions).every(
      (transaction) => transaction.consensusStatus === "SUCCESS"
    );
  }
  return result.consensusStatus === "SUCCESS";
}

export class UnlockdBondService {
  constructor(private readonly deps: ServiceDependencies) {}

  async marketPreview(assetSymbol: AssetSymbol): Promise<MarketSnapshot> {
    return this.deps.market.snapshot(assetSymbol);
  }

  async privateCompanies(): Promise<PrivateCompanyListing[]> {
    if (!this.deps.market.listPrivateCompanies) {
      throw new Error("PRIVATE_COMPANY_CATALOGUE_UNAVAILABLE");
    }
    return this.deps.market.listPrivateCompanies();
  }

  async evaluate(request: AdvanceRequest): Promise<{
    advance: CustomerAdvance;
    confirmationToken: string | null;
    idempotentReplay: boolean;
  }> {
    if (this.deps.config.mode === "demo" && !request.synthetic) {
      throw new Error("DEMO_REQUIRES_SYNTHETIC_PROFILE");
    }
    const market = await this.deps.market.snapshot(request.grant.assetSymbol, request.grant);
    const companyFinancialLookup = fallbackCompanyFinancialLookup("EQUITY_PRICE_ONLY_POLICY");
    if (this.deps.config.mode === "live" && market.simulated) {
      throw new Error("LIVE_GRAPH_EVIDENCE_REQUIRED");
    }
    const prePolicyMax = calculateEquityLtvCapMinor(request, market);
    const { decision: risk, receipt: riskReceipt } = await this.deps.risk.evaluate(
      request,
      market,
      prePolicyMax
    );
    if (
      this.deps.config.mode === "live" &&
      (riskReceipt.simulated || !riskReceipt.teeVerified || riskReceipt.trustMode !== "private")
    ) {
      throw new Error("PRIVATE_TEE_VERIFICATION_REQUIRED");
    }
    const policyConfig = {
      fixedCapMinor: this.deps.config.POLICY_FIXED_CAP_MINOR,
      maxGraphAgeSeconds: this.deps.config.GRAPH_MAX_AGE_SECONDS,
      minGraphSamples: this.deps.config.GRAPH_MIN_SAMPLES
    };
    // Preserve the existing fail-closed evidence validation before producing terms.
    authorizeAdvance(request, market, risk, policyConfig);
    const companyRisk = calculateCompanyRiskSignal(companyFinancialLookup);
    const { quote: pricing, authorization } = calculateAdvancePricing(
      request,
      market,
      risk,
      companyRisk,
      policyConfig
    );
    const token = confirmationToken(request.requestId, this.deps.config.CONFIRMATION_SECRET);
    const now = new Date();
    const employeeCommitment = saltedCommitment(
      {
        employeeRef: request.employeeRef,
        grant: request.grant,
        request: request.request
      },
      this.deps.config.COMMITMENT_SECRET
    );
    const decisionCommitment = saltedCommitment(
      { risk, authorization, pricing },
      this.deps.config.COMMITMENT_SECRET
    );
    const marketCommitment = saltedCommitment(market, this.deps.config.COMMITMENT_SECRET);
    const record: AdvanceRecord = {
      advanceId: `ub_${randomUUID().replaceAll("-", "")}`,
      requestId: request.requestId,
      state: authorization.decision,
      mode: this.deps.config.mode,
      recipientAccountId: this.deps.config.HEDERA_RECIPIENT_ID,
      termDays: request.request.termDays,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      employeeCommitment: employeeCommitment.commitment,
      decisionCommitment: decisionCommitment.commitment,
      marketCommitment: marketCommitment.commitment,
      commitmentNonces: {
        employee: employeeCommitment.nonce,
        decision: decisionCommitment.nonce,
        market: marketCommitment.nonce
      },
      confirmationTokenHash: confirmationDigest(token, this.deps.config.CONFIRMATION_SECRET),
      market,
      risk: { ...risk, assumptions: [] },
      riskReceipt,
      pricing,
      authorization,
      funding: null,
      fundingProgress: null,
      repayment: null,
      repaymentProgress: null,
      repaymentId: null,
      failureCode: null
    };
    const reserved = await this.deps.store.reserve(record);
    return {
      advance: toCustomerAdvance(reserved.record),
      confirmationToken: reserved.record.state === "AUTHORIZED" ? token : null,
      idempotentReplay: !reserved.created
    };
  }

  async fund(
    advanceId: string,
    token: string
  ): Promise<{
    advance: CustomerAdvance;
    idempotentReplay: boolean;
  }> {
    const digest = confirmationDigest(token, this.deps.config.CONFIRMATION_SECRET);
    const begun = await this.deps.store.beginFunding(advanceId, digest, new Date());
    if (!begun.acquired) {
      return { advance: toCustomerAdvance(begun.record), idempotentReplay: true };
    }
    try {
      const record = begun.record;
      if (record.recipientAccountId !== this.deps.config.HEDERA_RECIPIENT_ID) {
        throw new Error("SETTLEMENT_RECIPIENT_CONFIG_CHANGED");
      }
      const result = await this.deps.payment.fund(
        {
          advanceId: record.advanceId,
          recipientAccountId: record.recipientAccountId,
          amountMinor: record.authorization.amountMinor,
          amountStableUnits: usdMinorToStableUnits(record.authorization.amountMinor),
          employeeCommitment: record.employeeCommitment,
          decisionCommitment: record.decisionCommitment,
          marketCommitment: record.marketCommitment,
          graphBlock: record.market.indexedBlock,
          graphDeployment: record.market.subgraphDeployment,
          zeroGRequestId: record.riskReceipt.requestId,
          zeroGProvider: record.riskReceipt.provider,
          zeroGTeeVerified: record.riskReceipt.teeVerified
        },
        async (progress) => {
          await this.deps.store.recordFundingProgress(advanceId, progress);
        }
      );
      if (
        this.deps.config.mode !== "demo" &&
        (result.simulated || !hasSuccessfulConsensus(result))
      ) {
        throw new Error("HEDERA_CONSENSUS_SUCCESS_REQUIRED");
      }
      const completed = await this.deps.store.completeFunding(advanceId, result);
      return { advance: toCustomerAdvance(completed), idempotentReplay: false };
    } catch (error) {
      const failureCode = safeFailureCode(error);
      await this.deps.store.failFunding(advanceId, failureCode);
      throw failureCode === "PARTNER_OPERATION_FAILED" ? error : new Error(failureCode);
    }
  }

  async repay(
    advanceId: string,
    repaymentId: string,
    token: string
  ): Promise<{
    advance: CustomerAdvance;
    idempotentReplay: boolean;
  }> {
    const digest = confirmationDigest(token, this.deps.config.CONFIRMATION_SECRET);
    const begun = await this.deps.store.beginRepayment(advanceId, repaymentId, digest);
    if (!begun.acquired) {
      return { advance: toCustomerAdvance(begun.record), idempotentReplay: true };
    }
    try {
      const record = begun.record;
      if (record.recipientAccountId !== this.deps.config.HEDERA_RECIPIENT_ID) {
        throw new Error("REPAYMENT_PAYER_CONFIG_CHANGED");
      }
      const funding = record.funding;
      if (!funding || !("version" in funding) || funding.version !== 2) {
        throw new Error("REPAYMENT_REQUIRES_V2_RECEIPT");
      }
      const result = await this.deps.payment.repay(
        this.repaymentPacket(record, funding, repaymentId),
        async (progress) => {
          await this.deps.store.recordRepaymentProgress(advanceId, progress);
        }
      );
      if (
        this.deps.config.mode !== "demo" &&
        (result.simulated ||
          !Object.values(result.transactions).every(
            (transaction) => transaction.consensusStatus === "SUCCESS"
          ))
      ) {
        throw new Error("HEDERA_REPAYMENT_CONSENSUS_SUCCESS_REQUIRED");
      }
      const completed = await this.deps.store.completeRepayment(advanceId, result);
      return { advance: toCustomerAdvance(completed), idempotentReplay: false };
    } catch (error) {
      const failureCode = safeFailureCode(error);
      await this.deps.store.failRepayment(advanceId, failureCode);
      throw failureCode === "PARTNER_OPERATION_FAILED" ? error : new Error(failureCode);
    }
  }

  async get(advanceId: string): Promise<PublicAdvance | null> {
    const record = await this.deps.store.get(advanceId);
    return record ? toPublicAdvance(record) : null;
  }

  async payoff(advanceId: string) {
    const record = await this.deps.store.get(advanceId);
    if (!record) throw new Error("ADVANCE_NOT_FOUND");
    if (
      !["FUNDED", "REPAYMENT_PENDING", "REPAYMENT_REVIEW_REQUIRED", "REPAID"].includes(record.state)
    ) {
      throw new Error("ADVANCE_NOT_REPAYABLE");
    }
    const principalMinor = record.state === "REPAID" ? 0 : record.authorization.amountMinor;
    return {
      advanceId: record.advanceId,
      state: record.state,
      payerAccountId: record.recipientAccountId,
      dueAt: new Date(
        new Date(record.createdAt).getTime() + record.termDays * 24 * 60 * 60 * 1000
      ).toISOString(),
      principalMinor,
      interestMinor: 0,
      feesMinor: 0,
      totalMinor: principalMinor,
      amountUnits: principalMinor === 0 ? "0" : usdMinorToStableUnits(principalMinor).toString(),
      asset: {
        tokenId: this.deps.config.HEDERA_STABLE_TOKEN_ID ?? null,
        symbol: "USDC",
        decimals: 6,
        label: "Demo USDC — no real value"
      }
    };
  }

  async readiness(): Promise<Record<string, boolean>> {
    const [store, market, companyFinancials, risk, payment] = await Promise.all([
      this.deps.store.ping(),
      this.deps.market.ready(),
      this.deps.companyFinancials.ready(),
      this.deps.risk.ready(),
      this.deps.payment.ready()
    ]);
    return { store, market, companyFinancials, risk, payment };
  }

  decisionFingerprint(advance: PublicAdvance): string {
    return sha256({
      advanceId: advance.advanceId,
      amountMinor: advance.authorization.amountMinor,
      recipient: advance.recipientAccountId,
      expiresAt: advance.expiresAt
    });
  }

  private repaymentPacket(record: AdvanceRecord, funding: FundingResultV2, repaymentId: string) {
    return {
      repaymentId,
      advanceId: record.advanceId,
      payerAccountId: record.recipientAccountId,
      amountMinor: record.authorization.amountMinor,
      amountStableUnits: usdMinorToStableUnits(record.authorization.amountMinor),
      noteTokenId: funding.note.tokenId,
      noteSerial: funding.note.serial,
      issuanceSettlementTransactionId: funding.transactions.settlement.transactionId
    };
  }
}
