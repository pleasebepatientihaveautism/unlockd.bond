import path from "node:path";
import {
  YAHOO_PRIVATE_COMPANIES_URL,
  YAHOO_PRIVATE_DATA_URL,
  YahooPrivateCompanyClient
} from "../src/server/pricing/yahoo-private-client.js";

const client = new YahooPrivateCompanyClient({
  pageUrl: process.env.YAHOO_PRIVATE_MARKET_URL ?? YAHOO_PRIVATE_COMPANIES_URL,
  dataUrl: process.env.YAHOO_PRIVATE_DATA_URL ?? YAHOO_PRIVATE_DATA_URL,
  cacheFile: path.resolve(
    process.env.YAHOO_PRIVATE_CACHE_FILE ?? "cache/yahoo-private-market.json"
  ),
  cacheTtlSeconds: Number(process.env.YAHOO_PRIVATE_CACHE_TTL_SECONDS ?? 900),
  timeoutMs: Number(process.env.YAHOO_PRIVATE_TIMEOUT_MS ?? 8_000)
});

const quote = await client.quote(process.argv[2] ?? "WHOO.PVT");
process.stdout.write(`${JSON.stringify(quote, null, 2)}\n`);
