import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const YAHOO_PRIVATE_COMPANIES_URL =
  "https://finance.yahoo.com/markets/private-companies/highest-valuation/";
export const YAHOO_PRIVATE_DATA_URL =
  "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=150&formatted=true&scrIds=HIGHEST_VALUATION_PRIVATE_COMPANY&start=0&useRecordsResponse=true&fields=ticker%2Csymbol%2CcompanyName%2CregularMarketPrice%2CfiftyTwoWeekChangePercent%2ClatestImpliedValuation%2CfundingToDate%2ClatestFundingDate%2ClatestAmountRaised%2ClatestShareClass%2Csector&lang=en-US&region=US";

interface RawNumber {
  raw?: unknown;
  fmt?: unknown;
}

interface RawPrivateCompany {
  ticker?: unknown;
  companyName?: unknown;
  regularMarketPrice?: RawNumber;
  latestImpliedValuation?: RawNumber;
  latestFundingDate?: RawNumber;
  latestShareClass?: unknown;
  sector?: unknown;
}

export interface YahooPrivateCompanyQuote {
  ticker: string;
  companyName: string;
  priceUsd: number;
  estimatedValuationUsd: number | null;
  latestFundingDate: string | null;
  latestShareClass: string | null;
  sector: string | null;
  fetchedAt: number;
  sourceUrl: string;
  cacheStatus: "hit" | "miss" | "stale";
}

interface CachedQuote {
  version: 1;
  quote: Omit<YahooPrivateCompanyQuote, "cacheStatus">;
}

interface YahooPrivateClientConfig {
  cacheFile: string;
  cacheTtlSeconds: number;
  pageUrl?: string;
  dataUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordsFromBody(body: unknown): RawPrivateCompany[] {
  if (!body || typeof body !== "object") return [];
  const finance = (body as { finance?: unknown }).finance;
  if (!finance || typeof finance !== "object") return [];
  const result = (finance as { result?: unknown }).result;
  if (!Array.isArray(result)) return [];
  for (const entry of result) {
    if (!entry || typeof entry !== "object") continue;
    const records = (entry as { records?: unknown }).records;
    if (Array.isArray(records)) return records as RawPrivateCompany[];
  }
  return [];
}

export function parseYahooPrivateCompaniesPage(
  html: string,
  ticker: string,
  fetchedAt = Math.floor(Date.now() / 1000),
  sourceUrl = YAHOO_PRIVATE_COMPANIES_URL
): Omit<YahooPrivateCompanyQuote, "cacheStatus"> {
  const scripts = html.matchAll(
    /<script\b([^>]*)data-sveltekit-fetched([^>]*)>([\s\S]*?)<\/script>/gi
  );
  const normalizedTicker = ticker.trim().toUpperCase();
  const records: RawPrivateCompany[] = [];

  for (const match of scripts) {
    const attributes = `${match[1] ?? ""}${match[2] ?? ""}`;
    if (!attributes.includes("HIGHEST_VALUATION_PRIVATE_COMPANY")) continue;
    try {
      const envelope = JSON.parse(match[3] ?? "") as { body?: unknown };
      const body =
        typeof envelope.body === "string" ? (JSON.parse(envelope.body) as unknown) : envelope.body;
      records.push(...recordsFromBody(body));
    } catch {
      throw new Error("YAHOO_PRIVATE_DATA_MALFORMED");
    }
    if (
      records.some(
        (candidate) =>
          typeof candidate.ticker === "string" &&
          candidate.ticker.trim().toUpperCase() === normalizedTicker
      )
    ) {
      break;
    }
  }

  return quoteFromRecords(records, normalizedTicker, fetchedAt, sourceUrl);
}

export function parseYahooPrivateCompaniesResponse(
  body: unknown,
  ticker: string,
  fetchedAt = Math.floor(Date.now() / 1000),
  sourceUrl = YAHOO_PRIVATE_COMPANIES_URL
): Omit<YahooPrivateCompanyQuote, "cacheStatus"> {
  return quoteFromRecords(recordsFromBody(body), ticker.trim().toUpperCase(), fetchedAt, sourceUrl);
}

function quoteFromRecords(
  records: RawPrivateCompany[],
  normalizedTicker: string,
  fetchedAt: number,
  sourceUrl: string
): Omit<YahooPrivateCompanyQuote, "cacheStatus"> {
  const record = records.find(
    (candidate) =>
      typeof candidate.ticker === "string" &&
      candidate.ticker.trim().toUpperCase() === normalizedTicker
  );
  if (!record) throw new Error("YAHOO_PRIVATE_COMPANY_NOT_FOUND");

  const priceUsd = finitePositive(record.regularMarketPrice?.raw);
  const companyName = optionalText(record.companyName);
  if (!priceUsd || !companyName) throw new Error("YAHOO_PRIVATE_PRICE_MISSING");

  const fundingDate = optionalText(record.latestFundingDate?.fmt);
  const fundingTimestamp = finitePositive(record.latestFundingDate?.raw);
  return {
    ticker: normalizedTicker,
    companyName,
    priceUsd,
    estimatedValuationUsd: finitePositive(record.latestImpliedValuation?.raw),
    latestFundingDate:
      fundingDate && /^\d{4}-\d{2}-\d{2}$/.test(fundingDate)
        ? fundingDate
        : fundingTimestamp
          ? new Date(fundingTimestamp * 1000).toISOString().slice(0, 10)
          : null,
    latestShareClass: optionalText(record.latestShareClass),
    sector: optionalText(record.sector),
    fetchedAt,
    sourceUrl
  };
}

export class YahooPrivateCompanyClient {
  private readonly pageUrl: string;
  private readonly dataUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private inFlight: Promise<YahooPrivateCompanyQuote> | null = null;

