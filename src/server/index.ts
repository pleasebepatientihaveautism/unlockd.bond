import "dotenv/config";
import { Pool } from "pg";
import pino from "pino";
import { DemoMarketProvider, DemoPaymentProvider, DemoRiskProvider } from "./adapters/demo.js";
import { GraphMarketProvider } from "./adapters/graph.js";
import { HederaPaymentProvider } from "./adapters/hedera.js";
import { ZeroGRiskProvider } from "./adapters/zero-g.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PostgresAdvanceStore } from "./postgres-store.js";
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
const market =
  config.mode !== "live"
    ? new DemoMarketProvider()
    : new GraphMarketProvider({
        endpoint: liveValue(config.GRAPH_ENDPOINT, "GRAPH_ENDPOINT"),
        apiKey: liveValue(config.GRAPH_API_KEY, "GRAPH_API_KEY")
      });
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
        topicId: liveValue(config.HEDERA_TOPIC_ID, "HEDERA_TOPIC_ID"),
        tokenId: liveValue(config.HEDERA_TOKEN_ID, "HEDERA_TOKEN_ID"),
        mirrorUrl: config.HEDERA_MIRROR_URL,
        treasuryReserveTinybar: config.TREASURY_RESERVE_TINYBAR,
        requireTeeVerification: config.mode === "live"
      });
const service = new UnlockdBondService({ config, store, market, risk, payment });
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
