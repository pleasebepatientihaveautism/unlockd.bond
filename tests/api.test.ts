import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { FallbackCompanyFinancialProvider } from "../src/server/adapters/company-financials.js";
import {
  DemoMarketProvider,
  DemoPaymentProvider,
  DemoRiskProvider
} from "../src/server/adapters/demo.js";
import { createApp } from "../src/server/app.js";
import { UnlockdBondService } from "../src/server/service.js";
import { MemoryAdvanceStore } from "../src/server/store.js";
import { requestFixture, testConfig } from "./fixtures.js";

function app() {
  const config = testConfig();
  const service = new UnlockdBondService({
    config,
    store: new MemoryAdvanceStore(),
    market: new DemoMarketProvider(),
    companyFinancials: new FallbackCompanyFinancialProvider(),
    risk: new DemoRiskProvider(),
    payment: new DemoPaymentProvider()
  });
  return createApp({ config, service, logger: pino({ enabled: false }) });
}

describe("HTTP API", () => {
  it("serves liveness and readiness without secrets", async () => {
    const health = await request(app()).get("/api/health").expect(200);
    expect(health.body).toEqual({ status: "ok", mode: "demo", service: "unlockd-bond" });
    const ready = await request(app()).get("/api/ready").expect(200);
    expect(ready.body.checks).toEqual({
      store: true,
      market: true,
      companyFinancials: true,
      risk: true,
      payment: true
    });
  });

  it("requires matching idempotency key", async () => {
    await request(app())
      .post("/api/advances/evaluate")
      .set("Idempotency-Key", "wrong")
      .send(requestFixture())
      .expect(422, { error: "IDEMPOTENCY_KEY_MISMATCH" });
  });

  it("evaluates and funds the synthetic flow", async () => {
    const server = app();
    const input = requestFixture();
    const evaluated = await request(server)
      .post("/api/advances/evaluate")
      .set("Idempotency-Key", input.requestId)
      .send(input)
      .expect(201);
    expect(evaluated.body.advance.state).toBe("AUTHORIZED");
    expect(evaluated.body.advance.pricing).toMatchObject({
      referenceSharePriceMinor: 21_347,
      companyRiskSource: "fallback_default"
    });
    const publicProof = await request(server)
      .get(`/api/advances/${evaluated.body.advance.advanceId}`)
      .expect(200);
    expect(publicProof.body.advance).not.toHaveProperty("pricing");
    const funded = await request(server)
      .post(`/api/advances/${evaluated.body.advance.advanceId}/fund`)
      .send({ confirmationToken: evaluated.body.confirmationToken })
      .expect(200);
    expect(funded.body.advance.state).toBe("FUNDED");
  });

  it("rejects an untrusted mutation origin", async () => {
    const input = requestFixture();
    const response = await request(app())
      .post("/api/advances/evaluate")
      .set("Origin", "https://evil.example")
      .set("Idempotency-Key", input.requestId)
      .send(input)
      .expect(403);
    expect(response.body.error).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("returns field-safe validation errors", async () => {
    const input = { ...requestFixture(), recipientAccountId: "bad" };
    const response = await request(app())
      .post("/api/advances/evaluate")
      .set("Idempotency-Key", input.requestId)
      .send(input)
      .expect(422);
    expect(response.body.error).toBe("VALIDATION_FAILED");
    expect(JSON.stringify(response.body)).not.toContain("650000");
  });
});
