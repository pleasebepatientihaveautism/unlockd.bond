import type { Pool, PoolClient } from "pg";
import type { ValuationObservation } from "../domain/positions.js";
import { positionMaturity, positionTimestampToIso } from "../domain/positions.js";
import type { AdvanceRecord } from "../domain/public.js";
import { type AdvanceStore, StoreError } from "./store.js";

interface AdvanceRow {
  record: AdvanceRecord;
}

export class PostgresAdvanceStore implements AdvanceStore {
  constructor(private readonly pool: Pool) {}

  async reserve(record: AdvanceRecord): Promise<{ record: AdvanceRecord; created: boolean }> {
    const result = await this.pool.query<AdvanceRow>(
      `INSERT INTO advances (
         advance_id, request_id, state, mode, recipient_account_id, expires_at,
         confirmation_token_hash, owner_session_hash, record
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (request_id) DO NOTHING
       RETURNING record`,
      [
        record.advanceId,
        record.requestId,
        record.state,
        record.mode,
        record.recipientAccountId,
        record.expiresAt,
        record.confirmationTokenHash,
        record.ownerSessionHash ?? null,
        JSON.stringify(record)
      ]
    );
    if (result.rows[0]) return { record: result.rows[0].record, created: true };
    const existing = await this.pool.query<AdvanceRow>(
      "SELECT record FROM advances WHERE request_id = $1",
      [record.requestId]
    );
    if (!existing.rows[0]) throw new StoreError("ADVANCE_RESERVATION_FAILED");
    return { record: existing.rows[0].record, created: false };
  }

  async get(advanceId: string): Promise<AdvanceRecord | null> {
    const result = await this.pool.query<AdvanceRow>(
      "SELECT record FROM advances WHERE advance_id = $1",
      [advanceId]
    );
    return result.rows[0]?.record ?? null;
  }

  async listByOwner(ownerSessionHash: string): Promise<AdvanceRecord[]> {
    const result = await this.pool.query<AdvanceRow>(
      `SELECT record FROM advances
       WHERE owner_session_hash = $1
       ORDER BY created_at DESC`,
      [ownerSessionHash]
    );
    return result.rows.map((row) => row.record);
  }

