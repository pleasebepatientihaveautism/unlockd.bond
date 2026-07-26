import "dotenv/config";
import path from "node:path";
import { calculateAdvancePricing, calculateCompanyRiskSignal } from "../src/domain/pricing.js";
import type { AdvanceRequest } from "../src/domain/schemas.js";
import { FallbackCompanyFinancialProvider } from "../src/server/adapters/company-financials.js";
import { DemoMarketProvider, DemoRiskProvider } from "../src/server/adapters/demo.js";
import type { CompanyFinancialProvider } from "../src/server/adapters/types.js";
import { YahooPrivateMarketProvider } from "../src/server/adapters/yahoo-private-market.js";
import { PersistentApiBudget } from "../src/server/pricing/api-budget.js";
import { CompanyFileCache } from "../src/server/pricing/company-cache.js";
import { CoresignalCompanyClient } from "../src/server/pricing/coresignal-client.js";
import {
  YAHOO_PRIVATE_COMPANIES_URL,
  YAHOO_PRIVATE_DATA_URL,
  YahooPrivateCompanyClient
} from "../src/server/pricing/yahoo-private-client.js";

const [companyIdentifier = "whoop.com", units = "20000", share = "4.80", amount = "1500"] =
  process.argv.slice(2);

const toMinor = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("INVALID_NUMERIC_ARGUMENT");
  return Math.round(parsed * 100);
};

const apiKey = process.env.CORESIGNAL_API_KEY;
const collectUrlTemplate = process.env.CORESIGNAL_COLLECT_URL_TEMPLATE;
const companyFinancials: CompanyFinancialProvider =
  apiKey && collectUrlTemplate
    ? new CoresignalCompanyClient({
        apiKey,
        collectUrlTemplate,
        cache: new CompanyFileCache(
          path.resolve(process.env.CORESIGNAL_CACHE_DIR ?? "cache/companies"),
          Number(process.env.CORESIGNAL_CACHE_TTL_SECONDS ?? 604_800)
        ),
        budget: new PersistentApiBudget(
          path.resolve(process.env.CORESIGNAL_USAGE_FILE ?? "api-usage.json"),
          Number(process.env.CORESIGNAL_MAX_CALLS ?? 100),
          Number(process.env.CORESIGNAL_RESERVED_CALLS ?? 10)
        )
      })
    : new FallbackCompanyFinancialProvider();

const valuationDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const request: AdvanceRequest = {
  requestId: "ub_req_pricing_check_2026",
  employeeRef: "ub_emp_pricing_check_2026",
  synthetic: true,
  grant: {
    assetSymbol: "WHOO.PVT",
    companyIdentifier,
    grantType: "RSU",
    vestedUnits: units,
    strikePriceMinor: 0,
    referenceSharePriceMinor: toMinor(share),
    valuationDate,
    valuationSource: "EMPLOYEE_409A",
    transferRestricted: true,
    attestationCommitment: `sha256:${"a".repeat(64)}`
  },
  request: {
    amountMinor: toMinor(amount),
    currency: "USD",
    termDays: 30
  }
};

const marketProvider = new YahooPrivateMarketProvider(
  new DemoMarketProvider(),
  new YahooPrivateCompanyClient({
    pageUrl: process.env.YAHOO_PRIVATE_MARKET_URL ?? YAHOO_PRIVATE_COMPANIES_URL,
    dataUrl: process.env.YAHOO_PRIVATE_DATA_URL ?? YAHOO_PRIVATE_DATA_URL,
    cacheFile: path.resolve(
      process.env.YAHOO_PRIVATE_CACHE_FILE ?? "cache/yahoo-private-market.json"
    ),
    cacheTtlSeconds: Number(process.env.YAHOO_PRIVATE_CACHE_TTL_SECONDS ?? 900),
    timeoutMs: Number(process.env.YAHOO_PRIVATE_TIMEOUT_MS ?? 8_000)
  })
);
const market = await marketProvider.snapshot("WHOO.PVT", request.grant);
const riskProvider = new DemoRiskProvider();
const { decision: risk } = await riskProvider.evaluate(
  request,
  market,
  request.request.amountMinor
);
const lookup = await companyFinancials.fetchCompanyFinancials(companyIdentifier);
const result = calculateAdvancePricing(request, market, risk, calculateCompanyRiskSignal(lookup), {
  fixedCapMinor: 200_000
});

process.stdout.write(
  `${JSON.stringify(
    {
      companyIdentifier,
      pricing: result.quote,
      authorization: result.authorization,
      companyData: {
        source: lookup.dataSource,
        cacheStatus: lookup.cacheStatus,
        remainingApiCalls: lookup.remainingApiCalls,
        fallbackReason: lookup.fallbackReason
      }
    },
    null,
    2
  )}\n`
);
