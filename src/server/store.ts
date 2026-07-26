import type { ValuationObservation } from "../domain/positions.js";
import { positionMaturity, positionTimestampToIso } from "../domain/positions.js";
import type { AdvanceRecord, AdvanceState } from "../domain/public.js";

export interface AdvanceStore {
  reserve(record: AdvanceRecord): Promise<{ record: AdvanceRecord; created: boolean }>;
  get(advanceId: string): Promise<AdvanceRecord | null>;
  listByOwner(ownerSessionHash: string): Promise<AdvanceRecord[]>;
  beginFunding(
    advanceId: string,
    confirmationTokenHash: string,
    now: Date
  ): Promise<{ record: AdvanceRecord; acquired: boolean }>;
  completeFunding(
    advanceId: string,
    funding: NonNullable<AdvanceRecord["funding"]>
  ): Promise<AdvanceRecord>;
  recordFundingProgress(
    advanceId: string,
    progress: NonNullable<AdvanceRecord["fundingProgress"]>
  ): Promise<AdvanceRecord>;
  failFunding(advanceId: string, failureCode: string): Promise<AdvanceRecord>;
  beginRepayment(
    advanceId: string,
    repaymentId: string,
    confirmationTokenHash: string
  ): Promise<{ record: AdvanceRecord; acquired: boolean }>;
  beginPositionRepayment(
    advanceId: string,
    repaymentId: string,
    ownerSessionHash: string,
    amountMinor: number
  ): Promise<{ record: AdvanceRecord; acquired: boolean }>;
  recordRepaymentProgress(
    advanceId: string,
    progress: NonNullable<AdvanceRecord["repaymentProgress"]>
  ): Promise<AdvanceRecord>;
  completeRepayment(
    advanceId: string,
    repayment: NonNullable<AdvanceRecord["repayment"]>
  ): Promise<AdvanceRecord>;
  failRepayment(advanceId: string, failureCode: string): Promise<AdvanceRecord>;
  beginLiquidation(
    advanceId: string,
    liquidationId: string,
    ownerSessionHash: string
  ): Promise<{ record: AdvanceRecord; acquired: boolean }>;
  recordLiquidationProgress(
    advanceId: string,
    progress: NonNullable<AdvanceRecord["liquidationProgress"]>
  ): Promise<AdvanceRecord>;
  completeLiquidation(
    advanceId: string,
    liquidation: NonNullable<AdvanceRecord["liquidation"]>
  ): Promise<AdvanceRecord>;
  failLiquidation(advanceId: string, failureCode: string): Promise<AdvanceRecord>;
  appendValuation(advanceId: string, observation: ValuationObservation): Promise<AdvanceRecord>;
  ping(): Promise<boolean>;
}

export class MemoryAdvanceStore implements AdvanceStore {
  private readonly records = new Map<string, AdvanceRecord>();

  async reserve(record: AdvanceRecord): Promise<{ record: AdvanceRecord; created: boolean }> {
    const existing = [...this.records.values()].find((item) => item.requestId === record.requestId);
    if (existing) return { record: structuredClone(existing), created: false };
    this.records.set(record.advanceId, structuredClone(record));
    return { record: structuredClone(record), created: true };
  }

  async get(advanceId: string): Promise<AdvanceRecord | null> {
    const record = this.records.get(advanceId);
    return record ? structuredClone(record) : null;
  }

