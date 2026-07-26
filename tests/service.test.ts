import { describe, expect, it } from "vitest";
import type { RepaymentResult } from "../src/domain/schemas.js";
import { FallbackCompanyFinancialProvider } from "../src/server/adapters/company-financials.js";
import {
  DemoMarketProvider,
  DemoPaymentProvider,
  DemoRiskProvider
} from "../src/server/adapters/demo.js";
import type {
  FundingPacket,
  FundingProgressRecorder,
  PaymentProvider,
  RepaymentPacket,
  RepaymentProgressRecorder
} from "../src/server/adapters/types.js";
import type { AppConfig } from "../src/server/config.js";
import { UnlockdBondService } from "../src/server/service.js";
import { MemoryAdvanceStore } from "../src/server/store.js";
import { privateRequestFixture, requestFixture, testConfig } from "./fixtures.js";

function service() {
  return new UnlockdBondService({
    config: testConfig(),
    store: new MemoryAdvanceStore(),
    market: new DemoMarketProvider(),
    companyFinancials: new FallbackCompanyFinancialProvider(),
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
    expect(result.advance.recipientAccountId).toBe("0.0.9750175");
    const publicJson = JSON.stringify(result.advance);
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

  it("evaluates a private-company option grant from vested equity only", async () => {
    const result = await service().evaluate(privateRequestFixture());
    expect(result.advance.state).toBe("AUTHORIZED");
    expect(result.advance.market).toMatchObject({
      assetSymbol: "WHOO.PVT",
      evidenceType: "PRIVATE_VALUATION",
      source: "issuer-valuation",
      valuationBasis: "Synthetic 409A common-share FMV"
    });
    expect(result.advance.authorization).toMatchObject({
      amountMinor: 150_000,
      eligibleEquityValueMinor: 7_200_000,
      policyMaxMinor: 5_040_000,
      marketHaircutBps: 0
    });
    expect(result.advance.pricing).toMatchObject({
      referenceSharePriceMinor: 480,
      strikePriceMinor: 120,
      netValuePerOptionMinor: 360,
      grossEquityValueMinor: 7_200_000,
      eligibleEquityValueMinor: 7_200_000,
      poolUpsideShareBps: 3500,
      valuationSource: "EMPLOYEE_409A"
    });
    expect(result.advance.risk.reasonCodes).toContain("EQUITY_LTV_70_PERCENT");
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

  it("repays full principal, retires the note, and replays the same repayment id", async () => {
    const instance = service();
    const evaluated = await instance.evaluate(requestFixture());
    const confirmationToken = evaluated.confirmationToken ?? "";
    const funded = await instance.fund(evaluated.advance.advanceId, confirmationToken);
    expect(funded.advance.state).toBe("FUNDED");

    const repaymentId = "ub_rp_service_repayment_123";
    const repaid = await instance.repay(
      evaluated.advance.advanceId,
      repaymentId,
      confirmationToken
    );
    expect(repaid.idempotentReplay).toBe(false);
    expect(repaid.advance).toMatchObject({
      state: "REPAID",
      repaymentId,
      repayment: {
        version: 1,
        repaymentId,
        remainingPrincipalMinor: 0,
        note: { retired: true },
        simulated: true
      },
      repaymentProgress: {
        stage: "REPAID",
        repaymentId
      }
    });

    const replay = await instance.repay(
      evaluated.advance.advanceId,
      repaymentId,
      confirmationToken
    );
    expect(replay.idempotentReplay).toBe(true);
    await expect(
      instance.repay(
        evaluated.advance.advanceId,
        "ub_rp_different_repayment_456",
        confirmationToken
      )
    ).rejects.toThrow("ADVANCE_ALREADY_REPAID");
  });

  it("makes a partial repayment failure terminal for automatic execution", async () => {
    class PartiallyFailingRepaymentProvider extends DemoPaymentProvider {
      override async repay(
        packet: RepaymentPacket,
        recordProgress?: RepaymentProgressRecorder
      ): Promise<never> {
        await recordProgress?.({
          version: 1,
          repaymentId: packet.repaymentId,
          stage: "AUTHORIZED",
          transactions: {
            authorization: {
              transactionId: "0.0.9750175@1785000000.000000002",
              consensusTimestamp: "1785000002.000000002",
              consensusStatus: "SUCCESS",
              mirrorUrl:
                "https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.9750175-1785000000-000000002",
              hashscanUrl: "https://hashscan.io/testnet/transaction/1785000002.000000002"
            }
          },
          authorizationSequenceNumber: "43"
        });
        throw new Error("HEDERA_REPAYMENT_SETTLEMENT_FAILED");
      }
    }

    const instance = new UnlockdBondService({
      config: testConfig(),
      store: new MemoryAdvanceStore(),
      market: new DemoMarketProvider(),
      companyFinancials: new FallbackCompanyFinancialProvider(),
      risk: new DemoRiskProvider(),
      payment: new PartiallyFailingRepaymentProvider()
    });
    const evaluated = await instance.evaluate(requestFixture());
    const token = evaluated.confirmationToken ?? "";
    await instance.fund(evaluated.advance.advanceId, token);
    await expect(
      instance.repay(evaluated.advance.advanceId, "ub_rp_partial_failure_123", token)
    ).rejects.toThrow("HEDERA_REPAYMENT_SETTLEMENT_FAILED");
    const failed = await instance.get(evaluated.advance.advanceId);
    expect(failed).toMatchObject({
      state: "REPAYMENT_REVIEW_REQUIRED",
      failureCode: "HEDERA_REPAYMENT_SETTLEMENT_FAILED",
      repaymentProgress: {
        stage: "AUTHORIZED",
        authorizationSequenceNumber: "43"
      }
    });
    await expect(
      instance.repay(evaluated.advance.advanceId, "ub_rp_partial_failure_123", token)
    ).rejects.toThrow("REPAYMENT_REVIEW_REQUIRED");
  });

  it("rejects a changed configured repayment payer", async () => {
    const config = testConfig();
    const instance = new UnlockdBondService({
      config,
      store: new MemoryAdvanceStore(),
      market: new DemoMarketProvider(),
      companyFinancials: new FallbackCompanyFinancialProvider(),
      risk: new DemoRiskProvider(),
      payment: new DemoPaymentProvider()
    });
    const evaluated = await instance.evaluate(requestFixture());
    const token = evaluated.confirmationToken ?? "";
    await instance.fund(evaluated.advance.advanceId, token);
    config.HEDERA_RECIPIENT_ID = "0.0.999999";
    await expect(
      instance.repay(evaluated.advance.advanceId, "ub_rp_payer_changed_123", token)
    ).rejects.toThrow("REPAYMENT_PAYER_CONFIG_CHANGED");
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
      companyFinancials: new FallbackCompanyFinancialProvider(),
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

  it("persists partial consensus evidence when a later funding stage fails", async () => {
    class PartiallyFailingPaymentProvider implements PaymentProvider {
      async fund(_packet: FundingPacket, recordProgress?: FundingProgressRecorder): Promise<never> {
        await recordProgress?.({
          version: 2,
          stage: "AUTHORIZED",
          transactions: {
            authorization: {
              transactionId: "0.0.9750175@1785000000.000000001",
              consensusTimestamp: "1785000001.000000001",
              consensusStatus: "SUCCESS",
              mirrorUrl:
                "https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.9750175-1785000000-000000001",
              hashscanUrl: "https://hashscan.io/testnet/transaction/1785000001.000000001"
            }
          },
          authorizationSequenceNumber: "42"
        });
        throw new Error("HTS_MINT_FAILED");
      }

      async ready(): Promise<boolean> {
        return true;
      }

      async repay(
        _packet: RepaymentPacket,
        _recordProgress?: RepaymentProgressRecorder
      ): Promise<RepaymentResult> {
        throw new Error("NOT_IMPLEMENTED");
      }
    }

    const instance = new UnlockdBondService({
      config: testConfig(),
      store: new MemoryAdvanceStore(),
      market: new DemoMarketProvider(),
      companyFinancials: new FallbackCompanyFinancialProvider(),
      risk: new DemoRiskProvider(),
      payment: new PartiallyFailingPaymentProvider()
    });
    const evaluated = await instance.evaluate(requestFixture());
    await expect(
      instance.fund(evaluated.advance.advanceId, evaluated.confirmationToken ?? "")
    ).rejects.toThrow("HTS_MINT_FAILED");
    const failed = await instance.get(evaluated.advance.advanceId);
    expect(failed).toMatchObject({
      state: "FUNDING_FAILED",
      failureCode: "HTS_MINT_FAILED",
      fundingProgress: {
        stage: "AUTHORIZED",
        authorizationSequenceNumber: "42"
      }
    });
  });
});
