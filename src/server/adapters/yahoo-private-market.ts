import { createHash } from "node:crypto";
import type { AdvanceRequest, AssetSymbol, MarketSnapshot } from "../../domain/schemas.js";
import { marketSnapshotSchema } from "../../domain/schemas.js";
import type { YahooPrivateCompanyClient } from "../pricing/yahoo-private-client.js";
import type { MarketProvider } from "./types.js";

const WHOOP_TICKER = "WHOO.PVT";

function evidenceHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class YahooPrivateMarketProvider implements MarketProvider {
  constructor(
    private readonly delegate: MarketProvider,
    private readonly client: YahooPrivateCompanyClient
  ) {}

  async snapshot(
    assetSymbol: AssetSymbol,
    grant?: AdvanceRequest["grant"]
  ): Promise<MarketSnapshot> {
    if (assetSymbol !== "WHOOP") return this.delegate.snapshot(assetSymbol, grant);

    const quote = await this.client.quote(WHOOP_TICKER);
    const priceUsdMinor = Math.round(quote.priceUsd * 100);
    const estimatedValuationUsdMinor = quote.estimatedValuationUsd
      ? Math.round(quote.estimatedValuationUsd * 100)
      : null;

    return marketSnapshotSchema.parse({
      evidenceType: "PRIVATE_VALUATION",
      source: "yahoo-finance-private",
      network: "private-company",
      chainId: 0,
      assetSymbol: "WHOOP",
      tokenAddress: null,
      feedAddress: null,
      priceUsdMinor,
      priceUpdatedAt: quote.fetchedAt,
      oraclePaused: false,
      sampleCount: 1,
      realizedVolatilityBps: 0,
      transferCount24h: 0,
      subgraphDeployment: "yahoo-private-companies-table-v1",
      indexedBlock: 1,
      indexedBlockHash: `0x${evidenceHash(quote)}`,
      indexedBlockTimestamp: quote.fetchedAt,
      hasIndexingErrors: false,
      valuationBasis: "Yahoo Finance private-market price",
      externalEvidenceLabel: `${quote.companyName} · ${quote.ticker} · ${quote.cacheStatus}`,
      externalEvidenceUrl: quote.sourceUrl,
      estimatedValuationUsdMinor,
      latestFundingDate: quote.latestFundingDate,
      simulated: false
    });
  }

  async ready(): Promise<boolean> {
    return this.delegate.ready();
  }
}