  async listByOwner(ownerSessionHash: string): Promise<AdvanceRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.ownerSessionHash === ownerSessionHash)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((record) => structuredClone(record));
  }

  async beginFunding(
    advanceId: string,
    confirmationTokenHash: string,
    now: Date
  ): Promise<{ record: AdvanceRecord; acquired: boolean }> {
    const record = this.records.get(advanceId);
    if (!record) throw new StoreError("ADVANCE_NOT_FOUND");
    if (record.confirmationTokenHash !== confirmationTokenHash) {
      throw new StoreError("CONFIRMATION_TOKEN_INVALID");
    }
    if (new Date(record.expiresAt) <= now) throw new StoreError("AUTHORIZATION_EXPIRED");
    if (record.state === "FUNDED" || record.state === "FUNDING") {
      return { record: structuredClone(record), acquired: false };
    }
    if (record.state !== "AUTHORIZED") {
      throw new StoreError("ADVANCE_NOT_FUNDABLE");
    }
    record.state = "FUNDING";
    record.fundingProgress = null;
    record.failureCode = null;
    return { record: structuredClone(record), acquired: true };
  }

  async completeFunding(
    advanceId: string,
    funding: NonNullable<AdvanceRecord["funding"]>
  ): Promise<AdvanceRecord> {
    const record = this.records.get(advanceId);
    if (!record) throw new StoreError("ADVANCE_NOT_FOUND");
    const fundedAt = positionTimestampToIso(
      "version" in funding
        ? funding.transactions.settlement.consensusTimestamp
        : funding.consensusTimestamp
    );
    record.state = "FUNDED";
    record.funding = structuredClone(funding);
    record.fundedAt = fundedAt;
    record.maturityAt = positionMaturity(fundedAt, record.termDays);
    record.remainingPrincipalMinor = record.authorization.amountMinor;
    record.collateral = "version" in funding && funding.version === 3 ? funding.collateral : null;
    record.fundingProgress = null;
    record.failureCode = null;
    return structuredClone(record);
  }

  async recordFundingProgress(
    advanceId: string,
    progress: NonNullable<AdvanceRecord["fundingProgress"]>
  ): Promise<AdvanceRecord> {
    const record = this.records.get(advanceId);
    if (!record) throw new StoreError("ADVANCE_NOT_FOUND");
    if (record.state !== "FUNDING") throw new StoreError("FUNDING_PROGRESS_NOT_ALLOWED");
    record.fundingProgress = structuredClone(progress);
    return structuredClone(record);
  }

  async failFunding(advanceId: string, failureCode: string): Promise<AdvanceRecord> {
    return this.update(advanceId, "FUNDING_FAILED", null, failureCode);
  }

  async beginRepayment(
    advanceId: string,
    repaymentId: string,
    confirmationTokenHash: string
  ): Promise<{ record: AdvanceRecord; acquired: boolean }> {
    const record = this.records.get(advanceId);
    if (!record) throw new StoreError("ADVANCE_NOT_FOUND");
    if (record.confirmationTokenHash !== confirmationTokenHash) {
      throw new StoreError("CONFIRMATION_TOKEN_INVALID");
    }
    if (record.state === "REPAID") {
      if (record.repaymentId !== repaymentId) throw new StoreError("ADVANCE_ALREADY_REPAID");
      return { record: structuredClone(record), acquired: false };
    }
    if (record.state === "REPAYMENT_PENDING") {
      if (record.repaymentId !== repaymentId) throw new StoreError("REPAYMENT_ALREADY_PENDING");
      return { record: structuredClone(record), acquired: false };
    }
    if (record.state === "REPAYMENT_REVIEW_REQUIRED") {
      throw new StoreError("REPAYMENT_REVIEW_REQUIRED");
    }
    if (record.state !== "FUNDED" || !record.funding) {
      throw new StoreError("ADVANCE_NOT_REPAYABLE");
    }
    record.state = "REPAYMENT_PENDING";
    record.repaymentId = repaymentId;
    record.repayment = null;
    record.repaymentProgress = null;
    record.failureCode = null;
    return { record: structuredClone(record), acquired: true };
  }

  async beginPositionRepayment(
    advanceId: string,
    repaymentId: string,
    ownerSessionHash: string,
    amountMinor: number
  ): Promise<{ record: AdvanceRecord; acquired: boolean }> {
    const record = this.records.get(advanceId);
    if (!record) throw new StoreError("ADVANCE_NOT_FOUND");
    if (record.ownerSessionHash !== ownerSessionHash) throw new StoreError("POSITION_NOT_FOUND");
    const remaining = record.remainingPrincipalMinor ?? record.authorization.amountMinor;
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > remaining) {
      throw new StoreError("REPAYMENT_AMOUNT_INVALID");
    }
    if (record.state === "REPAYMENT_PENDING") {
      if (record.repaymentId !== repaymentId) throw new StoreError("REPAYMENT_ALREADY_PENDING");
      return { record: structuredClone(record), acquired: false };
    }
    if (record.repayments?.some((entry) => entry.repaymentId === repaymentId)) {
      return { record: structuredClone(record), acquired: false };
    }
    if (record.state !== "FUNDED" || !record.funding) {
      throw new StoreError("ADVANCE_NOT_REPAYABLE");
    }
    record.state = "REPAYMENT_PENDING";
    record.repaymentId = repaymentId;
    record.repaymentProgress = null;
    record.failureCode = null;
    return { record: structuredClone(record), acquired: true };
  }

  async recordRepaymentProgress(
    advanceId: string,
    progress: NonNullable<AdvanceRecord["repaymentProgress"]>
  ): Promise<AdvanceRecord> {
    const record = this.records.get(advanceId);
    if (!record) throw new StoreError("ADVANCE_NOT_FOUND");
    if (record.state !== "REPAYMENT_PENDING") {
      throw new StoreError("REPAYMENT_PROGRESS_NOT_ALLOWED");
    }
    if (record.repaymentId !== progress.repaymentId) {
      throw new StoreError("REPAYMENT_ID_MISMATCH");
    }
    record.repaymentProgress = structuredClone(progress);
    return structuredClone(record);
  }

  async completeRepayment(
    advanceId: string,
    repayment: NonNullable<AdvanceRecord["repayment"]>
  ): Promise<AdvanceRecord> {
    const record = this.records.get(advanceId);
    if (!record) throw new StoreError("ADVANCE_NOT_FOUND");
    if (record.state !== "REPAYMENT_PENDING" || record.repaymentId !== repayment.repaymentId) {
      throw new StoreError("REPAYMENT_COMPLETION_NOT_ALLOWED");
    }
    const previousPrincipalMinor =
      repayment.version === 2
        ? repayment.previousPrincipalMinor
        : (record.remainingPrincipalMinor ?? record.authorization.amountMinor);
    const remainingPrincipalMinor = repayment.version === 2 ? repayment.remainingPrincipalMinor : 0;
    record.state = remainingPrincipalMinor === 0 ? "REPAID" : "FUNDED";
    record.repayment = structuredClone(repayment);
    record.remainingPrincipalMinor = remainingPrincipalMinor;
    record.repayments = [
      ...(record.repayments ?? []),
      {
        repaymentId: repayment.repaymentId,
        amountMinor: repayment.asset.amountMinor,
        previousPrincipalMinor,
        remainingPrincipalMinor,
        createdAt: new Date().toISOString(),
        result: structuredClone(repayment)
      }
    ];
    record.repaymentProgress = null;
    record.failureCode = null;
    return structuredClone(record);
  }

  async failRepayment(advanceId: string, failureCode: string): Promise<AdvanceRecord> {
    const record = this.records.get(advanceId);
    if (!record) throw new StoreError("ADVANCE_NOT_FOUND");
    if (record.state !== "REPAYMENT_PENDING") {
      throw new StoreError("REPAYMENT_FAILURE_NOT_ALLOWED");
    }
    record.state = "REPAYMENT_REVIEW_REQUIRED";
    record.failureCode = failureCode;
    return structuredClone(record);
  }

  async beginLiquidation(
    advanceId: string,
    liquidationId: string,
    ownerSessionHash: string
  ): Promise<{ record: AdvanceRecord; acquired: boolean }> {
    const record = this.records.get(advanceId);
    if (!record) throw new StoreError("ADVANCE_NOT_FOUND");
    if (record.ownerSessionHash !== ownerSessionHash) throw new StoreError("POSITION_NOT_FOUND");
    if (record.state === "LIQUIDATED") {
      if (record.liquidationId !== liquidationId)
        throw new StoreError("ADVANCE_ALREADY_LIQUIDATED");
      return { record: structuredClone(record), acquired: false };
    }
    if (record.state === "LIQUIDATION_PENDING") {
      if (record.liquidationId !== liquidationId) {
        throw new StoreError("LIQUIDATION_ALREADY_PENDING");
      }
      return { record: structuredClone(record), acquired: false };
    }
    if (record.state !== "FUNDED") throw new StoreError("ADVANCE_NOT_LIQUIDATABLE");
    record.state = "LIQUIDATION_PENDING";
    record.liquidationId = liquidationId;
    record.liquidationProgress = null;
    record.failureCode = null;
    return { record: structuredClone(record), acquired: true };
  }

  async recordLiquidationProgress(
    advanceId: string,
    progress: NonNullable<AdvanceRecord["liquidationProgress"]>
  ): Promise<AdvanceRecord> {
    const record = this.records.get(advanceId);
    if (!record) throw new StoreError("ADVANCE_NOT_FOUND");
    if (record.state !== "LIQUIDATION_PENDING" || record.liquidationId !== progress.liquidationId) {
      throw new StoreError("LIQUIDATION_PROGRESS_NOT_ALLOWED");
    }
    record.liquidationProgress = structuredClone(progress);
    return structuredClone(record);
  }

  async completeLiquidation(
    advanceId: string,
    liquidation: NonNullable<AdvanceRecord["liquidation"]>
  ): Promise<AdvanceRecord> {
    const record = this.records.get(advanceId);
    if (!record) throw new StoreError("ADVANCE_NOT_FOUND");
    if (
      record.state !== "LIQUIDATION_PENDING" ||
      record.liquidationId !== liquidation.liquidationId
    ) {
      throw new StoreError("LIQUIDATION_COMPLETION_NOT_ALLOWED");
    }
    record.state = "LIQUIDATED";
    record.remainingPrincipalMinor = 0;
    record.liquidation = structuredClone(liquidation);
    record.liquidationProgress = null;
    record.failureCode = null;
    return structuredClone(record);
  }

  async failLiquidation(advanceId: string, failureCode: string): Promise<AdvanceRecord> {
    const record = this.records.get(advanceId);
    if (!record) throw new StoreError("ADVANCE_NOT_FOUND");
    if (record.state !== "LIQUIDATION_PENDING") {
      throw new StoreError("LIQUIDATION_FAILURE_NOT_ALLOWED");
    }
    record.state = "LIQUIDATION_REVIEW_REQUIRED";
    record.failureCode = failureCode;
    return structuredClone(record);
  }

  async appendValuation(
    advanceId: string,
    observation: ValuationObservation
  ): Promise<AdvanceRecord> {
    const record = this.records.get(advanceId);
    if (!record) throw new StoreError("ADVANCE_NOT_FOUND");
    record.valuations = [...(record.valuations ?? []), structuredClone(observation)];
    return structuredClone(record);
  }

  async ping(): Promise<boolean> {
    return true;
  }

  private async update(
    advanceId: string,
    state: AdvanceState,
    funding: AdvanceRecord["funding"],
    failureCode: string | null,
    fundingProgress: AdvanceRecord["fundingProgress"] | undefined = undefined
  ): Promise<AdvanceRecord> {
    const record = this.records.get(advanceId);
    if (!record) throw new StoreError("ADVANCE_NOT_FOUND");
    record.state = state;
    record.funding = funding;
    if (fundingProgress !== undefined) record.fundingProgress = fundingProgress;
    record.failureCode = failureCode;
    return structuredClone(record);
  }
}

export class StoreError extends Error {}
