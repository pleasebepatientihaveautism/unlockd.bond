import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  AccountBalanceQuery,
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  Mnemonic,
  PrivateKey,
  TokenAssociateTransaction,
  TokenCreateTransaction,
  TokenSupplyType,
  TokenType,
  TopicCreateTransaction,
  TransferTransaction
} from "@hashgraph/sdk";
import { parse } from "dotenv";

const envPath = path.resolve(".env.hedera.local");
const evidencePath = path.resolve("hedera-testnet-evidence.json");
const mirrorUrl = "https://testnet.mirrornode.hedera.com";
const hashscanUrl = "https://hashscan.io/testnet";
const operatorIdText = process.env.HEDERA_OPERATOR_ID ?? "0.0.9750175";
const state: Record<string, string> = existsSync(envPath)
  ? parse(readFileSync(envPath, "utf8"))
  : {};

function secret(bytes = 36): string {
  return randomBytes(bytes).toString("base64url");
}

function envText(values: Record<string, string>): string {
  const order = [
    "NODE_ENV",
    "PORT",
    "APP_MODE",
    "PUBLIC_BASE_URL",
    "ALLOWED_ORIGINS",
    "COMMITMENT_SECRET",
    "CONFIRMATION_SECRET",
    "HEDERA_NETWORK",
    "HEDERA_OPERATOR_ID",
    "HEDERA_OPERATOR_KEY",
    "HEDERA_TREASURY_ID",
    "HEDERA_TREASURY_KEY",
    "HEDERA_SUPPLY_KEY",
    "HEDERA_POOL_ID",
    "HEDERA_POOL_KEY",
    "HEDERA_TOPIC_ID",
    "HEDERA_TOKEN_ID",
    "HEDERA_MIRROR_URL",
    "PAYOUT_TINYBAR_PER_USD_MINOR",
    "POLICY_FIXED_CAP_MINOR",
    "TREASURY_RESERVE_TINYBAR"
  ];
  return `${order.map((key) => `${key}=${values[key] ?? ""}`).join("\n")}\n`;
}

function persistEnv(): void {
  const tempPath = `${envPath}.tmp`;
  writeFileSync(tempPath, envText(state), { encoding: "utf8", mode: 0o600 });
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, envPath);
  chmodSync(envPath, 0o600);
}

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

async function mirrorAccount(accountId: string): Promise<MirrorAccount> {
  const response = await fetch(`${mirrorUrl}/api/v1/accounts/${encodeURIComponent(accountId)}`);
  if (!response.ok) throw new Error(`MIRROR_ACCOUNT_LOOKUP_FAILED_${response.status}`);
  return (await response.json()) as MirrorAccount;
}

async function operatorKey(account: MirrorAccount): Promise<PrivateKey> {
  if (state.HEDERA_OPERATOR_KEY) {
    const key = PrivateKey.fromStringDer(state.HEDERA_OPERATOR_KEY);
    if (key.publicKey.toStringRaw() !== account.key?.key.toLowerCase()) {
      throw new Error("OPERATOR_PRIVATE_KEY_MISMATCH");
    }
    return key;
  }
  const phrase = await readHidden("Operator mnemonic (hidden; never stored): ");
  const words = phrase.split(/\s+/);
  if (words.length !== 24) throw new Error("OPERATOR_MNEMONIC_MUST_HAVE_24_WORDS");
  const mnemonic = await Mnemonic.fromWords(words);
  const expectedPublicKey = account.key?.key.toLowerCase();
  const matches = (candidate: PrivateKey) =>
    candidate.publicKey.toStringRaw() === expectedPublicKey;

  for (let index = 0; index <= 50; index += 1) {
    const candidate = await mnemonic.toStandardEd25519PrivateKey("", index);
    if (matches(candidate)) return candidate;
  }

  const legacy = await mnemonic.toLegacyPrivateKey();
  if (matches(legacy)) return legacy;
  for (let index = 0; index <= 20; index += 1) {
    const candidatePaths = [
      [44, 3030, 0, 0, index],
      [44, 3030, 0, index],
      [44, 3030, index, 0]
    ];
    for (const derivationPath of candidatePaths) {
      const candidate = await mnemonic.toEd25519PrivateKey("", derivationPath);
      if (matches(candidate)) return candidate;
    }
  }
  throw new Error("OPERATOR_MNEMONIC_DOES_NOT_MATCH_ACCOUNT");
}

