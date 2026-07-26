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

function app(config = testConfig()) {
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
  it("requires operator authorization for non-demo settlement mutations", async () => {
    const settlementSecret = "settlement-authorization-secret-at-least-thirty-two-characters";
    const config = {
      ...testConfig(),
      APP_MODE: "hedera-demo" as const,
      mode: "hedera-demo" as const,
      SETTLEMENT_AUTH_SECRET: settlementSecret
    };
    const server = app(config);

    await request(server).post("/api/advances/ub_test/fund").send({}).expect(403, {
      error: "SETTLEMENT_AUTH_REQUIRED"
    });
    await request(server)
      .post("/api/advances/ub_test/fund")
      .set("Authorization", "Bearer wrong-secret")
      .send({})
      .expect(403, { error: "SETTLEMENT_AUTH_REQUIRED" });
    await request(server)
      .post("/api/advances/ub_test/fund")
      .set("Authorization", `Bearer ${settlementSecret}`)
      .send({})
      .expect(422);
    await request(server)
      .post("/api/advances/ub_test/fund")
      .send({ confirmationToken: "route-confirmation-capability-at-least-thirty-two-characters" })
      .expect(404, { error: "ADVANCE_NOT_FOUND" });
  });

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

  it("serves the private-company catalogue", async () => {
    const response = await request(app()).get("/api/market/private-companies").expect(200);
    expect(response.body.companies[0]).toMatchObject({
      ticker: "WHOO.PVT",
      priceUsdMinor: 480,
      source: "yahoo-finance-private"
    });
    expect(response.headers["cache-control"]).toBe("public, max-age=60");
  });

  it("publishes the Demo USDC disclosure without settlement secrets", async () => {
    const response = await request(app()).get("/api/config").expect(200);
    expect(response.body.payoutAsset).toEqual({
      name: "USDC DEMO",
      symbol: "USDC",
      decimals: 6,
      tokenId: null,
      label: "Demo USDC — no real value"
    });
    expect(response.body).not.toHaveProperty("recipientAccountId");
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
    const payoff = await request(server)
      .get(`/api/advances/${evaluated.body.advance.advanceId}/payoff`)
      .expect(200);
    expect(payoff.body.payoff).toMatchObject({
      principalMinor: input.request.amountMinor,
      interestMinor: 0,
      feesMinor: 0,
      totalMinor: input.request.amountMinor,
      amountUnits: String(input.request.amountMinor * 10_000)
    });
  });

  it("repays a funded advance with a matching idempotency key", async () => {
    const server = app();
    const input = requestFixture();
    const evaluated = await request(server)
      .post("/api/advances/evaluate")
      .set("Idempotency-Key", input.requestId)
      .send(input)
      .expect(201);
    await request(server)
      .post(`/api/advances/${evaluated.body.advance.advanceId}/fund`)
      .send({ confirmationToken: evaluated.body.confirmationToken })
      .expect(200);

    const repaymentId = "ub_rp_api_repayment_123";
    const repaid = await request(server)
      .post(`/api/advances/${evaluated.body.advance.advanceId}/repay`)
      .set("Idempotency-Key", repaymentId)
      .send({
        repaymentId,
        confirmationToken: evaluated.body.confirmationToken
      })
      .expect(200);
    expect(repaid.body.advance).toMatchObject({
      state: "REPAID",
      repaymentId,
      repayment: {
        repaymentId,
        remainingPrincipalMinor: 0,
        note: { retired: true }
      }
    });

    const replay = await request(server)
      .post(`/api/advances/${evaluated.body.advance.advanceId}/repay`)
      .set("Idempotency-Key", repaymentId)
      .send({
        repaymentId,
        confirmationToken: evaluated.body.confirmationToken
      })
      .expect(200);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  it("isolates session positions and supports partial repayment plus demo liquidation", async () => {
    const server = app();
    const owner = request.agent(server);
    const stranger = request.agent(server);
    const input = requestFixture({
      requestId: "ub_req_position_lifecycle_123",
      request: { amountMinor: 100_00, currency: "USD", termDays: 30 }
    });
    const evaluated = await owner
      .post("/api/advances/evaluate")
      .set("Idempotency-Key", input.requestId)
      .send(input)
      .expect(201);
    await owner
      .post(`/api/advances/${evaluated.body.advance.advanceId}/fund`)
      .send({ confirmationToken: evaluated.body.confirmationToken })
      .expect(200);

    const listed = await owner.get("/api/positions?status=open").expect(200);
    expect(listed.body.positions).toHaveLength(1);
    expect(listed.body.positions[0]).toMatchObject({
      remainingPrincipalMinor: 100_00,
      grantSummary: { grantType: "RSU" }
    });
    await stranger.get(`/api/positions/${evaluated.body.advance.advanceId}`).expect(404);

    const repaymentId = "ub_rp_position_partial_123";
    const partial = await owner
      .post(`/api/positions/${evaluated.body.advance.advanceId}/repay`)
      .set("Idempotency-Key", repaymentId)
      .send({ repaymentId, amountMinor: 40_00 })
      .expect(200);
    expect(partial.body.position).toMatchObject({
      remainingPrincipalMinor: 60_00,
      advance: { state: "FUNDED" }
    });
    expect(partial.body.position.liquidationPriceMinor).toBeLessThan(
      listed.body.positions[0].liquidationPriceMinor
    );

    const emulatedPriceMinor = partial.body.position.liquidationPriceMinor - 1;
    const preview = await owner
      .post(`/api/positions/${evaluated.body.advance.advanceId}/liquidation/preview`)
      .send({ emulatedPriceMinor })
      .expect(200);
    expect(preview.body.preview.wouldLiquidate).toBe(true);

    const liquidationId = "ub_liq_position_demo_123";
    const liquidated = await owner
      .post(`/api/positions/${evaluated.body.advance.advanceId}/liquidate`)
      .set("Idempotency-Key", liquidationId)
      .send({ liquidationId, emulatedPriceMinor })
      .expect(200);
    expect(liquidated.body.position).toMatchObject({
      remainingPrincipalMinor: 0,
      advance: { state: "LIQUIDATED" }
    });
    const closed = await owner.get("/api/positions?status=closed").expect(200);
    expect(closed.body.positions).toHaveLength(1);
  });

  it("rejects a repayment idempotency mismatch", async () => {
    await request(app())
      .post("/api/advances/ub_missing_12345678/repay")
      .set("Idempotency-Key", "ub_rp_header_12345678")
      .send({
        repaymentId: "ub_rp_body_12345678",
        confirmationToken: "x".repeat(32)
      })
      .expect(422, { error: "IDEMPOTENCY_KEY_MISMATCH" });
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

  it("allows loopback development origins on dynamic Vite ports", async () => {
    const input = requestFixture();
    await request(app())
      .post("/api/advances/evaluate")
      .set("Origin", "http://localhost:5175")
      .set("Idempotency-Key", input.requestId)
      .send(input)
      .expect(201);
  });

  it("rejects attempts to override the server-selected settlement recipient", async () => {
    const input = { ...requestFixture(), recipientAccountId: "0.0.123456" };
    const response = await request(app())
      .post("/api/advances/evaluate")
      .set("Idempotency-Key", input.requestId)
      .send(input)
      .expect(422);
    expect(response.body.error).toBe("VALIDATION_FAILED");
    expect(response.body.issues).toContainEqual({
      path: "",
      message: 'Unrecognized key: "recipientAccountId"'
    });
    expect(JSON.stringify(response.body)).not.toContain("vestedUnits");
  });
});
