import { describe, expect, it } from "vitest";
import {
  DemoMarketProvider,
  DemoPaymentProvider,
  DemoRiskProvider
} from "../src/server/adapters/demo.js";
import { encodeMetadata } from "../src/server/adapters/hedera.js";
import type { PaymentProvider } from "../src/server/adapters/types.js";
import type { AppConfig } from "../src/server/config.js";
import { UnlockdBondService } from "../src/server/service.js";
import { MemoryAdvanceStore } from "../src/server/store.js";
import { requestFixture, testConfig } from "./fixtures.js";

function hederaDemo(payment: PaymentProvider) {
  const config = {
    ...testConfig(),
    APP_MODE: "hedera-demo",
    mode: "hedera-demo"
  } as AppConfig;
  return new UnlockdBondService({
    config,
    store: new MemoryAdvanceStore(),
    market: new DemoMarketProvider(),
    risk: new DemoRiskProvider(),
    payment
  });
}

describe("Hedera consensus funding gate", () => {
  it("encodes a deterministic privacy-safe NFT commitment below Hedera's 100-byte limit", () => {
    const packet = {
      advanceId: `ub_${"a".repeat(32)}`,
      recipientAccountId: "0.0.9750175",
      amountTinybar: 1_000_000n,
      employeeCommitment: `sha256:${"b".repeat(64)}`,
      decisionCommitment: `sha256:${"c".repeat(64)}`,
      marketCommitment: `sha256:${"d".repeat(64)}`,
      graphBlock: 1,
      graphDeployment: "synthetic-demo",
      zeroGRequestId: "demo-request",
      zeroGProvider: "demo-provider",
      zeroGTeeVerified: false
    };
    const metadata = encodeMetadata(packet);
    expect(metadata).toHaveLength(49);
    expect(metadata[0]).toBe(1);
    expect(encodeMetadata(packet)).toEqual(metadata);
    expect(new TextDecoder().decode(metadata)).not.toContain(packet.advanceId);
  });

  it("never marks an advance FUNDED from a simulated receipt", async () => {
    const instance = hederaDemo(new DemoPaymentProvider());
    const evaluated = await instance.evaluate(requestFixture());
    await expect(
      instance.fund(evaluated.advance.advanceId, evaluated.confirmationToken ?? "")
    ).rejects.toThrow("HEDERA_CONSENSUS_SUCCESS_REQUIRED");
    const failed = await instance.get(evaluated.advance.advanceId);
    expect(failed?.state).toBe("FUNDING_FAILED");
    expect(failed?.funding).toBeNull();
  });

  it("marks an advance FUNDED only with a real consensus SUCCESS result", async () => {
    const demo = new DemoPaymentProvider();
    const payment: PaymentProvider = {
      ready: async () => true,
      fund: async (packet) => ({
        ...(await demo.fund(packet)),
        consensusStatus: "SUCCESS",
        simulated: false
      })
    };
    const instance = hederaDemo(payment);
    const evaluated = await instance.evaluate(requestFixture());
    const funded = await instance.fund(
      evaluated.advance.advanceId,
      evaluated.confirmationToken ?? ""
    );
    expect(funded.advance.state).toBe("FUNDED");
    expect(funded.advance.funding).toMatchObject({
      consensusStatus: "SUCCESS",
      simulated: false
    });
  });
});
