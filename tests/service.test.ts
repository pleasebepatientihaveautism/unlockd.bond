import { describe, expect, it } from "vitest";
import {
  DemoMarketProvider,
  DemoPaymentProvider,
  DemoRiskProvider
} from "../src/server/adapters/demo.js";
import type { PaymentProvider } from "../src/server/adapters/types.js";
import type { AppConfig } from "../src/server/config.js";
import { UnlockdBondService } from "../src/server/service.js";
import { MemoryAdvanceStore } from "../src/server/store.js";
import { privateRequestFixture, requestFixture, testConfig } from "./fixtures.js";

function service() {
  return new UnlockdBondService({
    config: testConfig(),
    store: new MemoryAdvanceStore(),
    market: new DemoMarketProvider(),
    risk: new DemoRiskProvider(),
    payment: new DemoPaymentProvider()
  });
}

describe("unlockd.bond service", () => {
  it("evaluates without exposing raw employee data", async () => {
    const result = await service().evaluate(requestFixture());
    expect(result.advance.state).toBe("AUTHORIZED");
    expect(result.confirmationToken).toHaveLength(43);
    expect(result.advance).not.toHaveProperty("confirmationTokenHash");
    expect(result.advance).not.toHaveProperty("commitmentNonces");
    const publicJson = JSON.stringify(result.advance);
    expect(publicJson).not.toContain("monthlyNetIncomeMinor");
    expect(publicJson).not.toContain("vestedUnits");
    expect(publicJson).not.toContain("employeeRef");
    expect(publicJson).not.toContain("Synthetic hackathon evaluation");
  });

  it("replays the same request idempotently", async () => {
    const instance = service();
    const first = await instance.evaluate(requestFixture());
    const second = await instance.evaluate(requestFixture());
    expect(second.idempotentReplay).toBe(true);
    expect(second.advance.advanceId).toBe(first.advance.advanceId);
    expect(second.confirmationToken).toBe(first.confirmationToken);
  });

  it("evaluates a private WHOOP option grant with private-company evidence", async () => {
    const result = await service().evaluate(privateRequestFixture());
    expect(result.advance.state).toBe("AUTHORIZED");
    expect(result.advance.market).toMatchObject({
      assetSymbol: "WHOOP",
      evidenceType: "PRIVATE_VALUATION",
      source: "issuer-valuation",
      valuationBasis: "Synthetic 409A common-share FMV"
    });
    expect(result.advance.authorization).toMatchObject({
      amountMinor: 150_000,
      eligibleEquityValueMinor: 2_160_000,
      marketHaircutBps: 7000
    });
    expect(result.advance.risk.reasonCodes).toContain("PRIVATE_COMPANY_ILLIQUID");
  });

  it("funds exactly the authorized demo record", async () => {
    const instance = service();
    const evaluated = await instance.evaluate(requestFixture());
    expect(evaluated.confirmationToken).not.toBeNull();
    const confirmationToken = evaluated.confirmationToken ?? "";
    const funded = await instance.fund(evaluated.advance.advanceId, confirmationToken);
    expect(funded.advance.state).toBe("FUNDED");
    expect(funded.advance.funding?.simulated).toBe(true);
    const replay = await instance.fund(evaluated.advance.advanceId, confirmationToken);
    expect(replay.idempotentReplay).toBe(true);
  });

  it("never marks a Hedera demo funded without consensus SUCCESS", async () => {
    const config = {
      ...testConfig(),
      APP_MODE: "hedera-demo",
      mode: "hedera-demo"
    } as AppConfig;
    const instance = new UnlockdBondService({
      config,
      store: new MemoryAdvanceStore(),
      market: new DemoMarketProvider(),
      risk: new DemoRiskProvider(),
      payment: new DemoPaymentProvider() as PaymentProvider
    });
    const evaluated = await instance.evaluate(requestFixture());
    await expect(
      instance.fund(evaluated.advance.advanceId, evaluated.confirmationToken ?? "")
    ).rejects.toThrow("HEDERA_CONSENSUS_SUCCESS_REQUIRED");
    const failed = await instance.get(evaluated.advance.advanceId);
    expect(failed?.state).toBe("FUNDING_FAILED");
    expect(failed?.funding).toBeNull();
  });
});
