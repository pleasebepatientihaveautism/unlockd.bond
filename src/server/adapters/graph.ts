import { type MarketSnapshot, marketSnapshotSchema } from "../../domain/schemas.js";
import type { MarketProvider } from "./types.js";

interface GraphConfig {
  endpoint: string;
  apiKey: string;
}

interface GraphResponse {
  data?: {
    stockToken?: {
      tokenAddress: string;
      feedAddress: string;
      oraclePaused: boolean;
      latestPriceUsdMinor: string;
      latestUpdatedAt: string;
    } | null;
    priceSamples?: Array<{
      timestamp: string;
      priceUsdMinor: string;
    }>;
    transfers?: Array<{ id: string }>;
    _meta?: {
      deployment: string;
      hasIndexingErrors: boolean;
      block: { number: number; hash: string; timestamp: number };
    };
  };
  errors?: Array<{ message: string }>;
}

const query = `
  query UnlockdBondMarketRisk($asset: ID!, $since: Int!) {
    stockToken(id: $asset) {
      tokenAddress
      feedAddress
      oraclePaused
      latestPriceUsdMinor
      latestUpdatedAt
    }
    priceSamples(first: 168, orderBy: timestamp, orderDirection: desc,
      where: { asset: $asset, timestamp_gte: $since }) {
      timestamp
      priceUsdMinor
    }
    transfers(first: 1000, where: { asset: $asset, timestamp_gte: $since }) { id }
    _meta { deployment hasIndexingErrors block { number hash timestamp } }
  }
`;

function volatilityBps(prices: number[]): number | null {
  if (prices.length < 2) return null;
  const returns = prices.slice(1).map((price, index) => {
    const previous = prices[index];
    if (previous === undefined) throw new Error("GRAPH_PRICE_SERIES_INVALID");
    return Math.log(previous / price);
  });
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  return Math.round(Math.sqrt(variance) * Math.sqrt(365 * 24) * 10_000);
}

export class GraphMarketProvider implements MarketProvider {
  constructor(private readonly config: GraphConfig) {}

  async snapshot(assetSymbol: "AAPL"): Promise<MarketSnapshot> {
    const now = Math.floor(Date.now() / 1000);
    const response = await fetch(this.config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        query,
        variables: { asset: assetSymbol, since: now - 24 * 60 * 60 }
      }),
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok) throw new Error(`GRAPH_HTTP_${response.status}`);
    const body = (await response.json()) as GraphResponse;
    if (body.errors?.length) throw new Error("GRAPH_QUERY_FAILED");
    const stock = body.data?.stockToken;
    const meta = body.data?._meta;
    if (!stock || !meta) throw new Error("GRAPH_EVIDENCE_MISSING");
    const prices = (body.data?.priceSamples ?? []).map((sample) =>
      Number.parseInt(sample.priceUsdMinor, 10)
    );
    return marketSnapshotSchema.parse({
      source: "the-graph",
      network: "robinhood",
      chainId: 4663,
      assetSymbol,
      tokenAddress: stock.tokenAddress,
      feedAddress: stock.feedAddress,
      priceUsdMinor: Number.parseInt(stock.latestPriceUsdMinor, 10),
      priceUpdatedAt: Number.parseInt(stock.latestUpdatedAt, 10),
      oraclePaused: stock.oraclePaused,
      sampleCount: prices.length,
      realizedVolatilityBps: volatilityBps(prices),
      transferCount24h: body.data?.transfers?.length ?? 0,
      subgraphDeployment: meta.deployment,
      indexedBlock: meta.block.number,
      indexedBlockHash: meta.block.hash,
      indexedBlockTimestamp: meta.block.timestamp,
      hasIndexingErrors: meta.hasIndexingErrors,
      simulated: false
    });
  }

  async ready(): Promise<boolean> {
    try {
      await this.snapshot("AAPL");
      return true;
    } catch {
      return false;
    }
  }
}
