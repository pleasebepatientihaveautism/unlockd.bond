import { createHmac, randomUUID } from "node:crypto";
import { confirmationDigest, saltedCommitment, sha256 } from "../domain/canonical.js";
import { authorizeAdvance } from "../domain/policy.js";
import {
  calculateLiquidationPriceMinor,
  type PositionView,
  positionMaturity
} from "../domain/positions.js";
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

  async evaluate(
    request: AdvanceRequest,
    ownerSessionHash?: string
  ): Promise<{
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
      ownerSessionHash,
      grant: request.grant,
      fundedAt: null,
      maturityAt: null,
      remainingPrincipalMinor: authorization.amountMinor,
      valuations: [
        {
          observedAt: new Date(market.priceUpdatedAt * 1000).toISOString(),
          priceUsdMinor: market.priceUsdMinor,
          source: market.source,
          kind: market.evidenceType === "PRIVATE_VALUATION" ? "VALUATION" : "LIVE",
          evidenceUrl: market.externalEvidenceUrl ?? null
        }
      ],
      collateral: null,
      repayments: [],
      liquidation: null,
      liquidationId: null,
      liquidationProgress: null,
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
          zeroGTeeVerified: record.riskReceipt.teeVerified,
          assetSymbol: record.grant?.assetSymbol ?? record.market.assetSymbol,
          grantType:
            record.grant?.grantType ?? (record.pricing.strikePriceMinor > 0 ? "OPTION" : "RSU"),
          vestedUnits: record.grant?.vestedUnits ?? this.legacyVestedUnits(record),
          strikePriceMinor: record.grant?.strikePriceMinor ?? record.pricing.strikePriceMinor
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
      if (!funding) throw new Error("REPAYMENT_RECEIPT_REQUIRED");
      const result = await this.deps.payment.repay(
        this.repaymentPacket(
          record,
          funding,
          repaymentId,
          record.remainingPrincipalMinor ?? record.authorization.amountMinor
        ),
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

  async positions(ownerSessionHash: string, status: "open" | "closed"): Promise<PositionView[]> {
    const records = await this.deps.store.listByOwner(ownerSessionHash);
    const acceptedStates =
      status === "open"
        ? new Set([
            "FUNDED",
            "REPAYMENT_PENDING",
            "REPAYMENT_REVIEW_REQUIRED",
            "LIQUIDATION_PENDING",
            "LIQUIDATION_REVIEW_REQUIRED"
          ])
        : new Set(["REPAID", "LIQUIDATED"]);
    return records
      .filter((record) => acceptedStates.has(record.state))
      .map((record) => this.positionView(record));
  }

  async position(advanceId: string, ownerSessionHash: string): Promise<PositionView> {
    const record = await this.deps.store.get(advanceId);
    if (!record || record.ownerSessionHash !== ownerSessionHash) {
      throw new Error("POSITION_NOT_FOUND");
    }
    if (!record.funding) throw new Error("POSITION_NOT_FUNDED");
    return this.positionView(record);
  }

  async repayPosition(
    advanceId: string,
    repaymentId: string,
    amountMinor: number,
    ownerSessionHash: string
  ): Promise<{ position: PositionView; idempotentReplay: boolean }> {
    const begun = await this.deps.store.beginPositionRepayment(
      advanceId,
      repaymentId,
      ownerSessionHash,
      amountMinor
    );
    if (!begun.acquired) {
      return { position: this.positionView(begun.record), idempotentReplay: true };
    }
    try {
      const record = begun.record;
      const funding = record.funding;
      if (!funding || !("version" in funding) || funding.version < 2) {
        throw new Error("REPAYMENT_REQUIRES_V2_RECEIPT");
      }
      const result = await this.deps.payment.repay(
        this.repaymentPacket(record, funding, repaymentId, amountMinor),
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
      return { position: this.positionView(completed), idempotentReplay: false };
    } catch (error) {
      const failureCode = safeFailureCode(error);
      await this.deps.store.failRepayment(advanceId, failureCode);
      throw failureCode === "PARTNER_OPERATION_FAILED" ? error : new Error(failureCode);
    }
  }

  async liquidationPreview(
    advanceId: string,
    emulatedPriceMinor: number,
    ownerSessionHash: string
  ) {
    const position = await this.position(advanceId, ownerSessionHash);
    if (!Number.isSafeInteger(emulatedPriceMinor) || emulatedPriceMinor <= 0) {
      throw new Error("EMULATED_PRICE_INVALID");
    }
    return {
      advanceId,
      emulatedPriceMinor,
      liquidationPriceMinor: position.liquidationPriceMinor,
      wouldLiquidate: emulatedPriceMinor < position.liquidationPriceMinor,
      remainingPrincipalMinor: position.remainingPrincipalMinor,
      label: "Synthetic price preview — no real market execution"
    };
  }

  async liquidatePosition(
    advanceId: string,
    liquidationId: string,
    emulatedPriceMinor: number,
    ownerSessionHash: string
  ): Promise<{ position: PositionView; idempotentReplay: boolean }> {
    const preview = await this.liquidationPreview(advanceId, emulatedPriceMinor, ownerSessionHash);
    if (!preview.wouldLiquidate) throw new Error("LIQUIDATION_THRESHOLD_NOT_CROSSED");
    const begun = await this.deps.store.beginLiquidation(
      advanceId,
      liquidationId,
      ownerSessionHash
    );
    if (!begun.acquired) {
      return { position: this.positionView(begun.record), idempotentReplay: true };
    }
    try {
      const record = begun.record;
      const funding = record.funding;
      if (!funding || !("version" in funding) || funding.version !== 3) {
        throw new Error("LIQUIDATION_REQUIRES_V3_RECEIPT");
      }
      if (!this.deps.payment.liquidate) throw new Error("LIQUIDATION_PROVIDER_UNAVAILABLE");
      const result = await this.deps.payment.liquidate(
        {
          liquidationId,
          advanceId,
          emulatedPriceMinor,
          liquidationPriceMinor: preview.liquidationPriceMinor,
          remainingPrincipalMinor: preview.remainingPrincipalMinor,
          noteTokenId: funding.note.tokenId,
          noteSerial: funding.note.serial,
          collateralTokenId: funding.collateral.tokenId,
          collateralSerial: funding.collateral.serial,
          collateralEscrowAccountId: funding.collateral.escrowAccountId
        },
        async (progress) => {
          await this.deps.store.recordLiquidationProgress(advanceId, progress);
        }
      );
      if (
        this.deps.config.mode !== "demo" &&
        (result.simulated ||
          !Object.values(result.transactions).every(
            (transaction) => transaction.consensusStatus === "SUCCESS"
          ))
      ) {
        throw new Error("HEDERA_LIQUIDATION_CONSENSUS_SUCCESS_REQUIRED");
      }
      await this.deps.store.completeLiquidation(advanceId, result);
      const completed = await this.deps.store.appendValuation(advanceId, {
        observedAt: new Date().toISOString(),
        priceUsdMinor: emulatedPriceMinor,
        source: "user-confirmed-emulator",
        kind: "EMULATED",
        evidenceUrl: null
      });
      return { position: this.positionView(completed), idempotentReplay: false };
    } catch (error) {
      const failureCode = safeFailureCode(error);
      await this.deps.store.failLiquidation(advanceId, failureCode);
      throw failureCode === "PARTNER_OPERATION_FAILED" ? error : new Error(failureCode);
    }
  }

  async payoff(advanceId: string) {
    const record = await this.deps.store.get(advanceId);
    if (!record) throw new Error("ADVANCE_NOT_FOUND");
    if (
      !["FUNDED", "REPAYMENT_PENDING", "REPAYMENT_REVIEW_REQUIRED", "REPAID"].includes(record.state)
    ) {
      throw new Error("ADVANCE_NOT_REPAYABLE");
    }
    const principalMinor =
      record.state === "REPAID" || record.state === "LIQUIDATED"
        ? 0
        : (record.remainingPrincipalMinor ?? record.authorization.amountMinor);
    return {
      advanceId: record.advanceId,
      state: record.state,
      payerAccountId: record.recipientAccountId,
      dueAt:
        record.maturityAt ?? positionMaturity(record.fundedAt ?? record.createdAt, record.termDays),
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

  private repaymentPacket(
    record: AdvanceRecord,
    funding: NonNullable<AdvanceRecord["funding"]>,
    repaymentId: string,
    amountMinor: number
  ) {
    const previousPrincipalMinor =
      record.remainingPrincipalMinor ?? record.authorization.amountMinor;
    const remainingPrincipalMinor = previousPrincipalMinor - amountMinor;
    return {
      repaymentId,
      advanceId: record.advanceId,
      payerAccountId: record.recipientAccountId,
      amountMinor,
      amountStableUnits: usdMinorToStableUnits(amountMinor),
      previousPrincipalMinor,
      remainingPrincipalMinor,
      noteTokenId: "version" in funding ? funding.note.tokenId : funding.noteTokenId,
      noteSerial: "version" in funding ? funding.note.serial : funding.noteSerial,
      issuanceSettlementTransactionId:
        "version" in funding ? funding.transactions.settlement.transactionId : funding.paymentTxId,
      collateralTokenId:
        "version" in funding && funding.version === 3 ? funding.collateral.tokenId : undefined,
      collateralSerial:
        "version" in funding && funding.version === 3 ? funding.collateral.serial : undefined,
      collateralEscrowAccountId:
        "version" in funding && funding.version === 3
          ? funding.collateral.escrowAccountId
          : undefined
    };
  }

  private positionView(record: AdvanceRecord): PositionView {
    if (!record.funding) throw new Error("POSITION_NOT_FUNDED");
    const fundedAt =
      record.fundedAt ??
      ("version" in record.funding
        ? record.funding.transactions.settlement.consensusTimestamp
        : record.funding.consensusTimestamp);
    const grant = record.grant ?? {
      assetSymbol: record.market.assetSymbol,
      companyIdentifier: record.market.assetSymbol,
      grantType: record.pricing.strikePriceMinor > 0 ? ("OPTION" as const) : ("RSU" as const),
      vestedUnits: this.legacyVestedUnits(record),
      strikePriceMinor: record.pricing.strikePriceMinor,
      referenceSharePriceMinor: record.pricing.referenceSharePriceMinor,
      valuationDate: record.pricing.evidenceDate,
      valuationSource:
        record.pricing.valuationSource === "PUBLIC_MARKET"
          ? ("PUBLIC_MARKET" as const)
          : ("SYNTHETIC" as const),
      transferRestricted: true as const,
      attestationCommitment: `sha256:${"0".repeat(64)}`
    };
    const remainingPrincipalMinor =
      record.remainingPrincipalMinor ??
      (record.state === "REPAID" || record.state === "LIQUIDATED"
        ? 0
        : record.authorization.amountMinor);
    return {
      advance: toCustomerAdvance({ ...record, grant }),
      grantSummary: {
        assetSymbol: grant.assetSymbol,
        grantType: grant.grantType,
        strikePriceMinor: grant.strikePriceMinor
      },
      originalPrincipalMinor: record.authorization.amountMinor,
      remainingPrincipalMinor,
      fundedAt,
      maturityAt: record.maturityAt ?? positionMaturity(fundedAt, record.termDays),
      liquidationPriceMinor: calculateLiquidationPriceMinor(remainingPrincipalMinor, grant),
      valuations:
        record.valuations && record.valuations.length > 0
          ? record.valuations
          : [
              {
                observedAt: new Date(record.market.priceUpdatedAt * 1000).toISOString(),
                priceUsdMinor: record.market.priceUsdMinor,
                source: record.market.source,
                kind: record.market.evidenceType === "PRIVATE_VALUATION" ? "VALUATION" : "LIVE",
                evidenceUrl: record.market.externalEvidenceUrl ?? null
              }
            ],
      collateral:
        record.collateral ??
        ("version" in record.funding && record.funding.version === 3
          ? record.funding.collateral
          : null)
    };
  }

  private legacyVestedUnits(record: AdvanceRecord): string {
    const perUnit = record.pricing.netValuePerOptionMinor;
    if (perUnit <= 0) return "0.000001";
    return (record.pricing.grossEquityValueMinor / perUnit).toFixed(6);
  }
}
