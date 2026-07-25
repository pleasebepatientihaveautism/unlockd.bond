import type { Pool, PoolClient } from "pg";
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
         confirmation_token_hash, record
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
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
      const record = { ...row.record, state: "FUNDING" as const, failureCode: null };
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
    return this.update(advanceId, (record) => ({
      ...record,
      state: "FUNDED",
      funding,
      failureCode: null
    }));
  }

  async failFunding(advanceId: string, failureCode: string): Promise<AdvanceRecord> {
    return this.update(advanceId, (record) => ({
      ...record,
      state: "FUNDING_FAILED",
      failureCode
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
