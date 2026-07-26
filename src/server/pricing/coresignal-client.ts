import type { CompanyFinancialLookup, CompanyFinancialSnapshot } from "../../domain/pricing.js";
import { fallbackCompanyFinancialLookup } from "../../domain/pricing.js";
import type { PersistentApiBudget } from "./api-budget.js";
import type { CompanyFileCache } from "./company-cache.js";

interface CoresignalClientConfig {
  apiKey: string;
  collectUrlTemplate: string;
  cache: CompanyFileCache;
  budget: PersistentApiBudget;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface BalanceSheetRecord {
  preferred_stock?: unknown;
  common_stock?: unknown;
  total_assets?: unknown;
  shares_outstanding?: unknown;
  total_shares_outstanding?: unknown;
  period_end_date?: unknown;
  period_display_end_date?: unknown;
  source_label?: unknown;
  source_url?: unknown;
  deleted?: unknown;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function recordTimestamp(record: BalanceSheetRecord): number {
  const isoDate = text(record.period_end_date);
  if (isoDate) {
    const timestamp = Date.parse(`${isoDate}T00:00:00Z`);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  const displayDate = text(record.period_display_end_date);
  if (!displayDate) return 0;
  const year = displayDate.match(/\b(19|20)\d{2}\b/)?.[0];
  return year ? Date.parse(`${year}-12-31T00:00:00Z`) : 0;
}

export function mostRecentCompanyFinancials(raw: unknown): CompanyFinancialSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const balanceSheets = (raw as { balance_sheets?: unknown }).balance_sheets;
  if (!Array.isArray(balanceSheets)) return null;
  const records = balanceSheets.filter(
    (record): record is BalanceSheetRecord =>
      Boolean(record) &&
      typeof record === "object" &&
      finiteNumber((record as BalanceSheetRecord).deleted) !== 1
  );
  records.sort((left, right) => recordTimestamp(right) - recordTimestamp(left));
  const latest = records[0];
  if (!latest) return null;
  return {
    preferredStock: finiteNumber(latest.preferred_stock),
    commonStock: finiteNumber(latest.common_stock),
    totalAssets: finiteNumber(latest.total_assets),
    sharesOutstanding:
      finiteNumber(latest.shares_outstanding) ?? finiteNumber(latest.total_shares_outstanding),
    asOfDate: text(latest.period_end_date) ?? text(latest.period_display_end_date),
    sourceLabel: text(latest.source_label),
    sourceUrl: text(latest.source_url)
  };
}

export class CoresignalCompanyClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly inFlight = new Map<string, Promise<CompanyFinancialLookup>>();

  constructor(private readonly config: CoresignalClientConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 8_000;
  }

  async fetchCompanyFinancials(companyIdentifier: string): Promise<CompanyFinancialLookup> {
    const key = companyIdentifier.trim().toLowerCase();
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const request = this.loadCompanyFinancials(companyIdentifier).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, request);
    return request;
  }

  private async loadCompanyFinancials(companyIdentifier: string): Promise<CompanyFinancialLookup> {
    const cached = await this.config.cache.read(companyIdentifier);
    if (cached && !cached.stale) {
      const financials = mostRecentCompanyFinancials(cached.raw);
      return financials
        ? {
            financials,
            dataSource: "coresignal",
            cacheStatus: "hit",
            remainingApiCalls: await this.config.budget.remainingCalls(),
            fallbackReason: null
          }
        : fallbackCompanyFinancialLookup(
            "CACHED_FINANCIALS_MALFORMED",
            "hit",
            await this.config.budget.remainingCalls()
          );
    }

    const reservation = await this.config.budget.reserveNetworkCall();
    if (!reservation.allowed) {
      if (cached) {
        const staleFinancials = mostRecentCompanyFinancials(cached.raw);
        if (staleFinancials) {
          return {
            financials: staleFinancials,
            dataSource: "coresignal",
            cacheStatus: "budget_blocked",
            remainingApiCalls: reservation.remainingCalls,
            fallbackReason: "STALE_CACHE_USED_BUDGET_RESERVED"
          };
        }
      }
      return fallbackCompanyFinancialLookup(
        "API_BUDGET_RESERVED_FOR_DEMO",
        "budget_blocked",
        reservation.remainingCalls
      );
    }

    try {
      const encodedIdentifier = encodeURIComponent(companyIdentifier.trim());
      const url = this.config.collectUrlTemplate.replace("{companyIdentifier}", encodedIdentifier);
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          apikey: this.config.apiKey
        },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!response.ok) {
        if (cached) {
          const staleFinancials = mostRecentCompanyFinancials(cached.raw);
          if (staleFinancials) {
            return {
              financials: staleFinancials,
              dataSource: "coresignal",
              cacheStatus: "stale",
              remainingApiCalls: reservation.remainingCalls,
              fallbackReason:
                response.status === 404
                  ? "STALE_CACHE_USED_COMPANY_NOT_FOUND"
                  : `STALE_CACHE_USED_HTTP_${response.status}`
            };
          }
        }
        return fallbackCompanyFinancialLookup(
          response.status === 404 ? "COMPANY_NOT_FOUND" : `CORESIGNAL_HTTP_${response.status}`,
          cached ? "stale" : "miss",
          reservation.remainingCalls
        );
      }
      await this.config.budget.markSuccessfulCall();
      const raw = (await response.json()) as unknown;
      await this.config.cache.write(companyIdentifier, raw);
      const financials = mostRecentCompanyFinancials(raw);
      if (!financials) {
        return fallbackCompanyFinancialLookup(
          "BALANCE_SHEET_UNAVAILABLE",
          cached ? "stale" : "miss",
          reservation.remainingCalls
        );
      }
      return {
        financials,
        dataSource: "coresignal",
        cacheStatus: cached ? "stale" : "miss",
        remainingApiCalls: reservation.remainingCalls,
        fallbackReason: null
      };
    } catch {
      if (cached) {
        const staleFinancials = mostRecentCompanyFinancials(cached.raw);
        if (staleFinancials) {
          return {
            financials: staleFinancials,
            dataSource: "coresignal",
            cacheStatus: "stale",
            remainingApiCalls: reservation.remainingCalls,
            fallbackReason: "STALE_CACHE_USED_AFTER_NETWORK_FAILURE"
          };
        }
      }
      return fallbackCompanyFinancialLookup(
        "CORESIGNAL_REQUEST_FAILED",
        cached ? "stale" : "miss",
        reservation.remainingCalls
      );
    }
  }

  async ready(): Promise<boolean> {
    // Readiness must never consume one of the limited API calls.
    return true;
  }
}
