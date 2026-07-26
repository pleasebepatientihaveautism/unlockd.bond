import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DemoMarketProvider } from "../src/server/adapters/demo.js";
import { YahooPrivateMarketProvider } from "../src/server/adapters/yahoo-private-market.js";
import {
  parseYahooPrivateCompaniesPage,
  parseYahooPrivateCompaniesResponse,
  parseYahooPrivateCompanyCatalogueResponse,
  YahooPrivateCompanyClient
} from "../src/server/pricing/yahoo-private-client.js";

const whoopRecord = {
  ticker: "WHOO.PVT",
  companyName: "WHOOP",
  regularMarketPrice: { raw: 7.3, fmt: "7.30" },
  latestImpliedValuation: { raw: 6_563_111_936, fmt: "6.563B" },
  latestFundingDate: { raw: 1_774_915_200, fmt: "2026-03-30" },
  latestShareClass: "Series G-2",
  sector: "Consumer Goods"
};

function yahooPage(record: unknown = whoopRecord): string {
  const body = JSON.stringify(yahooResponse(record));
  const envelope = JSON.stringify({ status: 200, body });
  return `<html><script type="application/json" data-sveltekit-fetched data-url="https://query1.finance.yahoo.com/screener?scrIds=HIGHEST_VALUATION_PRIVATE_COMPANY">${envelope}</script></html>`;
}

function yahooResponse(record: unknown = whoopRecord): unknown {
  return { finance: { result: [{ records: [record] }] } };
}

describe("Yahoo Finance private-company parser", () => {
  it("extracts WHOOP per-share price separately from company valuation", () => {
    expect(parseYahooPrivateCompaniesPage(yahooPage(), "WHOO.PVT", 1_785_026_800)).toMatchObject({
      ticker: "WHOO.PVT",
      companyName: "WHOOP",
      priceUsd: 7.3,
      estimatedValuationUsd: 6_563_111_936,
      latestFundingDate: "2026-03-30",
      latestShareClass: "Series G-2",
      fetchedAt: 1_785_026_800
    });
  });

  it("parses the JSON response backing the Yahoo table", () => {
    expect(
      parseYahooPrivateCompaniesResponse(yahooResponse(), "WHOO.PVT", 1_785_026_800)
    ).toMatchObject({
      priceUsd: 7.3,
      estimatedValuationUsd: 6_563_111_936
    });
  });

  it("builds a selectable catalogue from every valid Yahoo private-company row", () => {
    const openAiRecord = {
      ...whoopRecord,
      ticker: "OPAI.PVT",
      companyName: "OpenAI",
      regularMarketPrice: { raw: 721.85, fmt: "721.85" }
    };
    const companies = parseYahooPrivateCompanyCatalogueResponse(
      { finance: { result: [{ records: [openAiRecord, whoopRecord] }] } },
      1_785_026_800
    );
    expect(companies).toHaveLength(2);
    expect(companies.map((company) => company.ticker)).toEqual(["OPAI.PVT", "WHOO.PVT"]);
  });

  it("caches the page and maps WHOOP price into market evidence", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "unlockd-yahoo-"));
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(yahooResponse()), {
          status: 200,
          headers: {
            "content-type": "application/json",
            date: new Date().toUTCString()
          }
        })
    );
    const client = new YahooPrivateCompanyClient({
      cacheFile: path.join(directory, "quote.json"),
      cacheTtlSeconds: 900,
      fetchImpl
    });
    const provider = new YahooPrivateMarketProvider(new DemoMarketProvider(), client);

    const first = await provider.snapshot("WHOO.PVT");
    const cached = await provider.snapshot("WHOO.PVT");

    expect(first).toMatchObject({
      source: "yahoo-finance-private",
      priceUsdMinor: 730,
      estimatedValuationUsdMinor: 656_311_193_600,
      latestFundingDate: "2026-03-30",
      simulated: false
    });
    expect(cached.externalEvidenceLabel).toContain("hit");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the requested private company has no quoted price", () => {
    expect(() =>
      parseYahooPrivateCompaniesPage(
        yahooPage({ ...whoopRecord, regularMarketPrice: {} }),
        "WHOO.PVT"
      )
    ).toThrow("YAHOO_PRIVATE_PRICE_MISSING");
  });
});
