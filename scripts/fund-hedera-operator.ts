import { readFileSync } from "node:fs";
import path from "node:path";
import { AccountId, Client, Hbar, PrivateKey, TransferTransaction } from "@hashgraph/sdk";
import { parse } from "dotenv";

const fundingAccountId = process.env.HEDERA_FUNDING_ACCOUNT_ID;
if (!fundingAccountId) throw new Error("HEDERA_FUNDING_ACCOUNT_ID_REQUIRED");
const runtime = parse(readFileSync(path.resolve(".env.hedera.local"), "utf8"));
const targetAccountId = runtime.HEDERA_OPERATOR_ID;
if (!targetAccountId) throw new Error("HEDERA_OPERATOR_ID_REQUIRED");

async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error("INTERACTIVE_TERMINAL_REQUIRED");
  }
  process.stdout.write(prompt);
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return await new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      process.stdin.removeListener("data", onData);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish();
          reject(new Error("CANCELLED"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          resolve(value.trim());
          return;
        }
        if (character === "\u007f") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

interface MirrorAccount {
  account: string;
  balance: { balance: number };
  deleted: boolean;
  key: { _type: string; key: string } | null;
}

const mirrorResponse = await fetch(
  `https://testnet.mirrornode.hedera.com/api/v1/accounts/${encodeURIComponent(fundingAccountId)}`
);
if (!mirrorResponse.ok) throw new Error("FUNDING_ACCOUNT_LOOKUP_FAILED");
const mirrorAccount = (await mirrorResponse.json()) as MirrorAccount;
if (
  mirrorAccount.deleted ||
  mirrorAccount.account !== fundingAccountId ||
  mirrorAccount.key?._type !== "ECDSA_SECP256K1" ||
  mirrorAccount.balance.balance < 2_600_000_000
) {
  throw new Error("FUNDING_ACCOUNT_INVALID_OR_UNDERFUNDED");
}

const rawKey = (await readHidden("Funding account private key (hidden; never stored): ")).replace(
  /^0x/,
  ""
);
const fundingKey = PrivateKey.fromStringECDSA(rawKey);
if (fundingKey.publicKey.toStringRaw() !== mirrorAccount.key.key.toLowerCase()) {
  throw new Error("FUNDING_PRIVATE_KEY_MISMATCH");
}

const client = Client.forTestnet().setOperator(AccountId.fromString(fundingAccountId), fundingKey);
try {
  const transaction = await new TransferTransaction()
    .addHbarTransfer(fundingAccountId, new Hbar(-25))
    .addHbarTransfer(targetAccountId, new Hbar(25))
    .setTransactionMemo("unlockd.bond Testnet operator funding")
    .setMaxTransactionFee(new Hbar(1))
    .execute(client);
  const receipt = await transaction.getReceipt(client);
  if (receipt.status.toString() !== "SUCCESS") throw new Error("OPERATOR_FUNDING_FAILED");
  const transactionId = transaction.transactionId.toString();
  process.stdout.write(
    `Operator funded with 25 Testnet HBAR. HashScan: https://hashscan.io/testnet/transaction/${encodeURIComponent(transactionId)}\n`
  );
} finally {
  client.close();
}
