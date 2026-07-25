import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "dotenv";
import { fundingResultSchema } from "../src/domain/schemas.js";

const mirrorUrl = "https://testnet.mirrornode.hedera.com";
const env = parse(readFileSync(path.resolve(".env.hedera.local"), "utf8"));
const receiptPath = path.resolve("hedera-demo-receipt.json");
const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
  funding: unknown;
  [key: string]: unknown;
};
const funding = fundingResultSchema.parse(receipt.funding);

async function retry<T>(label: string, check: () => Promise<T | null>): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await check();
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${label}_NOT_CONFIRMED`);
}

const mirrorTransactionId = funding.paymentTxId.replace("@", "-").replace(/(\d+)\.(\d+)$/, "$1-$2");
const transaction = await retry("PAYMENT", async () => {
  const response = await fetch(
    `${mirrorUrl}/api/v1/transactions/${encodeURIComponent(mirrorTransactionId)}`
  );
  if (!response.ok) return null;
  const body = (await response.json()) as {
    transactions?: Array<{ result: string; consensus_timestamp: string }>;
  };
  const confirmed = body.transactions?.find((entry) => entry.result === "SUCCESS");
  return confirmed ?? null;
});

const nft = await retry("NFT_OWNERSHIP", async () => {
  const response = await fetch(
    `${mirrorUrl}/api/v1/tokens/${funding.noteTokenId}/nfts/${funding.noteSerial}`
  );
  if (!response.ok) return null;
  const body = (await response.json()) as { account_id?: string };
  return body.account_id === env.HEDERA_POOL_ID ? body : null;
});

const hcs = await retry("HCS_MESSAGE", async () => {
  const response = await fetch(
    `${mirrorUrl}/api/v1/topics/${funding.hcsTopicId}/messages/${funding.hcsSequenceNumber}`
  );
  if (!response.ok) return null;
  const body = (await response.json()) as {
    consensus_timestamp?: string;
    message?: string;
    sequence_number?: number;
  };
  if (!body.message) return null;
  const decoded = JSON.parse(Buffer.from(body.message, "base64").toString("utf8")) as {
    event?: string;
    paymentTxId?: string;
  };
  return decoded.event === "ADVANCE_FUNDED" && decoded.paymentTxId === funding.paymentTxId
    ? body
    : null;
});

const verified = {
  ...receipt,
  mirrorVerifiedAt: new Date().toISOString(),
  verification: {
    payment: {
      result: "SUCCESS",
      consensusTimestamp: transaction.consensus_timestamp,
      url: funding.mirrorTransactionUrl
    },
    nft: {
      owner: nft.account_id,
      url: funding.mirrorTokenUrl
    },
    hcs: {
      sequenceNumber: String(hcs.sequence_number),
      consensusTimestamp: hcs.consensus_timestamp,
      url: `${mirrorUrl}/api/v1/topics/${funding.hcsTopicId}/messages/${funding.hcsSequenceNumber}`
    }
  }
};
writeFileSync(receiptPath, `${JSON.stringify(verified, null, 2)}\n`, "utf8");
process.stdout.write(`Mirror Node verified payment, NFT ownership, and HCS message.\n`);
