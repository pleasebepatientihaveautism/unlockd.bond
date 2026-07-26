import { fallbackCompanyFinancialLookup } from "../../domain/pricing.js";
import type { CompanyFinancialProvider } from "./types.js";

export class FallbackCompanyFinancialProvider implements CompanyFinancialProvider {
  async fetchCompanyFinancials() {
    return fallbackCompanyFinancialLookup();
  }

  async ready(): Promise<boolean> {
    return true;
  }
}
