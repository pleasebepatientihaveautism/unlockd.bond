import { createHash } from "node:crypto";
import {
  type AdvanceRequest,
  type AssetSymbol,
  type FundingResult,
  type MarketSnapshot,
  marketSnapshotSchema,
  type PrivateCompanyListing,
  type RiskDecision,
  type RiskReceipt
} from "../../domain/schemas.js";
import type {
  FundingPacket,
  FundingProgressRecorder,
  MarketProvider,
  PaymentProvider,
  RiskProvider
} from "./types.js";

const AAPL_TOKEN = "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9";
const AAPL_FEED = "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class DemoMarketProvider implements MarketProvider {
  async listPrivateCompanies(): Promise<PrivateCompanyListing[]> {
    const now = Math.floor(Date.now() / 1000);
    return [
      {
        ticker: "WHOO.PVT",
        companyName: "WHOOP",
        priceUsdMinor: 480,
        estimatedValuationUsdMinor: 3_600_000_000_00,
        latestFundingDate: null,
        latestShareClass: "Demo",
        sector: "Consumer Goods",
        priceUpdatedAt: now,
        source: "yahoo-finance-private",
        evidenceUrl: "https://finance.yahoo.com/markets/private-companies/highest-valuation/",
        cacheStatus: "stale"
      }
    ];
  }

  async snapshot(
    assetSymbol: AssetSymbol,
    grant?: AdvanceRequest["grant"]
  ): Promise<MarketSnapshot> {
    const now = Math.floor(Date.now() / 1000);
    if (assetSymbol.endsWith(".PVT")) {
      const valuationTimestamp = grant?.valuationDate
        ? Math.floor(Date.parse(`${grant.valuationDate}T00:00:00Z`) / 1000)
        : now - 30 * 24 * 60 * 60;
      return marketSnapshotSchema.parse({
        evidenceType: "PRIVATE_VALUATION",
        source: "issuer-valuation",
        network: "private-company",
        chainId: 0,
        assetSymbol,
        tokenAddress: null,
        feedAddress: null,
        priceUsdMinor: grant?.referenceSharePriceMinor ?? 480,
        priceUpdatedAt: valuationTimestamp,
        oraclePaused: false,
        sampleCount: 1,
        realizedVolatilityBps: 0,
        transferCount24h: 0,
        subgraphDeployment: "synthetic-409a-demo-v1",
        indexedBlock: 1,
        indexedBlockHash: `0x${digest("whoop-synthetic-valuation-evidence")}`,
        indexedBlockTimestamp: valuationTimestamp,
        hasIndexingErrors: false,
        valuationBasis: "Synthetic 409A common-share FMV",
        externalEvidenceLabel: `${assetSymbol} synthetic private-company valuation`,
        simulated: true
      });
    }

    return marketSnapshotSchema.parse({
      evidenceType: "PUBLIC_MARKET",
      source: "the-graph",
      network: "robinhood",
      chainId: 4663,
      assetSymbol: "AAPL",
      tokenAddress: AAPL_TOKEN,
      feedAddress: AAPL_FEED,
      priceUsdMinor: 21347,
      priceUpdatedAt: now - 22,
      oraclePaused: false,
      sampleCount: 30,
      realizedVolatilityBps: 4200,
      transferCount24h: 83,
      subgraphDeployment: "demo-not-a-qualifying-graph-deployment",
      indexedBlock: 12_345_678,
      indexedBlockHash: `0x${digest("unlockd-bond-demo-block")}`,
      indexedBlockTimestamp: now - 18,
      hasIndexingErrors: false,
      valuationBasis: "Public AAPL market price",
      externalEvidenceLabel: null,
      simulated: true
    });
  }

  async ready(): Promise<boolean> {
    return true;
  }
}

