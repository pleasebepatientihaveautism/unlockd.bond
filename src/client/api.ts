import type { PublicAdvance } from "../domain/public";
import type { AdvanceRequest } from "../domain/schemas";

interface EvaluationResponse {
  advance: PublicAdvance;
  confirmationToken: string | null;
  idempotentReplay: boolean;
}

interface FundingResponse {
  advance: PublicAdvance;
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

export function fundAdvance(
  advanceId: string,
  confirmationToken: string
): Promise<FundingResponse> {
  return request(`/api/advances/${encodeURIComponent(advanceId)}/fund`, {
    method: "POST",
    body: JSON.stringify({ confirmationToken })
  });
}
