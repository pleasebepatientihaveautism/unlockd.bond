import type { AdvanceRecord, AdvanceState } from "../domain/public.js";

export interface AdvanceStore {
  reserve(record: AdvanceRecord): Promise<{ record: AdvanceRecord; created: boolean }>;
  get(advanceId: string): Promise<AdvanceRecord | null>;
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
    return this.update(advanceId, "FUNDED", funding, null, null);
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
