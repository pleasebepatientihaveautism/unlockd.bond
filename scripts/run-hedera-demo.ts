import "dotenv/config";
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  fundingResultV2Schema,
  fundingResultV3Schema,
  repaymentResultAnySchema
} from "../src/domain/schemas.js";

const baseUrl = process.env.UNLOCKD_API_URL ?? "http://localhost:3000";
const operatorId = process.env.HEDERA_OPERATOR_ID;
if (!operatorId) throw new Error("HEDERA_OPERATOR_ID_REQUIRED");
const recipientId = process.env.HEDERA_RECIPIENT_ID;
if (!recipientId) throw new Error("HEDERA_RECIPIENT_ID_REQUIRED");
const settlementAuthSecret = process.env.SETTLEMENT_AUTH_SECRET;
if (!settlementAuthSecret) throw new Error("SETTLEMENT_AUTH_SECRET_REQUIRED");

const suffix = crypto.randomUUID().replaceAll("-", "");
const input = {
  requestId: `ub_req_${suffix}`,
  employeeRef: `ub_emp_${crypto.randomUUID().replaceAll("-", "")}`,
  synthetic: true,
  grant: {
    assetSymbol: "AAPL",
    companyIdentifier: "apple.com",
    grantType: "RSU",
    vestedUnits: "120.000000",
    strikePriceMinor: 0,
    referenceSharePriceMinor: null,
    valuationDate: null,
    valuationSource: null,
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
    headers: {
      authorization: `Bearer ${settlementAuthSecret}`,
      "content-type": "application/json"
    },
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
const funding = fundingResultV3Schema.or(fundingResultV2Schema).parse(funded.advance.funding);
if (
  funding.simulated ||
  !Object.values(funding.transactions).every(
    (transaction) => transaction.consensusStatus === "SUCCESS"
  )
) {
  throw new Error("REAL_CONSENSUS_RECEIPT_REQUIRED");
}

let repayment = null;
if (process.argv.includes("--repay")) {
  const repaymentId = `ub_rp_${crypto.randomUUID().replaceAll("-", "")}`;
  const repaymentResponse = await fetch(
    `${baseUrl}/api/advances/${encodeURIComponent(evaluated.advance.advanceId)}/repay`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${settlementAuthSecret}`,
        "content-type": "application/json",
        "idempotency-key": repaymentId
      },
      body: JSON.stringify({
        repaymentId,
        confirmationToken: evaluated.confirmationToken
      })
    }
  );
  const repaymentBody = (await repaymentResponse.json()) as {
    advance?: { state: string; repayment: unknown };
    error?: string;
  };
  if (!repaymentResponse.ok || repaymentBody.advance?.state !== "REPAID") {
    throw new Error(repaymentBody.error ?? "DEMO_REPAYMENT_FAILED");
  }
  repayment = repaymentResultAnySchema.parse(repaymentBody.advance.repayment);
  if (
    repayment.simulated ||
    !Object.values(repayment.transactions).every(
      (transaction) => transaction.consensusStatus === "SUCCESS"
    )
  ) {
    throw new Error("REAL_REPAYMENT_CONSENSUS_RECEIPT_REQUIRED");
  }
}

const receipt = {
  network: "testnet",
  advanceId: evaluated.advance.advanceId,
  recipientAccountId: recipientId,
  amountMinor: funding.asset.amountMinor,
  amountStableUnits: funding.asset.amountUnits,
  funding,
  repayment,
  generatedAt: new Date().toISOString()
};
const outputPath = path.resolve("hedera-demo-receipt.json");
writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
process.stdout.write(
  `Real Testnet demo ${repayment ? "funded and repaid" : "funded"}. Public receipt: ${path.basename(outputPath)}.\n`
);
