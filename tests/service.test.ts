import { describe, expect, it } from "vitest";
import {
  DemoMarketProvider,
  DemoPaymentProvider,
  DemoRiskProvider
} from "../src/server/adapters/demo.js";
import { UnlockdBondService } from "../src/server/service.js";
import { MemoryAdvanceStore } from "../src/server/store.js";
import { requestFixture, testConfig } from "./fixtures.js";

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
});
