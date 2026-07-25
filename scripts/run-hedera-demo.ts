import { writeFileSync } from "node:fs";
import path from "node:path";
import "dotenv/config";
import { fundingResultSchema } from "../src/domain/schemas.js";

const baseUrl = process.env.UNLOCKD_API_URL ?? "http://localhost:3000";
const operatorId = process.env.HEDERA_OPERATOR_ID;
if (!operatorId) throw new Error("HEDERA_OPERATOR_ID_REQUIRED");

const suffix = crypto.randomUUID().replaceAll("-", "");
const input = {
  requestId: `ub_req_${suffix}`,
  employeeRef: `ub_emp_${crypto.randomUUID().replaceAll("-", "")}`,
  recipientAccountId: operatorId,
  synthetic: true,
  employment: {
    tenureMonths: 38,
    monthlyNetIncomeMinor: 650_000,
    statusVerified: true
  },
  grant: {
    assetSymbol: "AAPL",
    grantType: "RSU",
    vestedUnits: "120.000000",
    strikePriceMinor: 0,
    transferRestricted: true,
    attestationCommitment: `sha256:${"a".repeat(64)}`
  },
  request: {
    amountMinor: 1000,
    currency: "USD",
    termDays: 14
  }
};

const evaluatedResponse = await fetch(`${baseUrl}/api/advances/evaluate`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": input.requestId
  },
  body: JSON.stringify(input)
});
const evaluated = (await evaluatedResponse.json()) as {
  advance?: { advanceId: string; state: string };
  confirmationToken?: string;
  error?: string;
};
if (
  !evaluatedResponse.ok ||
  evaluated.advance?.state !== "AUTHORIZED" ||
  !evaluated.confirmationToken
) {
  throw new Error(evaluated.error ?? "DEMO_EVALUATION_FAILED");
}

const fundedResponse = await fetch(
  `${baseUrl}/api/advances/${encodeURIComponent(evaluated.advance.advanceId)}/fund`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmationToken: evaluated.confirmationToken })
  }
);
const funded = (await fundedResponse.json()) as {
  advance?: { state: string; funding: unknown };
  error?: string;
};
if (!fundedResponse.ok || funded.advance?.state !== "FUNDED") {
  throw new Error(funded.error ?? "DEMO_FUNDING_FAILED");
}
const funding = fundingResultSchema.parse(funded.advance.funding);
if (funding.simulated || funding.consensusStatus !== "SUCCESS") {
  throw new Error("REAL_CONSENSUS_RECEIPT_REQUIRED");
}

const receipt = {
  network: "testnet",
  advanceId: evaluated.advance.advanceId,
  recipientAccountId: operatorId,
  amountTinybar: "1000000",
  funding,
  generatedAt: new Date().toISOString()
};
const outputPath = path.resolve("hedera-demo-receipt.json");
writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
process.stdout.write(`Real Testnet demo funded. Public receipt: ${path.basename(outputPath)}.\n`);