  constructor(private readonly config: YahooPrivateClientConfig) {
    this.pageUrl = config.pageUrl ?? YAHOO_PRIVATE_COMPANIES_URL;
    this.dataUrl = config.dataUrl ?? YAHOO_PRIVATE_DATA_URL;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 8_000;
  }

  async quote(ticker: string): Promise<YahooPrivateCompanyQuote> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.load(ticker).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async readCache(): Promise<CachedQuote | null> {
    try {
      const parsed = JSON.parse(await readFile(this.config.cacheFile, "utf8")) as CachedQuote;
      return parsed.version === 1 && parsed.quote ? parsed : null;
    } catch {
      return null;
    }
  }

  private async writeCache(quote: Omit<YahooPrivateCompanyQuote, "cacheStatus">): Promise<void> {
    await mkdir(path.dirname(this.config.cacheFile), { recursive: true });
    const temporaryPath = `${this.config.cacheFile}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ version: 1, quote } satisfies CachedQuote, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    await rename(temporaryPath, this.config.cacheFile);
  }

  private async load(ticker: string): Promise<YahooPrivateCompanyQuote> {
    const cached = await this.readCache();
    const now = Math.floor(Date.now() / 1000);
    if (
      cached?.quote.ticker === ticker.trim().toUpperCase() &&
      now - cached.quote.fetchedAt <= this.config.cacheTtlSeconds
    ) {
      return { ...cached.quote, cacheStatus: "hit" };
    }

    try {
      const response = await this.fetchImpl(this.dataUrl, {
        headers: {
          accept: "application/json"
        },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!response.ok) throw new Error(`YAHOO_PRIVATE_HTTP_${response.status}`);
      const observedAt = Date.parse(response.headers.get("date") ?? "");
      const fetchedAt = Number.isFinite(observedAt) ? Math.floor(observedAt / 1000) : now;
      const quote = parseYahooPrivateCompaniesResponse(
        (await response.json()) as unknown,
        ticker,
        fetchedAt,
        this.pageUrl
      );
      await this.writeCache(quote);
      return { ...quote, cacheStatus: "miss" };
    } catch (error) {
      if (
        cached?.quote.ticker === ticker.trim().toUpperCase() &&
        now - cached.quote.fetchedAt <= 7 * 24 * 60 * 60
      ) {
        return { ...cached.quote, cacheStatus: "stale" };
      }
      throw error;
    }
  }
}