function storedPrivateKey(value: string): PrivateKey {
  try {
    return PrivateKey.fromStringDer(value);
  } catch {
    throw new Error("STORED_HEDERA_PRIVATE_KEY_INVALID");
  }
}

async function balanceTinybar(client: Client, accountId: string): Promise<bigint> {
  const balance = await new AccountBalanceQuery().setAccountId(accountId).execute(client);
  return BigInt(balance.hbars.toTinybars().toString());
}

async function consolidateProvisioningBalance(
  client: Client,
  operatorId: AccountId,
  treasuryId: string,
  treasuryKey: PrivateKey,
  poolId: string,
  poolKey: PrivateKey
): Promise<void> {
  const target = 1_650_000_000n;
  const operatorBalance = await balanceTinybar(client, operatorId.toString());
  if (operatorBalance >= target) return;

  const treasuryBalance = await balanceTinybar(client, treasuryId);
  const poolBalance = await balanceTinybar(client, poolId);
  const treasuryAvailable = treasuryBalance > 150_000_000n ? treasuryBalance - 150_000_000n : 0n;
  const poolAvailable = poolBalance > 20_000_000n ? poolBalance - 20_000_000n : 0n;
  const needed = target - operatorBalance;
  if (treasuryAvailable + poolAvailable < needed) {
    throw new Error("TESTNET_FAUCET_REQUIRED_MINIMUM_17_HBAR");
  }

  const fromTreasury = treasuryAvailable < needed ? treasuryAvailable : needed;
  const fromPool = needed - fromTreasury;
  let transfer = new TransferTransaction()
    .addHbarTransfer(operatorId, Hbar.fromTinybars(needed))
    .setTransactionMemo("unlockd.bond provisioning balance consolidation")
    .setMaxTransactionFee(new Hbar(1));
  if (fromTreasury > 0n) {
    transfer = transfer.addHbarTransfer(treasuryId, Hbar.fromTinybars(-fromTreasury));
  }
  if (fromPool > 0n) {
    transfer = transfer.addHbarTransfer(poolId, Hbar.fromTinybars(-fromPool));
  }
  transfer = transfer.freezeWith(client);
  if (fromTreasury > 0n) transfer = await transfer.sign(treasuryKey);
  if (fromPool > 0n) transfer = await transfer.sign(poolKey);
  const executed = await transfer.execute(client);
  const receipt = await executed.getReceipt(client);
  if (receipt.status.toString() !== "SUCCESS") {
    throw new Error("PROVISIONING_BALANCE_CONSOLIDATION_FAILED");
  }
}

async function createAccount(
  client: Client,
  key: PrivateKey,
  initialBalance: Hbar,
  memo: string
): Promise<string> {
  const transaction = await new AccountCreateTransaction()
    .setKey(key.publicKey)
    .setInitialBalance(initialBalance)
    .setAccountMemo(memo)
    .execute(client);
  const receipt = await transaction.getReceipt(client);
  if (receipt.status.toString() !== "SUCCESS" || !receipt.accountId) {
    throw new Error("ACCOUNT_CREATE_FAILED");
  }
  return receipt.accountId.toString();
}

