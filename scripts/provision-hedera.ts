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
const stableInitialSupply = 1_000_000_000_000_000n;
const stableCreationOperatorTargetTinybar = 1_620_000_000n;
const entityCreationFeeBudgetTinybar = 200_000_000;
const operationalOperatorTargetTinybar = 40_000_000n;
const operationalTreasuryReserveTinybar = 50_000_000n;
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
    "HEDERA_STABLE_TOKEN_ID",
    "HEDERA_COLLATERAL_TOKEN_ID",
    "HEDERA_ESCROW_ID",
    "HEDERA_ESCROW_KEY",
    "HEDERA_RECIPIENT_ID",
    "HEDERA_MIRROR_URL",
    "POLICY_FIXED_CAP_MINOR",
    "TREASURY_STABLE_RESERVE_MINOR"
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
    const key = PrivateKey.fromString(state.HEDERA_OPERATOR_KEY);
    if (key.publicKey.toStringRaw() !== account.key?.key.toLowerCase()) {
      throw new Error("OPERATOR_PRIVATE_KEY_MISMATCH");
    }
    return key;
  }
  const phrase = await readHidden("Operator mnemonic (hidden; never stored): ");
  const words = phrase.split(/\s+/);
  if (words.length !== 24) throw new Error("OPERATOR_MNEMONIC_MUST_HAVE_24_WORDS");
  const mnemonic = await Mnemonic.fromWords(words);
  const candidates = [
    await mnemonic.toStandardEd25519PrivateKey(),
    await mnemonic.toLegacyPrivateKey()
  ];
  const key = candidates.find(
    (candidate) => candidate.publicKey.toStringRaw() === account.key?.key.toLowerCase()
  );
  if (!key) throw new Error("OPERATOR_MNEMONIC_DOES_NOT_MATCH_ACCOUNT");
  return key;
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
    !state.HEDERA_TOKEN_ID ||
    !state.HEDERA_STABLE_TOKEN_ID ||
    !state.HEDERA_COLLATERAL_TOKEN_ID ||
    !state.HEDERA_ESCROW_ID
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
    collateralEscrowAccountId: state.HEDERA_ESCROW_ID,
    collateralToken: {
      tokenId: state.HEDERA_COLLATERAL_TOKEN_ID,
      name: "unlockd.bond Demo Equity Collateral",
      symbol: "UBEQ",
      label: "Synthetic demo collateral — no real shares or value"
    },
    stableToken: {
      tokenId: state.HEDERA_STABLE_TOKEN_ID,
      name: "USDC DEMO",
      symbol: "USDC",
      decimals: 6,
      initialAndMaximumSupply: "1000000000",
      label: "Demo USDC — no real value"
    },
    recipientAccountId: state.HEDERA_RECIPIENT_ID,
    publicEvidence: {
      operator: `${hashscanUrl}/account/${state.HEDERA_OPERATOR_ID}`,
      treasury: `${hashscanUrl}/account/${state.HEDERA_TREASURY_ID}`,
      pool: `${hashscanUrl}/account/${state.HEDERA_POOL_ID}`,
      topic: `${hashscanUrl}/topic/${state.HEDERA_TOPIC_ID}`,
      token: `${hashscanUrl}/token/${state.HEDERA_TOKEN_ID}`,
      stableToken: `${hashscanUrl}/token/${state.HEDERA_STABLE_TOKEN_ID}`,
      collateralToken: `${hashscanUrl}/token/${state.HEDERA_COLLATERAL_TOKEN_ID}`,
      collateralEscrow: `${hashscanUrl}/account/${state.HEDERA_ESCROW_ID}`,
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
  (state.HEDERA_TREASURY_ID ? 0 : 300_000_000) +
  (state.HEDERA_POOL_ID ? 0 : 100_000_000) +
  (state.HEDERA_ESCROW_ID ? 0 : 100_000_000) +
  (state.HEDERA_TOPIC_ID ? 0 : entityCreationFeeBudgetTinybar) +
  (state.HEDERA_TOKEN_ID ? 0 : entityCreationFeeBudgetTinybar) +
  (state.HEDERA_COLLATERAL_TOKEN_ID ? 0 : entityCreationFeeBudgetTinybar);
if (plannedInitialBalance > 0 && account.balance.balance < plannedInitialBalance + 150_000_000) {
  const availableHbar = (account.balance.balance / 100_000_000).toFixed(8);
  const requiredHbar = ((plannedInitialBalance + 150_000_000) / 100_000_000).toFixed(2);
  throw new Error(
    `OPERATOR_BALANCE_TOO_LOW_FOR_REMAINING_PROVISIONING: available=${availableHbar}_HBAR required_at_least=${requiredHbar}_HBAR`
  );
}
const key = await operatorKey(account);
const treasuryKey = state.HEDERA_TREASURY_KEY
  ? PrivateKey.fromString(state.HEDERA_TREASURY_KEY)
  : PrivateKey.generateED25519();
const poolKey = state.HEDERA_POOL_KEY
  ? PrivateKey.fromString(state.HEDERA_POOL_KEY)
  : PrivateKey.generateED25519();
const escrowKey = state.HEDERA_ESCROW_KEY
  ? PrivateKey.fromString(state.HEDERA_ESCROW_KEY)
  : PrivateKey.generateED25519();
const supplyKey = state.HEDERA_SUPPLY_KEY
  ? PrivateKey.fromString(state.HEDERA_SUPPLY_KEY)
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
  HEDERA_STABLE_TOKEN_ID: state.HEDERA_STABLE_TOKEN_ID ?? "",
  HEDERA_COLLATERAL_TOKEN_ID: state.HEDERA_COLLATERAL_TOKEN_ID ?? "",
  HEDERA_ESCROW_ID: state.HEDERA_ESCROW_ID ?? "",
  HEDERA_ESCROW_KEY: escrowKey.toStringDer(),
  HEDERA_RECIPIENT_ID: state.HEDERA_RECIPIENT_ID ?? operatorIdText,
  HEDERA_MIRROR_URL: mirrorUrl,
  POLICY_FIXED_CAP_MINOR: state.POLICY_FIXED_CAP_MINOR ?? "1000",
  TREASURY_STABLE_RESERVE_MINOR: state.TREASURY_STABLE_RESERVE_MINOR ?? "10000"
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
  if (!state.HEDERA_ESCROW_ID) {
    process.stdout.write("Creating 1 HBAR synthetic collateral escrow account...\n");
    state.HEDERA_ESCROW_ID = await createAccount(
      client,
      escrowKey,
      new Hbar(1),
      "unlockd.bond Testnet synthetic collateral escrow"
    );
    persistEnv();
  }
  const [currentOperator, currentTreasury, currentPool] = await Promise.all([
    mirrorAccount(operatorIdText),
    mirrorAccount(state.HEDERA_TREASURY_ID),
    mirrorAccount(state.HEDERA_POOL_ID)
  ]);
  const operatorTinybar = BigInt(currentOperator.balance.balance);
  const treasuryTinybar = BigInt(currentTreasury.balance.balance);
  if (operatorTinybar < operationalOperatorTargetTinybar) {
    const transferTinybar = operationalOperatorTargetTinybar - operatorTinybar;
    const poolTinybar = BigInt(currentPool.balance.balance);
    const treasuryAvailable = treasuryTinybar - operationalTreasuryReserveTinybar;
    const poolAvailable = poolTinybar - operationalTreasuryReserveTinybar;
    const useTreasury = treasuryAvailable >= transferTinybar;
    const usePool = !useTreasury && poolAvailable >= transferTinybar;
    if (!useTreasury && !usePool) {
      throw new Error("TREASURY_HBAR_RESERVE_REQUIRED");
    }
    const donorId = useTreasury ? state.HEDERA_TREASURY_ID : state.HEDERA_POOL_ID;
    const donorKey = useTreasury ? treasuryKey : poolKey;
    process.stdout.write("Rebalancing operational Testnet HBAR to fee payer...\n");
    const treasuryClient = Client.forTestnet().setOperator(AccountId.fromString(donorId), donorKey);
    try {
      const transaction = await new TransferTransaction()
        .addHbarTransfer(AccountId.fromString(donorId), Hbar.fromTinybars(-transferTinybar))
        .addHbarTransfer(AccountId.fromString(operatorIdText), Hbar.fromTinybars(transferTinybar))
        .setTransactionMemo("unlockd.bond operational fee balance")
        .execute(treasuryClient);
      const receipt = await transaction.getReceipt(treasuryClient);
      if (receipt.status.toString() !== "SUCCESS") {
        throw new Error("OPERATOR_FEE_REBALANCE_FAILED");
      }
    } finally {
      treasuryClient.close();
    }
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
    process.stdout.write("Creating Advance Note NFT collection...\n");
    const frozen = new TokenCreateTransaction()
      .setTokenName("unlockd.bond Advance Note")
      .setTokenSymbol("UBAN")
      .setTokenType(TokenType.NonFungibleUnique)
      .setSupplyType(TokenSupplyType.Infinite)
      .setTreasuryAccountId(AccountId.fromString(state.HEDERA_TREASURY_ID))
      .setSupplyKey(supplyKey.publicKey)
      .setTokenMemo("Testnet receivable representation; not stock or legal collateral")
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
  if (!state.HEDERA_COLLATERAL_TOKEN_ID) {
    process.stdout.write("Creating Demo Equity Collateral NFT collection...\n");
    const frozen = new TokenCreateTransaction()
      .setTokenName("unlockd.bond Demo Equity Collateral")
      .setTokenSymbol("UBEQ")
      .setTokenType(TokenType.NonFungibleUnique)
      .setSupplyType(TokenSupplyType.Infinite)
      .setTreasuryAccountId(AccountId.fromString(state.HEDERA_TREASURY_ID))
      .setSupplyKey(supplyKey.publicKey)
      .setTokenMemo("Synthetic demo collateral; no real shares or value")
      .setMaxTransactionFee(new Hbar(16))
      .freezeWith(client);
    const treasurySigned = await frozen.sign(treasuryKey);
    const supplySigned = await treasurySigned.sign(supplyKey);
    const transaction = await supplySigned.execute(client);
    const receipt = await transaction.getReceipt(client);
    if (receipt.status.toString() !== "SUCCESS" || !receipt.tokenId) {
      throw new Error("HTS_COLLATERAL_TOKEN_CREATE_FAILED");
    }
    state.HEDERA_COLLATERAL_TOKEN_ID = receipt.tokenId.toString();
    persistEnv();
  }
  if (!state.HEDERA_STABLE_TOKEN_ID) {
    const [operatorBalance, treasuryBalance] = await Promise.all([
      new AccountBalanceQuery().setAccountId(AccountId.fromString(operatorIdText)).execute(client),
      new AccountBalanceQuery()
        .setAccountId(AccountId.fromString(state.HEDERA_TREASURY_ID))
        .execute(client)
    ]);
    const operatorTinybar = BigInt(operatorBalance.hbars.toTinybars().toString());
    if (operatorTinybar < stableCreationOperatorTargetTinybar) {
      const transferTinybar = stableCreationOperatorTargetTinybar - operatorTinybar + 1_000_000n;
      const treasuryTinybar = BigInt(treasuryBalance.hbars.toTinybars().toString());
      if (treasuryTinybar - transferTinybar < 50_000_000n) {
        throw new Error("OPERATOR_BALANCE_TOO_LOW_FOR_STABLE_TOKEN_CREATION");
      }
      process.stdout.write("Rebalancing Testnet HBAR from treasury to fee payer...\n");
      const frozen = new TransferTransaction()
        .addHbarTransfer(
          AccountId.fromString(state.HEDERA_TREASURY_ID),
          Hbar.fromTinybars(-transferTinybar)
        )
        .addHbarTransfer(AccountId.fromString(operatorIdText), Hbar.fromTinybars(transferTinybar))
        .setTransactionMemo("unlockd.bond stable-token provisioning fee")
        .freezeWith(client);
      const signed = await frozen.sign(treasuryKey);
      const transaction = await signed.execute(client);
      const receipt = await transaction.getReceipt(client);
      if (receipt.status.toString() !== "SUCCESS") {
        throw new Error("OPERATOR_FEE_REBALANCE_FAILED");
      }
    }
    process.stdout.write("Creating fixed-supply USDC DEMO token...\n");
    const frozen = new TokenCreateTransaction()
      .setTokenName("USDC DEMO")
      .setTokenSymbol("USDC")
      .setTokenType(TokenType.FungibleCommon)
      .setDecimals(6)
      .setInitialSupply(stableInitialSupply)
      .setSupplyType(TokenSupplyType.Finite)
      .setMaxSupply(stableInitialSupply)
      .setTreasuryAccountId(AccountId.fromString(state.HEDERA_TREASURY_ID))
      .setTokenMemo("Demo USDC; no real value; not Circle-issued")
      .setMaxTransactionFee(new Hbar(16))
      .freezeWith(client);
    const signed = await frozen.sign(treasuryKey);
    const transaction = await signed.execute(client);
    const receipt = await transaction.getReceipt(client);
    if (receipt.status.toString() !== "SUCCESS" || !receipt.tokenId) {
      throw new Error("HTS_STABLE_TOKEN_CREATE_FAILED");
    }
    state.HEDERA_STABLE_TOKEN_ID = receipt.tokenId.toString();
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
        .freezeWith(client)
        .sign(poolKey)
    ).execute(client);
    const receipt = await transaction.getReceipt(client);
    if (receipt.status.toString() !== "SUCCESS") throw new Error("POOL_ASSOCIATION_FAILED");
  }
  const recipientId = state.HEDERA_RECIPIENT_ID;
  const stableAssociation = (await fetch(
    `${mirrorUrl}/api/v1/accounts/${recipientId}/tokens?token.id=${state.HEDERA_STABLE_TOKEN_ID}`
  ).then((response) => response.json())) as { tokens?: Array<{ token_id: string }> };
  if (!stableAssociation.tokens?.some((token) => token.token_id === state.HEDERA_STABLE_TOKEN_ID)) {
    if (recipientId !== operatorIdText) {
      throw new Error("RECIPIENT_STABLE_ASSOCIATION_MUST_BE_COMPLETED_BY_RECIPIENT");
    }
    process.stdout.write("Associating configured recipient with USDC DEMO...\n");
    const transaction = await (
      await new TokenAssociateTransaction()
        .setAccountId(AccountId.fromString(recipientId))
        .setTokenIds([state.HEDERA_STABLE_TOKEN_ID])
        .freezeWith(client)
        .sign(key)
    ).execute(client);
    const receipt = await transaction.getReceipt(client);
    if (receipt.status.toString() !== "SUCCESS") {
      throw new Error("RECIPIENT_STABLE_ASSOCIATION_FAILED");
    }
  }
  const collateralAssociations = [
    {
      accountId: state.HEDERA_ESCROW_ID,
      accountKey: escrowKey,
      failure: "ESCROW_COLLATERAL_ASSOCIATION_FAILED"
    },
    {
      accountId: state.HEDERA_POOL_ID,
      accountKey: poolKey,
      failure: "POOL_COLLATERAL_ASSOCIATION_FAILED"
    },
    {
      accountId: recipientId,
      accountKey: recipientId === operatorIdText ? key : null,
      failure: "RECIPIENT_COLLATERAL_ASSOCIATION_FAILED"
    }
  ];
  for (const association of collateralAssociations) {
    const relationship = (await fetch(
      `${mirrorUrl}/api/v1/accounts/${association.accountId}/tokens?token.id=${state.HEDERA_COLLATERAL_TOKEN_ID}`
    ).then((response) => response.json())) as { tokens?: Array<{ token_id: string }> };
    if (relationship.tokens?.some((token) => token.token_id === state.HEDERA_COLLATERAL_TOKEN_ID)) {
      continue;
    }
    if (!association.accountKey) {
      throw new Error("RECIPIENT_COLLATERAL_ASSOCIATION_MUST_BE_COMPLETED_BY_RECIPIENT");
    }
    process.stdout.write(`Associating ${association.accountId} with Demo Equity Collateral...\n`);
    const transaction = await (
      await new TokenAssociateTransaction()
        .setAccountId(AccountId.fromString(association.accountId))
        .setTokenIds([state.HEDERA_COLLATERAL_TOKEN_ID])
        .freezeWith(client)
        .sign(association.accountKey)
    ).execute(client);
    const receipt = await transaction.getReceipt(client);
    if (receipt.status.toString() !== "SUCCESS") throw new Error(association.failure);
  }
  writeEvidence();
  process.stdout.write(
    `Provisioning complete. Secrets: ${path.basename(envPath)} (mode 0600). Public evidence: ${path.basename(evidencePath)}.\n`
  );
} finally {
  client.close();
}
