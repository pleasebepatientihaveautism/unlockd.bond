import "dotenv/config";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import {
  fundingResultV2Schema,
  fundingResultV3Schema,
  repaymentResultAnySchema
} from "../src/domain/schemas.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined
});

try {
  const advanceId = process.env.ADVANCE_ID;
  const result = advanceId
    ? await pool.query<{ record: unknown }>(
        "SELECT record FROM advances WHERE advance_id = $1 LIMIT 1",
        [advanceId]
      )
    : await pool.query<{ record: unknown }>(
        "SELECT record FROM advances WHERE mode = 'hedera-demo' ORDER BY created_at DESC LIMIT 1"
      );
  const record = result.rows[0]?.record as
    | {
        advanceId?: string;
        recipientAccountId?: string;
        funding?: unknown;
        repayment?: unknown;
      }
    | undefined;
  if (!record?.advanceId || !record.recipientAccountId || !record.funding) {
    throw new Error("COMPLETED_HEDERA_RECORD_NOT_FOUND");
  }

  const funding = fundingResultV3Schema.or(fundingResultV2Schema).parse(record.funding);
  const repayment = record.repayment ? repaymentResultAnySchema.parse(record.repayment) : null;
  const receipt = {
    network: "testnet",
    advanceId: record.advanceId,
    recipientAccountId: record.recipientAccountId,
    amountMinor: funding.asset.amountMinor,
    amountStableUnits: funding.asset.amountUnits,
    funding,
    repayment,
    generatedAt: new Date().toISOString()
  };
  const outputPath = path.resolve("hedera-demo-receipt.json");
  writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`Recovered public lifecycle receipt for ${record.advanceId}.\n`);
} finally {
  await pool.end();
}
