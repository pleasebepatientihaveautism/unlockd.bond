import { z } from "zod";

const optionalUrl = z.preprocess((value) => (value === "" ? undefined : value), z.url().optional());
const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional()
);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  APP_MODE: z.enum(["demo", "hedera-demo", "live"]).default("demo"),
  PUBLIC_BASE_URL: z.url().default("http://localhost:5173"),
  ALLOWED_ORIGINS: z.string().default("http://localhost:5173,http://localhost:3000"),
  DATABASE_URL: optionalUrl,
  DATABASE_SSL: z.enum(["true", "false"]).default("false"),
  COMMITMENT_SECRET: z.string().min(32),
  CONFIRMATION_SECRET: z.string().min(32),
  GRAPH_ENDPOINT: optionalUrl,
  GRAPH_API_KEY: optionalString,
  GRAPH_ASSET_ID: z.literal("AAPL").default("AAPL"),
  GRAPH_MAX_AGE_SECONDS: z.coerce.number().int().min(30).max(3600).default(180),
  GRAPH_MIN_SAMPLES: z.coerce.number().int().min(1).max(1000).default(2),
  ZEROG_API_KEY: optionalString,
  ZEROG_MODEL: z.string().default("0gm-1.0-35b-a3b"),
  ZEROG_ROUTER_URL: z.url().default("https://router-api.0g.ai"),
  HEDERA_NETWORK: z.enum(["testnet"]).default("testnet"),
  HEDERA_OPERATOR_ID: optionalString,
  HEDERA_OPERATOR_KEY: optionalString,
  HEDERA_TREASURY_ID: optionalString,
  HEDERA_TREASURY_KEY: optionalString,
  HEDERA_SUPPLY_KEY: optionalString,
  HEDERA_POOL_ID: optionalString,
  HEDERA_TOPIC_ID: optionalString,
  HEDERA_TOKEN_ID: optionalString,
  HEDERA_MIRROR_URL: z.url().default("https://testnet.mirrornode.hedera.com"),
  PAYOUT_TINYBAR_PER_USD_MINOR: z.coerce.number().int().positive().default(10_000),
  POLICY_FIXED_CAP_MINOR: z.coerce.number().int().positive().default(200_000),
  TREASURY_RESERVE_TINYBAR: z.coerce.number().int().positive().default(100_000_000)
});

export type AppConfig = z.infer<typeof schema> & {
  mode: "demo" | "hedera-demo" | "live";
  allowedOrigins: string[];
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(source);
  const config = {
    ...parsed,
    mode: parsed.APP_MODE,
    allowedOrigins: parsed.ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  };
  if (config.mode !== "demo") {
    const hederaRequired = [
      "HEDERA_OPERATOR_ID",
      "HEDERA_OPERATOR_KEY",
      "HEDERA_TREASURY_ID",
      "HEDERA_TREASURY_KEY",
      "HEDERA_SUPPLY_KEY",
      "HEDERA_POOL_ID",
      "HEDERA_TOPIC_ID",
      "HEDERA_TOKEN_ID"
    ] as const;
    const missingHedera = hederaRequired.filter((key) => !config[key]);
    if (missingHedera.length > 0) {
      throw new Error(`HEDERA_CONFIG_MISSING:${missingHedera.join(",")}`);
    }
  }
  if (config.mode === "live") {
    const required = ["DATABASE_URL", "GRAPH_ENDPOINT", "GRAPH_API_KEY", "ZEROG_API_KEY"] as const;
    const missing = required.filter((key) => !config[key]);
    if (missing.length > 0) throw new Error(`LIVE_CONFIG_MISSING:${missing.join(",")}`);
  }
  return config;
}
