import { describe, expect, it } from "vitest";
import type { AdvanceRecord } from "../src/domain/public.js";
import { MemoryAdvanceStore } from "../src/server/store.js";

const record = {
  advanceId: "vp_advance",
  requestId: "ub_req_idempotent",
  state: "AUTHORIZED",
  mode: "demo",
  recipientAccountId: "0.0.653284",
  termDays: 30,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  employeeCommitment: `sha256:${"a".repeat(64)}`,
  decisionCommitment: `sha256:${"b".repeat(64)}`,
  marketCommitment: `sha256:${"c".repeat(64)}`,
  commitmentNonces: {
    employee: "nonce-employee",
    decision: "nonce-decision",
    market: "nonce-market"
  },
  confirmationTokenHash: "token-hash",
  market: {},
  risk: {},
  riskReceipt: {},
  authorization: { amountMinor: 1000 },
  funding: null,
  fundingProgress: null,
  failureCode: null
} as unknown as AdvanceRecord;

describe("advance store", () => {
  it("reserves one record per request id", async () => {
    const store = new MemoryAdvanceStore();
    expect((await store.reserve(record)).created).toBe(true);
    expect(
      (
        await store.reserve({
          ...record,
          advanceId: "vp_duplicate"
        })
      ).created
    ).toBe(false);
  });

  it("acquires funding only once", async () => {
    const store = new MemoryAdvanceStore();
    await store.reserve(record);
    expect((await store.beginFunding(record.advanceId, "token-hash", new Date())).acquired).toBe(
      true
    );
    expect((await store.beginFunding(record.advanceId, "token-hash", new Date())).acquired).toBe(
      false
    );
  });

  it("rejects an invalid confirmation digest", async () => {
    const store = new MemoryAdvanceStore();
    await store.reserve(record);
    await expect(store.beginFunding(record.advanceId, "wrong", new Date())).rejects.toThrow(
      "CONFIRMATION_TOKEN_INVALID"
    );
  });

  it("does not automatically retry an ambiguous failed funding action", async () => {
    const store = new MemoryAdvanceStore();
    await store.reserve(record);
    await store.failFunding(record.advanceId, "PARTNER_OPERATION_FAILED");
    await expect(store.beginFunding(record.advanceId, "token-hash", new Date())).rejects.toThrow(
      "ADVANCE_NOT_FUNDABLE"
    );
  });
});
