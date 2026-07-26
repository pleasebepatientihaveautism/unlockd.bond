import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "dotenv";
import { fundingResultV2Schema, repaymentResultSchema } from "../src/domain/schemas.js";

const mirrorUrl = "https://testnet.mirrornode.hedera.com";
const env = parse(readFileSync(path.resolve(".env.hedera.local"), "utf8"));
const receiptPath = path.resolve("hedera-demo-receipt.json");
const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
  recipientAccountId?: string;
  funding: unknown;
  repayment?: unknown;
  [key: string]: unknown;
};
const funding = fundingResultV2Schema.parse(receipt.funding);
const repayment = receipt.repayment ? repaymentResultSchema.parse(receipt.repayment) : null;
if (!receipt.recipientAccountId) throw new Error("RECIPIENT_ACCOUNT_REQUIRED");

async function retry<T>(label: string, check: () => Promise<T | null>): Promise<T> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await check();
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${label}_NOT_CONFIRMED`);
}

function mirrorTransactionId(transactionId: string): string {
  return transactionId.replace("@", "-").replace(/(\d+)\.(\d+)$/, "$1-$2");
}

interface MirrorTransaction {
  consensus_timestamp: string;
  result: string;
  token_transfers?: Array<{ account: string; amount: number; token_id: string }>;
  nft_transfers?: Array<{
    receiver_account_id: string;
    sender_account_id: string;
    serial_number: number;
    token_id: string;
  }>;
}

async function confirmedTransaction(transactionId: string): Promise<MirrorTransaction> {
  return retry("TRANSACTION", async () => {
    const response = await fetch(
      `${mirrorUrl}/api/v1/transactions/${encodeURIComponent(mirrorTransactionId(transactionId))}`
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { transactions?: MirrorTransaction[] };
    return body.transactions?.find((entry) => entry.result === "SUCCESS") ?? null;
  });
}

const [authorization, noteMint, settlement, fundedEvent] = await Promise.all([
  confirmedTransaction(funding.transactions.authorization.transactionId),
  confirmedTransaction(funding.transactions.noteMint.transactionId),
  confirmedTransaction(funding.transactions.settlement.transactionId),
  confirmedTransaction(funding.transactions.fundedEvent.transactionId)
]);

const expectedUnits = Number(funding.asset.amountUnits);
if (!Number.isSafeInteger(expectedUnits)) throw new Error("STABLE_AMOUNT_OUT_OF_RANGE");
const recipientTransfer = settlement.token_transfers?.find(
  (entry) =>
    entry.token_id === funding.asset.tokenId &&
    entry.account === receipt.recipientAccountId &&
    entry.amount === expectedUnits
);
if (!recipientTransfer) throw new Error("STABLE_PAYOUT_NOT_CONFIRMED");
const issuanceNftTransfer = settlement.nft_transfers?.find(
  (entry) =>
    entry.token_id === funding.note.tokenId &&
    String(entry.serial_number) === funding.note.serial &&
    entry.receiver_account_id === env.HEDERA_POOL_ID
);
if (!issuanceNftTransfer) throw new Error("NOTE_POOL_TRANSFER_NOT_CONFIRMED");

const nft = await retry("NFT_OWNERSHIP", async () => {
  const response = await fetch(
    `${mirrorUrl}/api/v1/tokens/${funding.note.tokenId}/nfts/${funding.note.serial}`
  );
  if (!response.ok) return null;
  const body = (await response.json()) as { account_id?: string; deleted?: boolean };
  return repayment
    ? body.deleted === true
      ? body
      : null
    : body.account_id === env.HEDERA_POOL_ID
      ? body
      : null;
});

async function hcsMessage(
  sequenceNumber: string,
  check: (message: Record<string, unknown>) => boolean
) {
  return retry("HCS_MESSAGE", async () => {
    const response = await fetch(
      `${mirrorUrl}/api/v1/topics/${funding.topic.topicId}/messages/${sequenceNumber}`
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      consensus_timestamp?: string;
      message?: string;
      sequence_number?: number;
    };
    if (!body.message) return null;
    const decoded = JSON.parse(Buffer.from(body.message, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
    return check(decoded) ? body : null;
  });
}

const authorizationMessage = await hcsMessage(
  funding.topic.authorizationSequenceNumber,
  (message) => message.event === "ADVANCE_AUTHORIZED"
);
const fundedMessage = await hcsMessage(funding.topic.fundedSequenceNumber, (message) => {
  return (
    message.event === "ADVANCE_FUNDED" &&
    message.settlementTxId === funding.transactions.settlement.transactionId
  );
});

const stableToken = await retry("STABLE_TOKEN", async () => {
  const response = await fetch(`${mirrorUrl}/api/v1/tokens/${funding.asset.tokenId}`);
  if (!response.ok) return null;
  const body = (await response.json()) as {
    decimals?: string;
    name?: string;
    symbol?: string;
    total_supply?: string;
  };
  return body.name === "USDC DEMO" &&
    body.symbol === "USDC" &&
    body.decimals === "6" &&
    body.total_supply === "1000000000000000"
    ? body
    : null;
});

let repaymentVerification = null;
if (repayment) {
  const [repaymentAuthorization, repaymentSettlement, noteBurn, repaidEvent] = await Promise.all([
    confirmedTransaction(repayment.transactions.authorization.transactionId),
    confirmedTransaction(repayment.transactions.settlement.transactionId),
    confirmedTransaction(repayment.transactions.noteBurn.transactionId),
    confirmedTransaction(repayment.transactions.repaidEvent.transactionId)
  ]);
  const repaymentUnits = Number(repayment.asset.amountUnits);
  if (!Number.isSafeInteger(repaymentUnits)) throw new Error("REPAYMENT_AMOUNT_OUT_OF_RANGE");
  const payerDebit = repaymentSettlement.token_transfers?.find(
    (entry) =>
      entry.token_id === repayment.asset.tokenId &&
      entry.account === repayment.payerAccountId &&
      entry.amount === -repaymentUnits
  );
  const treasuryCredit = repaymentSettlement.token_transfers?.find(
    (entry) =>
      entry.token_id === repayment.asset.tokenId &&
      entry.account === repayment.treasuryAccountId &&
      entry.amount === repaymentUnits
  );
  if (!payerDebit || !treasuryCredit) throw new Error("STABLE_REPAYMENT_NOT_CONFIRMED");
  const repaymentNftTransfer = repaymentSettlement.nft_transfers?.find(
    (entry) =>
      entry.token_id === repayment.note.tokenId &&
      String(entry.serial_number) === repayment.note.serial &&
      entry.sender_account_id === env.HEDERA_POOL_ID &&
      entry.receiver_account_id === repayment.treasuryAccountId
  );
  if (!repaymentNftTransfer) throw new Error("NOTE_RETURN_NOT_CONFIRMED");
  const repaymentAuthorizationMessage = await hcsMessage(
    repayment.topic.authorizationSequenceNumber,
    (message) =>
      message.event === "REPAYMENT_AUTHORIZED" && message.repaymentId === repayment.repaymentId
  );
  const repaidMessage = await hcsMessage(repayment.topic.repaidSequenceNumber, (message) => {
    return (
      message.event === "ADVANCE_REPAID" &&
      message.repaymentId === repayment.repaymentId &&
      message.settlementTxId === repayment.transactions.settlement.transactionId &&
      message.noteBurnTxId === repayment.transactions.noteBurn.transactionId
    );
  });
  repaymentVerification = {
    transactions: {
      authorization: repaymentAuthorization.consensus_timestamp,
      settlement: repaymentSettlement.consensus_timestamp,
      noteBurn: noteBurn.consensus_timestamp,
      repaidEvent: repaidEvent.consensus_timestamp
    },
    stableRepayment: {
      payer: payerDebit.account,
      treasury: treasuryCredit.account,
      amountUnits: String(treasuryCredit.amount)
    },
    note: {
      returnedToTreasury: repaymentNftTransfer.receiver_account_id,
      deleted: nft.deleted === true
    },
    hcs: {
      authorizationSequenceNumber: String(repaymentAuthorizationMessage.sequence_number),
      repaidSequenceNumber: String(repaidMessage.sequence_number)
    }
  };
}

const verified = {
  ...receipt,
  mirrorVerifiedAt: new Date().toISOString(),
  verification: {
    transactions: {
      authorization: authorization.consensus_timestamp,
      noteMint: noteMint.consensus_timestamp,
      settlement: settlement.consensus_timestamp,
      fundedEvent: fundedEvent.consensus_timestamp
    },
    stablePayout: {
      tokenId: funding.asset.tokenId,
      recipient: recipientTransfer.account,
      amountUnits: String(recipientTransfer.amount),
      totalSupply: stableToken.total_supply
    },
    nft: {
      owner: nft.account_id,
      url: funding.note.mirrorUrl
    },
    hcs: {
      authorizationSequenceNumber: String(authorizationMessage.sequence_number),
      fundedSequenceNumber: String(fundedMessage.sequence_number)
    },
    repayment: repaymentVerification
  }
};
writeFileSync(receiptPath, `${JSON.stringify(verified, null, 2)}\n`, "utf8");
process.stdout.write(
  repayment
    ? "Mirror Node verified issuance and repayment transactions, exact Demo USDC movements, NFT retirement, and all HCS bindings.\n"
    : "Mirror Node verified four transactions, exact Demo USDC payout, NFT ownership, and both HCS messages.\n"
);
