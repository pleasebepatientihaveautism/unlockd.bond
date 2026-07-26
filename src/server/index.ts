import "dotenv/config";
import path from "node:path";
import { Pool } from "pg";
import pino from "pino";
import { FallbackCompanyFinancialProvider } from "./adapters/company-financials.js";
import { DemoMarketProvider, DemoPaymentProvider, DemoRiskProvider } from "./adapters/demo.js";
import { GraphMarketProvider } from "./adapters/graph.js";
import { HederaPaymentProvider } from "./adapters/hedera.js";
import { YahooPrivateMarketProvider } from "./adapters/yahoo-private-market.js";
import { ZeroGRiskProvider } from "./adapters/zero-g.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PostgresAdvanceStore } from "./postgres-store.js";
import { PersistentApiBudget } from "./pricing/api-budget.js";
import { CompanyFileCache } from "./pricing/company-cache.js";
import { CoresignalCompanyClient } from "./pricing/coresignal-client.js";
import { YahooPrivateCompanyClient } from "./pricing/yahoo-private-client.js";
import { UnlockdBondService } from "./service.js";
import { MemoryAdvanceStore } from "./store.js";

const config = loadConfig();
const logger = pino({
  level: config.NODE_ENV === "production" ? "info" : "debug",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.body",
      "*.confirmationToken",
      "*.apiKey",
      "*.privateKey",
      "*.key"
    ],
    censor: "[REDACTED]"
  }
});

const pool = config.DATABASE_URL
  ? new Pool({
      connectionString: config.DATABASE_URL,
      ssl: config.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000
    })
  : null;
const store = pool ? new PostgresAdvanceStore(pool) : new MemoryAdvanceStore();
const liveValue = (value: string | undefined, name: string): string => {
  if (!value) throw new Error(`LIVE_CONFIG_MISSING:${name}`);
  return value;
};
const baseMarket =
  config.mode !== "live"
    ? new DemoMarketProvider()
    : new GraphMarketProvider({
        endpoint: liveValue(config.GRAPH_ENDPOINT, "GRAPH_ENDPOINT"),
        apiKey: liveValue(config.GRAPH_API_KEY, "GRAPH_API_KEY")
      });
const market = new YahooPrivateMarketProvider(
  baseMarket,
  new YahooPrivateCompanyClient({
    pageUrl: config.YAHOO_PRIVATE_MARKET_URL,
    dataUrl: config.YAHOO_PRIVATE_DATA_URL,
    cacheFile: path.resolve(config.YAHOO_PRIVATE_CACHE_FILE),
    cacheTtlSeconds: config.YAHOO_PRIVATE_CACHE_TTL_SECONDS,
    timeoutMs: config.YAHOO_PRIVATE_TIMEOUT_MS
  })
);
const companyFinancials =
  config.CORESIGNAL_API_KEY && config.CORESIGNAL_COLLECT_URL_TEMPLATE
    ? new CoresignalCompanyClient({
        apiKey: config.CORESIGNAL_API_KEY,
        collectUrlTemplate: config.CORESIGNAL_COLLECT_URL_TEMPLATE,
        cache: new CompanyFileCache(
          path.resolve(config.CORESIGNAL_CACHE_DIR),
          config.CORESIGNAL_CACHE_TTL_SECONDS
        ),
        budget: new PersistentApiBudget(
          path.resolve(config.CORESIGNAL_USAGE_FILE),
          config.CORESIGNAL_MAX_CALLS,
          config.CORESIGNAL_RESERVED_CALLS
        )
      })
    : new FallbackCompanyFinancialProvider();
const risk =
  config.mode !== "live"
    ? new DemoRiskProvider()
    : new ZeroGRiskProvider({
        apiKey: liveValue(config.ZEROG_API_KEY, "ZEROG_API_KEY"),
        model: config.ZEROG_MODEL,
        routerUrl: config.ZEROG_ROUTER_URL
      });
const payment =
  config.mode === "demo"
    ? new DemoPaymentProvider()
    : new HederaPaymentProvider({
        operatorId: liveValue(config.HEDERA_OPERATOR_ID, "HEDERA_OPERATOR_ID"),
        operatorKey: liveValue(config.HEDERA_OPERATOR_KEY, "HEDERA_OPERATOR_KEY"),
        treasuryId: liveValue(config.HEDERA_TREASURY_ID, "HEDERA_TREASURY_ID"),
        treasuryKey: liveValue(config.HEDERA_TREASURY_KEY, "HEDERA_TREASURY_KEY"),
        supplyKey: liveValue(config.HEDERA_SUPPLY_KEY, "HEDERA_SUPPLY_KEY"),
        poolId: liveValue(config.HEDERA_POOL_ID, "HEDERA_POOL_ID"),
        poolKey: liveValue(config.HEDERA_POOL_KEY, "HEDERA_POOL_KEY"),
        topicId: liveValue(config.HEDERA_TOPIC_ID, "HEDERA_TOPIC_ID"),
        tokenId: liveValue(config.HEDERA_TOKEN_ID, "HEDERA_TOKEN_ID"),
        stableTokenId: liveValue(config.HEDERA_STABLE_TOKEN_ID, "HEDERA_STABLE_TOKEN_ID"),
        collateralTokenId:
          config.HEDERA_COLLATERAL_TOKEN_ID ?? liveValue(config.HEDERA_TOKEN_ID, "HEDERA_TOKEN_ID"),
        escrowId:
          config.HEDERA_ESCROW_ID ?? liveValue(config.HEDERA_OPERATOR_ID, "HEDERA_OPERATOR_ID"),
        escrowKey:
          config.HEDERA_ESCROW_KEY ?? liveValue(config.HEDERA_OPERATOR_KEY, "HEDERA_OPERATOR_KEY"),
        collateralEnabled: Boolean(
          config.HEDERA_COLLATERAL_TOKEN_ID && config.HEDERA_ESCROW_ID && config.HEDERA_ESCROW_KEY
        ),
        recipientId: config.HEDERA_RECIPIENT_ID,
        mirrorUrl: config.HEDERA_MIRROR_URL,
        treasuryStableReserveMinor: config.TREASURY_STABLE_RESERVE_MINOR,
        requireTeeVerification: config.mode === "live"
      });
const service = new UnlockdBondService({
  config,
  store,
  market,
  companyFinancials,
  risk,
  payment
});
const app = createApp({ config, logger, service });
const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, mode: config.mode }, "unlockd.bond listening");
});

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.close(async () => {
    await pool?.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
