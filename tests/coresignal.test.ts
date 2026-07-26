import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PersistentApiBudget } from "../src/server/pricing/api-budget.js";
import { CompanyFileCache } from "../src/server/pricing/company-cache.js";
import {
  CoresignalCompanyClient,
  mostRecentCompanyFinancials
} from "../src/server/pricing/coresignal-client.js";

const responseBody = {
  balance_sheets: [
    {
      period_end_date: "2024-12-31",
      preferred_stock: 100,
      common_stock: "900",
      total_assets: 10_000,
      shares_outstanding: null
    },
    {
      period_end_date: "2025-12-31",
      preferred_stock: 250,
      common_stock: "750",
      total_assets: 12_000,
      total_shares_outstanding: 4_000
    }
  ]
};

async function harness(maximumCalls = 100, reservedCalls = 10) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "unlockd-pricing-"));
  const usageFile = path.join(directory, "api-usage.json");
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(responseBody), { status: 200 }));
  const client = new CoresignalCompanyClient({
    apiKey: "test-key",
    collectUrlTemplate: "https://example.test/company/{companyIdentifier}",
    cache: new CompanyFileCache(path.join(directory, "companies"), 604_800),
    budget: new PersistentApiBudget(usageFile, maximumCalls, reservedCalls),
    fetchImpl
  });
  return { client, fetchImpl, usageFile, directory };
}

describe("Coresignal company client", () => {
  it("normalizes mixed financial field types and selects the latest ISO period", () => {
    expect(mostRecentCompanyFinancials(responseBody)).toMatchObject({
      preferredStock: 250,
      commonStock: 750,
      totalAssets: 12_000,
      sharesOutstanding: 4_000,
      asOfDate: "2025-12-31"
    });
  });

  it("makes one network call for repeated and concurrent company lookups", async () => {
    const { client, fetchImpl, usageFile } = await harness();
    const [first, concurrent] = await Promise.all([
      client.fetchCompanyFinancials("whoop.com"),
      client.fetchCompanyFinancials("WHOOP.COM")
    ]);
    const cached = await client.fetchCompanyFinancials("whoop.com");

    expect(first.dataSource).toBe("coresignal");
    expect(concurrent.dataSource).toBe("coresignal");
    expect(cached.cacheStatus).toBe("hit");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(await readFile(usageFile, "utf8")) as {
      attemptedCalls: number;
      successfulCalls: number;
    };
    expect(persisted).toMatchObject({ attemptedCalls: 1, successfulCalls: 1 });
  });

  it("preserves the final ten calls for the live demo", async () => {
    const { client, fetchImpl, usageFile } = await harness();
    await writeFile(
      usageFile,
      JSON.stringify({
        version: 1,
        attemptedCalls: 90,
        successfulCalls: 90,
        updatedAt: new Date().toISOString()
      })
    );
    const result = await client.fetchCompanyFinancials("missing-company");
    expect(result).toMatchObject({
      dataSource: "fallback_default",
      cacheStatus: "budget_blocked",
      remainingApiCalls: 10,
      fallbackReason: "API_BUDGET_RESERVED_FOR_DEMO"
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns fallback pricing metadata for missing or malformed coverage", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "unlockd-pricing-"));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const client = new CoresignalCompanyClient({
      apiKey: "test-key",
      collectUrlTemplate: "https://example.test/company/{companyIdentifier}",
      cache: new CompanyFileCache(path.join(directory, "companies"), 604_800),
      budget: new PersistentApiBudget(path.join(directory, "usage.json"), 100, 10),
      fetchImpl
    });
    await expect(client.fetchCompanyFinancials("unknown")).resolves.toMatchObject({
      dataSource: "fallback_default",
      fallbackReason: "BALANCE_SHEET_UNAVAILABLE"
    });
  });
});