  async beginFunding(
    advanceId: string,
    confirmationTokenHash: string,
    now: Date
  ): Promise<{ record: AdvanceRecord; acquired: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<
        AdvanceRow & {
          confirmation_token_hash: string;
          expires_at: Date;
        }
      >(
        `SELECT record, confirmation_token_hash, expires_at
         FROM advances WHERE advance_id = $1 FOR UPDATE`,
        [advanceId]
      );
      const row = result.rows[0];
      if (!row) throw new StoreError("ADVANCE_NOT_FOUND");
      if (row.confirmation_token_hash !== confirmationTokenHash) {
        throw new StoreError("CONFIRMATION_TOKEN_INVALID");
      }
      if (row.expires_at <= now) throw new StoreError("AUTHORIZATION_EXPIRED");
      if (row.record.state === "FUNDED" || row.record.state === "FUNDING") {
        await client.query("COMMIT");
        return { record: row.record, acquired: false };
      }
      if (row.record.state !== "AUTHORIZED") {
        throw new StoreError("ADVANCE_NOT_FUNDABLE");
      }
      const record = {
        ...row.record,
        state: "FUNDING" as const,
        fundingProgress: null,
        failureCode: null
      };
      await this.write(client, record);
      await client.query("COMMIT");
      return { record, acquired: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeFunding(
    advanceId: string,
    funding: NonNullable<AdvanceRecord["funding"]>
  ): Promise<AdvanceRecord> {
    return this.update(advanceId, (record) => {
      const fundedAt = positionTimestampToIso(
        "version" in funding
          ? funding.transactions.settlement.consensusTimestamp
          : funding.consensusTimestamp
      );
      return {
        ...record,
        state: "FUNDED",
        funding,
        fundedAt,
        maturityAt: positionMaturity(fundedAt, record.termDays),
        remainingPrincipalMinor: record.authorization.amountMinor,
        collateral: "version" in funding && funding.version === 3 ? funding.collateral : null,
        fundingProgress: null,
        failureCode: null
      };
    });
  }

  async recordFundingProgress(
    advanceId: string,
    progress: NonNullable<AdvanceRecord["fundingProgress"]>
  ): Promise<AdvanceRecord> {
    return this.update(advanceId, (record) => {
      if (record.state !== "FUNDING") throw new StoreError("FUNDING_PROGRESS_NOT_ALLOWED");
      return { ...record, fundingProgress: progress };
    });
  }

  async failFunding(advanceId: string, failureCode: string): Promise<AdvanceRecord> {
    return this.update(advanceId, (record) => ({
      ...record,
      state: "FUNDING_FAILED",
      failureCode
    }));
  }

  async beginRepayment(
    advanceId: string,
    repaymentId: string,
    confirmationTokenHash: string
  ): Promise<{ record: AdvanceRecord; acquired: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<
        AdvanceRow & {
          confirmation_token_hash: string;
        }
      >(
        `SELECT record, confirmation_token_hash
         FROM advances WHERE advance_id = $1 FOR UPDATE`,
        [advanceId]
      );
      const row = result.rows[0];
      if (!row) throw new StoreError("ADVANCE_NOT_FOUND");
      if (row.confirmation_token_hash !== confirmationTokenHash) {
        throw new StoreError("CONFIRMATION_TOKEN_INVALID");
      }
      if (row.record.state === "REPAID") {
        if (row.record.repaymentId !== repaymentId) throw new StoreError("ADVANCE_ALREADY_REPAID");
        await client.query("COMMIT");
        return { record: row.record, acquired: false };
      }
      if (row.record.state === "REPAYMENT_PENDING") {
        if (row.record.repaymentId !== repaymentId) {
          throw new StoreError("REPAYMENT_ALREADY_PENDING");
        }
        await client.query("COMMIT");
        return { record: row.record, acquired: false };
      }
      if (row.record.state === "REPAYMENT_REVIEW_REQUIRED") {
        throw new StoreError("REPAYMENT_REVIEW_REQUIRED");
      }
      if (row.record.state !== "FUNDED" || !row.record.funding) {
        throw new StoreError("ADVANCE_NOT_REPAYABLE");
      }
      const record: AdvanceRecord = {
        ...row.record,
        state: "REPAYMENT_PENDING",
        repaymentId,
        repayment: null,
        repaymentProgress: null,
        failureCode: null
      };
      await this.write(client, record);
      await client.query("COMMIT");
      return { record, acquired: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async beginPositionRepayment(
    advanceId: string,
    repaymentId: string,
    ownerSessionHash: string,
    amountMinor: number
  ): Promise<{ record: AdvanceRecord; acquired: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<AdvanceRow & { owner_session_hash: string | null }>(
        `SELECT record, owner_session_hash
         FROM advances WHERE advance_id = $1 FOR UPDATE`,
        [advanceId]
      );
      const row = result.rows[0];
      if (!row || row.owner_session_hash !== ownerSessionHash) {
        throw new StoreError("POSITION_NOT_FOUND");
      }
      const remaining = row.record.remainingPrincipalMinor ?? row.record.authorization.amountMinor;
      if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > remaining) {
        throw new StoreError("REPAYMENT_AMOUNT_INVALID");
      }
      if (row.record.state === "REPAYMENT_PENDING") {
        if (row.record.repaymentId !== repaymentId) {
          throw new StoreError("REPAYMENT_ALREADY_PENDING");
        }
        await client.query("COMMIT");
        return { record: row.record, acquired: false };
      }
      if (row.record.repayments?.some((entry) => entry.repaymentId === repaymentId)) {
        await client.query("COMMIT");
        return { record: row.record, acquired: false };
      }
      if (row.record.state !== "FUNDED" || !row.record.funding) {
        throw new StoreError("ADVANCE_NOT_REPAYABLE");
      }
      const record: AdvanceRecord = {
        ...row.record,
        state: "REPAYMENT_PENDING",
        repaymentId,
        repaymentProgress: null,
        failureCode: null
      };
      await this.write(client, record);
      await client.query("COMMIT");
      return { record, acquired: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordRepaymentProgress(
    advanceId: string,
    progress: NonNullable<AdvanceRecord["repaymentProgress"]>
  ): Promise<AdvanceRecord> {
    return this.update(advanceId, (record) => {
      if (record.state !== "REPAYMENT_PENDING") {
        throw new StoreError("REPAYMENT_PROGRESS_NOT_ALLOWED");
      }
      if (record.repaymentId !== progress.repaymentId) {
        throw new StoreError("REPAYMENT_ID_MISMATCH");
      }
      return { ...record, repaymentProgress: progress };
    });
  }

  async completeRepayment(
    advanceId: string,
    repayment: NonNullable<AdvanceRecord["repayment"]>
  ): Promise<AdvanceRecord> {
    return this.update(advanceId, (record) => {
      if (record.state !== "REPAYMENT_PENDING" || record.repaymentId !== repayment.repaymentId) {
        throw new StoreError("REPAYMENT_COMPLETION_NOT_ALLOWED");
      }
      const previousPrincipalMinor =
        repayment.version === 2
          ? repayment.previousPrincipalMinor
          : (record.remainingPrincipalMinor ?? record.authorization.amountMinor);
      const remainingPrincipalMinor =
        repayment.version === 2 ? repayment.remainingPrincipalMinor : 0;
      return {
        ...record,
        state: remainingPrincipalMinor === 0 ? "REPAID" : "FUNDED",
        repayment,
        repayments: [
          ...(record.repayments ?? []),
          {
            repaymentId: repayment.repaymentId,
            amountMinor: repayment.asset.amountMinor,
            previousPrincipalMinor,
            remainingPrincipalMinor,
            createdAt: new Date().toISOString(),
            result: repayment
          }
        ],
        remainingPrincipalMinor,
        repaymentProgress: null,
        failureCode: null
      };
    });
  }

  async failRepayment(advanceId: string, failureCode: string): Promise<AdvanceRecord> {
    return this.update(advanceId, (record) => {
      if (record.state !== "REPAYMENT_PENDING") {
        throw new StoreError("REPAYMENT_FAILURE_NOT_ALLOWED");
      }
      return {
        ...record,
        state: "REPAYMENT_REVIEW_REQUIRED",
        failureCode
      };
    });
  }

  async beginLiquidation(
    advanceId: string,
    liquidationId: string,
    ownerSessionHash: string
  ): Promise<{ record: AdvanceRecord; acquired: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<AdvanceRow & { owner_session_hash: string | null }>(
        `SELECT record, owner_session_hash
         FROM advances WHERE advance_id = $1 FOR UPDATE`,
        [advanceId]
      );
      const row = result.rows[0];
      if (!row || row.owner_session_hash !== ownerSessionHash) {
        throw new StoreError("POSITION_NOT_FOUND");
      }
      if (row.record.state === "LIQUIDATED") {
        if (row.record.liquidationId !== liquidationId) {
          throw new StoreError("ADVANCE_ALREADY_LIQUIDATED");
        }
        await client.query("COMMIT");
        return { record: row.record, acquired: false };
      }
      if (row.record.state === "LIQUIDATION_PENDING") {
        if (row.record.liquidationId !== liquidationId) {
          throw new StoreError("LIQUIDATION_ALREADY_PENDING");
        }
        await client.query("COMMIT");
        return { record: row.record, acquired: false };
      }
      if (row.record.state !== "FUNDED") throw new StoreError("ADVANCE_NOT_LIQUIDATABLE");
      const record: AdvanceRecord = {
        ...row.record,
        state: "LIQUIDATION_PENDING",
        liquidationId,
        liquidationProgress: null,
        failureCode: null
      };
      await this.write(client, record);
      await client.query("COMMIT");
      return { record, acquired: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordLiquidationProgress(
    advanceId: string,
    progress: NonNullable<AdvanceRecord["liquidationProgress"]>
  ): Promise<AdvanceRecord> {
    return this.update(advanceId, (record) => {
      if (
        record.state !== "LIQUIDATION_PENDING" ||
        record.liquidationId !== progress.liquidationId
      ) {
        throw new StoreError("LIQUIDATION_PROGRESS_NOT_ALLOWED");
      }
      return { ...record, liquidationProgress: progress };
    });
  }

  async completeLiquidation(
    advanceId: string,
    liquidation: NonNullable<AdvanceRecord["liquidation"]>
  ): Promise<AdvanceRecord> {
    return this.update(advanceId, (record) => {
      if (
        record.state !== "LIQUIDATION_PENDING" ||
        record.liquidationId !== liquidation.liquidationId
      ) {
        throw new StoreError("LIQUIDATION_COMPLETION_NOT_ALLOWED");
      }
      return {
        ...record,
        state: "LIQUIDATED",
        remainingPrincipalMinor: 0,
        liquidation,
        liquidationProgress: null,
        failureCode: null
      };
    });
  }

  async failLiquidation(advanceId: string, failureCode: string): Promise<AdvanceRecord> {
    return this.update(advanceId, (record) => {
      if (record.state !== "LIQUIDATION_PENDING") {
        throw new StoreError("LIQUIDATION_FAILURE_NOT_ALLOWED");
      }
      return { ...record, state: "LIQUIDATION_REVIEW_REQUIRED", failureCode };
    });
  }

  async appendValuation(
    advanceId: string,
    observation: ValuationObservation
  ): Promise<AdvanceRecord> {
    return this.update(advanceId, (record) => ({
      ...record,
      valuations: [...(record.valuations ?? []), observation]
    }));
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  private async update(
    advanceId: string,
    change: (record: AdvanceRecord) => AdvanceRecord
  ): Promise<AdvanceRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<AdvanceRow>(
        "SELECT record FROM advances WHERE advance_id = $1 FOR UPDATE",
        [advanceId]
      );
      const current = result.rows[0]?.record;
      if (!current) throw new StoreError("ADVANCE_NOT_FOUND");
      const next = change(current);
      await this.write(client, next);
      await client.query("COMMIT");
      return next;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async write(client: PoolClient, record: AdvanceRecord): Promise<void> {
    await client.query(
      `UPDATE advances SET state = $2, record = $3::jsonb, updated_at = now()
       WHERE advance_id = $1`,
      [record.advanceId, record.state, JSON.stringify(record)]
    );
  }
}