export class DemoRiskProvider implements RiskProvider {
  async evaluate(
    request: AdvanceRequest,
    market: MarketSnapshot,
    policyMaxMinor: number
  ): Promise<{ decision: RiskDecision; receipt: RiskReceipt }> {
    const privateCompany = market.evidenceType === "PRIVATE_VALUATION";
    const volatilityHaircutBps = privateCompany
      ? 0
      : Math.min(2500, Math.floor((market.realizedVolatilityBps ?? 0) / 3));
    const recommendedAdvanceMinor = Math.min(request.request.amountMinor, policyMaxMinor);
    return {
      decision: {
        schemaVersion: "unlockd-bond-risk-v1",
        decision: recommendedAdvanceMinor < request.request.amountMinor ? "counter" : "approve",
        riskBand: volatilityHaircutBps > 1300 ? "MEDIUM" : "LOW",
        recommendedAdvanceMinor,
        volatilityHaircutBps,
        liquidityHaircutBps: privateCompany ? 0 : market.transferCount24h < 20 ? 1400 : 700,
        reasonCodes: [
          "SYNTHETIC_PROFILE",
          "VESTED_VALUE_SUFFICIENT",
          privateCompany ? "EQUITY_LTV_70_PERCENT" : "MARKET_VOLATILITY_ELEVATED"
        ],
        assumptions: [
          privateCompany
            ? "70% LTV applied to vested shares at the Yahoo private-company reference price"
            : "Synthetic hackathon evaluation; not a lending decision"
        ]
      },
      receipt: {
        requestId: `demo_req_${digest(request.requestId).slice(0, 16)}`,
        provider: "demo-provider",
        model: "deterministic-demo-risk-v1",
        trustMode: "private",
        teeVerified: false,
        independentlyVerified: null,
        simulated: true
      }
    };
  }

  async ready(): Promise<boolean> {
    return true;
  }
}

export class DemoPaymentProvider implements PaymentProvider {
  async fund(
    packet: FundingPacket,
    recordProgress?: FundingProgressRecorder
  ): Promise<FundingResult> {
    const baseTimestamp = Math.floor(Date.now() / 1000);
    const simulatedTransaction = (stage: string) => ({
      transactionId: `simulated:${stage}:${digest(packet.advanceId).slice(0, 16)}`,
      consensusTimestamp: new Date().toISOString(),
      consensusStatus: "SIMULATED" as const,
      mirrorUrl: "https://testnet.mirrornode.hedera.com/",
      hashscanUrl: "https://hashscan.io/testnet"
    });
    const serial = String(Number.parseInt(digest(packet.advanceId).slice(0, 5), 16));
    const authorizationSequenceNumber = String(baseTimestamp);
    const fundedSequenceNumber = String(baseTimestamp + 1);
    const transactions = {
      authorization: simulatedTransaction("authorization"),
      noteMint: simulatedTransaction("note-mint"),
      settlement: simulatedTransaction("settlement"),
      fundedEvent: simulatedTransaction("funded-event")
    };
    await recordProgress?.({
      version: 2,
      stage: "FUNDED",
      transactions,
      noteSerial: serial,
      authorizationSequenceNumber,
      fundedSequenceNumber
    });
    return {
      version: 2,
      asset: {
        tokenId: "0.0.789011",
        name: "USDC DEMO",
        symbol: "USDC",
        decimals: 6,
        amountUnits: packet.amountStableUnits.toString(),
        amountMinor: packet.amountMinor,
        label: "Demo USDC — no real value",
        mirrorUrl: "https://testnet.mirrornode.hedera.com/",
        hashscanUrl: "https://hashscan.io/testnet"
      },
      note: {
        tokenId: "0.0.789012",
        serial,
        mirrorUrl: "https://testnet.mirrornode.hedera.com/",
        hashscanUrl: "https://hashscan.io/testnet"
      },
      topic: {
        topicId: "0.0.567890",
        authorizationSequenceNumber,
        fundedSequenceNumber,
        hashscanUrl: "https://hashscan.io/testnet"
      },
      transactions,
      simulated: true
    };
  }

  async ready(): Promise<boolean> {
    return true;
  }
}