function writeEvidence(): void {
  if (
    !state.HEDERA_TREASURY_ID ||
    !state.HEDERA_POOL_ID ||
    !state.HEDERA_TOPIC_ID ||
    !state.HEDERA_TOKEN_ID
  ) {
    return;
  }
  const evidence = {
    network: "testnet",
    operatorAccountId: state.HEDERA_OPERATOR_ID,
    treasuryAccountId: state.HEDERA_TREASURY_ID,
    poolAccountId: state.HEDERA_POOL_ID,
    lifecycleTopicId: state.HEDERA_TOPIC_ID,
    advanceNoteTokenId: state.HEDERA_TOKEN_ID,
    publicEvidence: {
      operator: `${hashscanUrl}/account/${state.HEDERA_OPERATOR_ID}`,
      treasury: `${hashscanUrl}/account/${state.HEDERA_TREASURY_ID}`,
      pool: `${hashscanUrl}/account/${state.HEDERA_POOL_ID}`,
      topic: `${hashscanUrl}/topic/${state.HEDERA_TOPIC_ID}`,
      token: `${hashscanUrl}/token/${state.HEDERA_TOKEN_ID}`,
      mirrorTopicMessages: `${mirrorUrl}/api/v1/topics/${state.HEDERA_TOPIC_ID}/messages`,
      mirrorToken: `${mirrorUrl}/api/v1/tokens/${state.HEDERA_TOKEN_ID}`
    },
    generatedAt: new Date().toISOString(),
    warning:
      "Hedera Testnet demo infrastructure only; not stock, collateral, or a legal receivable."
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

const account = await mirrorAccount(operatorIdText);
if (account.deleted || account.account !== operatorIdText || !account.key) {
  throw new Error("OPERATOR_ACCOUNT_INVALID");
}
const plannedInitialBalance =
  (state.HEDERA_TREASURY_ID ? 0 : 300_000_000) + (state.HEDERA_POOL_ID ? 0 : 100_000_000);
if (account.balance.balance < plannedInitialBalance + 150_000_000) {
  throw new Error("OPERATOR_BALANCE_TOO_LOW_FOR_REMAINING_PROVISIONING");
}
const key = await operatorKey(account);
const treasuryKey = state.HEDERA_TREASURY_KEY
  ? storedPrivateKey(state.HEDERA_TREASURY_KEY)
  : PrivateKey.generateED25519();
const poolKey = state.HEDERA_POOL_KEY
  ? storedPrivateKey(state.HEDERA_POOL_KEY)
  : PrivateKey.generateED25519();
const supplyKey = state.HEDERA_SUPPLY_KEY
  ? storedPrivateKey(state.HEDERA_SUPPLY_KEY)
  : PrivateKey.generateED25519();

Object.assign(state, {
  NODE_ENV: "development",
  PORT: state.PORT ?? "3000",
  APP_MODE: "hedera-demo",
  PUBLIC_BASE_URL: state.PUBLIC_BASE_URL ?? "http://localhost:5174",
  ALLOWED_ORIGINS: state.ALLOWED_ORIGINS ?? "http://localhost:5174,http://localhost:3000",
  COMMITMENT_SECRET: state.COMMITMENT_SECRET ?? secret(),
  CONFIRMATION_SECRET: state.CONFIRMATION_SECRET ?? secret(),
  HEDERA_NETWORK: "testnet",
  HEDERA_OPERATOR_ID: operatorIdText,
  HEDERA_OPERATOR_KEY: key.toStringDer(),
  HEDERA_TREASURY_ID: state.HEDERA_TREASURY_ID ?? "",
  HEDERA_TREASURY_KEY: treasuryKey.toStringDer(),
  HEDERA_SUPPLY_KEY: supplyKey.toStringDer(),
  HEDERA_POOL_ID: state.HEDERA_POOL_ID ?? "",
  HEDERA_POOL_KEY: poolKey.toStringDer(),
  HEDERA_TOPIC_ID: state.HEDERA_TOPIC_ID ?? "",
  HEDERA_TOKEN_ID: state.HEDERA_TOKEN_ID ?? "",
  HEDERA_MIRROR_URL: mirrorUrl,
  PAYOUT_TINYBAR_PER_USD_MINOR: state.PAYOUT_TINYBAR_PER_USD_MINOR ?? "1000",
  POLICY_FIXED_CAP_MINOR: state.POLICY_FIXED_CAP_MINOR ?? "1000",
  TREASURY_RESERVE_TINYBAR: state.TREASURY_RESERVE_TINYBAR ?? "100000000"
});
persistEnv();

const client = Client.forTestnet().setOperator(AccountId.fromString(operatorIdText), key);
try {
  if (!state.HEDERA_TREASURY_ID) {
    process.stdout.write("Creating 3 HBAR treasury account...\n");
    state.HEDERA_TREASURY_ID = await createAccount(
      client,
      treasuryKey,
      new Hbar(3),
      "unlockd.bond Testnet treasury"
    );
    persistEnv();
  }
  if (!state.HEDERA_POOL_ID) {
    process.stdout.write("Creating 1 HBAR pool account...\n");
    state.HEDERA_POOL_ID = await createAccount(
      client,
      poolKey,
      new Hbar(1),
      "unlockd.bond Testnet pool"
    );
    persistEnv();
  }
  if (!state.HEDERA_TOPIC_ID) {
    process.stdout.write("Creating HCS lifecycle topic...\n");
    const transaction = await new TopicCreateTransaction()
      .setTopicMemo("unlockd.bond lifecycle commitments")
      .setSubmitKey(key.publicKey)
      .execute(client);
    const receipt = await transaction.getReceipt(client);
    if (receipt.status.toString() !== "SUCCESS" || !receipt.topicId) {
      throw new Error("HCS_TOPIC_CREATE_FAILED");
    }
    state.HEDERA_TOPIC_ID = receipt.topicId.toString();
    persistEnv();
  }
  if (!state.HEDERA_TOKEN_ID) {
    await consolidateProvisioningBalance(
      client,
      AccountId.fromString(operatorIdText),
      state.HEDERA_TREASURY_ID,
      treasuryKey,
      state.HEDERA_POOL_ID,
      poolKey
    );
    process.stdout.write("Creating Advance Note NFT collection...\n");
    const frozen = new TokenCreateTransaction()
      .setTokenName("unlockd.bond Advance Note")
      .setTokenSymbol("UBAN")
      .setTokenType(TokenType.NonFungibleUnique)
      .setSupplyType(TokenSupplyType.Infinite)
      .setTreasuryAccountId(AccountId.fromString(state.HEDERA_TREASURY_ID))
      .setSupplyKey(supplyKey.publicKey)
      .setTokenMemo("Testnet receivable representation; not stock or legal collateral")
      .setMaxTransactionFee(new Hbar(16))
      .freezeWith(client);
    const treasurySigned = await frozen.sign(treasuryKey);
    const supplySigned = await treasurySigned.sign(supplyKey);
    const transaction = await supplySigned.execute(client);
    const receipt = await transaction.getReceipt(client);
    if (receipt.status.toString() !== "SUCCESS" || !receipt.tokenId) {
      throw new Error("HTS_TOKEN_CREATE_FAILED");
    }
    state.HEDERA_TOKEN_ID = receipt.tokenId.toString();
    persistEnv();
  }

  const pool = await mirrorAccount(state.HEDERA_POOL_ID);
  const tokenAssociation = (await fetch(
    `${mirrorUrl}/api/v1/accounts/${state.HEDERA_POOL_ID}/tokens?token.id=${state.HEDERA_TOKEN_ID}`
  ).then((response) => response.json())) as { tokens?: Array<{ token_id: string }> };
  if (!tokenAssociation.tokens?.some((token) => token.token_id === state.HEDERA_TOKEN_ID)) {
    process.stdout.write("Associating pool with Advance Note NFT...\n");
    const transaction = await (
      await new TokenAssociateTransaction()
        .setAccountId(AccountId.fromString(pool.account))
        .setTokenIds([state.HEDERA_TOKEN_ID])
        .setMaxTransactionFee(new Hbar(2))
        .freezeWith(client)
        .sign(poolKey)
    ).execute(client);
    const receipt = await transaction.getReceipt(client);
    if (receipt.status.toString() !== "SUCCESS") throw new Error("POOL_ASSOCIATION_FAILED");
  }
  writeEvidence();
  process.stdout.write(
    `Provisioning complete. Secrets: ${path.basename(envPath)} (mode 0600). Public evidence: ${path.basename(evidencePath)}.\n`
  );
} finally {
  client.close();
}
