import type { PositionView, ValuationObservation } from "../domain/positions";
import type { CustomerAdvance } from "../domain/public";
import type { AdvanceRequest, PrivateCompanyListing } from "../domain/schemas";

interface EvaluationResponse {
  advance: CustomerAdvance;
  confirmationToken: string | null;
  idempotentReplay: boolean;
}

interface FundingResponse {
  advance: CustomerAdvance;
  idempotentReplay: boolean;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers
    }
  });
  const body = (await response.json()) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(body.error ?? body.message ?? `HTTP_${response.status}`);
  return body;
}

export function evaluateAdvance(input: AdvanceRequest): Promise<EvaluationResponse> {
  return request("/api/advances/evaluate", {
    method: "POST",
    headers: { "Idempotency-Key": input.requestId },
    body: JSON.stringify(input)
  });
}

export async function getPrivateCompanies(): Promise<PrivateCompanyListing[]> {
  const response = await request<{ companies: PrivateCompanyListing[] }>(
    "/api/market/private-companies"
  );
  return response.companies;
}

export function fundAdvance(
  advanceId: string,
  confirmationToken: string
): Promise<FundingResponse> {
  return request(`/api/advances/${encodeURIComponent(advanceId)}/fund`, {
    method: "POST",
    body: JSON.stringify({ confirmationToken })
  });
}

export async function getAdvance(advanceId: string): Promise<CustomerAdvance> {
  const response = await request<{ advance: CustomerAdvance }>(
    `/api/advances/${encodeURIComponent(advanceId)}`
  );
  return response.advance;
}

export function repayAdvance(
  advanceId: string,
  repaymentId: string,
  confirmationToken: string
): Promise<FundingResponse> {
  return request(`/api/advances/${encodeURIComponent(advanceId)}/repay`, {
    method: "POST",
    headers: { "Idempotency-Key": repaymentId },
    body: JSON.stringify({ repaymentId, confirmationToken })
  });
}

export async function getPositions(status: "open" | "closed"): Promise<PositionView[]> {
  const response = await request<{ positions: PositionView[] }>(
    `/api/positions?status=${encodeURIComponent(status)}`
  );
  return response.positions;
}

export async function getPosition(advanceId: string): Promise<PositionView> {
  const response = await request<{ position: PositionView }>(
    `/api/positions/${encodeURIComponent(advanceId)}`
  );
  return response.position;
}

export async function getPositionValuations(advanceId: string): Promise<ValuationObservation[]> {
  const response = await request<{ valuations: ValuationObservation[] }>(
    `/api/positions/${encodeURIComponent(advanceId)}/valuations`
  );
  return response.valuations;
}

export function repayPosition(
  advanceId: string,
  repaymentId: string,
  amountMinor: number
): Promise<{ position: PositionView; idempotentReplay: boolean }> {
  return request(`/api/positions/${encodeURIComponent(advanceId)}/repay`, {
    method: "POST",
    headers: { "Idempotency-Key": repaymentId },
    body: JSON.stringify({ repaymentId, amountMinor })
  });
}

export function previewLiquidation(
  advanceId: string,
  emulatedPriceMinor: number
): Promise<{
  preview: {
    advanceId: string;
    emulatedPriceMinor: number;
    liquidationPriceMinor: number;
    wouldLiquidate: boolean;
    remainingPrincipalMinor: number;
    label: string;
  };
}> {
  return request(`/api/positions/${encodeURIComponent(advanceId)}/liquidation/preview`, {
    method: "POST",
    body: JSON.stringify({ emulatedPriceMinor })
  });
}

export function liquidatePosition(
  advanceId: string,
  liquidationId: string,
  emulatedPriceMinor: number
): Promise<{ position: PositionView; idempotentReplay: boolean }> {
  return request(`/api/positions/${encodeURIComponent(advanceId)}/liquidate`, {
    method: "POST",
    headers: { "Idempotency-Key": liquidationId },
    body: JSON.stringify({ liquidationId, emulatedPriceMinor })
  });
}
