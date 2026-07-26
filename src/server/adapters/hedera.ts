import { createHash } from "node:crypto";
import {
  AccountBalanceQuery,
  AccountId,
  Client,
  PrivateKey,
  TokenBurnTransaction,
  TokenId,
  TokenMintTransaction,
  TopicId,
  TopicMessageSubmitTransaction,
  type TransactionResponse,
  TransferTransaction
} from "@hashgraph/sdk";
import {
  type FundingProgress,
  type FundingResult,
  type FundingTransaction,
  fundingResultSchema,
  type RepaymentProgress,
  type RepaymentResult,
  repaymentResultSchema
} from "../../domain/schemas.js";
import {
  type FundingPacket,
  type FundingProgressRecorder,
  type PaymentProvider,
  type RepaymentPacket,
  type RepaymentProgressRecorder,
  STABLE_TOKEN_DECIMALS,
  usdMinorToStableUnits
} from "./types.js";

export interface HederaConfig {
  operatorId: string;
  operatorKey: string;
  treasuryId: string;
  treasuryKey: string;
  supplyKey: string;
  poolId: string;
  poolKey: string;
  topicId: string;
  tokenId: string;
  stableTokenId: string;
  recipientId: string;
  mirrorUrl: string;
  treasuryStableReserveMinor: number;
  requireTeeVerification: boolean;
}

interface MirrorToken {
  decimals: string;
  deleted: boolean;
  name: string;
  symbol: string;
  token_id: string;
  total_supply: string;
  treasury_account_id: string;
  type: "FUNGIBLE_COMMON" | "NON_FUNGIBLE_UNIQUE";
}

interface MirrorTokenRelationships {
  tokens?: Array<{ token_id: string }>;
}

interface MirrorNft {
  account_id: string | null;
  deleted: boolean;
  serial_number: number;
  token_id: string;
}

const MIN_OPERATOR_HBAR_TINYBAR = 20_000_000n;

function privateKey(value: string): PrivateKey {
  try {
    return PrivateKey.fromString(value);
  } catch {
    throw new Error("HEDERA_PRIVATE_KEY_INVALID");
  }
}

function encodeMetadata(packet: FundingPacket): Uint8Array {
  const commitment = createHash("sha256")
    .update(
      [
        "UNLOCKD_BOND_ADVANCE_NOTE_V2",
        packet.advanceId,
        packet.decisionCommitment,
        packet.marketCommitment
      ].join(":")
    )
    .digest();
  return Uint8Array.from([0x55, 0x42, 0x41, 0x4e, 0x02, ...commitment]);
}

function mirrorTransactionId(transactionId: string): string {
  return transactionId.replace("@", "-").replace(/(\d+)\.(\d+)$/, "$1-$2");
}

function hashscanTransactionUrl(consensusTimestamp: string): string {
  return `https://hashscan.io/testnet/transaction/${encodeURIComponent(consensusTimestamp)}`;
}

async function transactionEvidence(
  response: TransactionResponse,
  client: Client,
  mirrorUrl: string,
  status: "SUCCESS" | "SIMULATED"
): Promise<FundingTransaction> {
  const transactionId = response.transactionId.toString();
  const record = await response.getRecord(client);
  const consensusTimestamp = record.consensusTimestamp.toString();
  return {
    transactionId,
    consensusTimestamp,
    consensusStatus: status,
    mirrorUrl: `${mirrorUrl}/api/v1/transactions/${encodeURIComponent(
      mirrorTransactionId(transactionId)
    )}`,
    hashscanUrl: hashscanTransactionUrl(consensusTimestamp)
  };
}

export class HederaPaymentProvider implements PaymentProvider {
  private readonly client: Client;
  private readonly operatorId: AccountId;
  private readonly treasuryId: AccountId;
  private readonly poolId: AccountId;
  private readonly topicId: TopicId;
  private readonly tokenId: TokenId;
  private readonly stableTokenId: TokenId;
  private readonly treasuryKey: PrivateKey;
  private readonly supplyKey: PrivateKey;
  private readonly poolKey: PrivateKey;

  constructor(private readonly config: HederaConfig) {
    this.operatorId = AccountId.fromString(config.operatorId);
    this.treasuryId = AccountId.fromString(config.treasuryId);
    this.poolId = AccountId.fromString(config.poolId);
    this.topicId = TopicId.fromString(config.topicId);
    this.tokenId = TokenId.fromString(config.tokenId);
    this.stableTokenId = TokenId.fromString(config.stableTokenId);
    this.treasuryKey = privateKey(config.treasuryKey);
    this.supplyKey = privateKey(config.supplyKey);
    this.poolKey = privateKey(config.poolKey);
    this.client = Client.forTestnet().setOperator(this.operatorId, privateKey(config.operatorKey));
  }

  async fund(
    packet: FundingPacket,
    recordProgress?: FundingProgressRecorder
  ): Promise<FundingResult> {
    if (this.config.requireTeeVerification && !packet.zeroGTeeVerified) {
      throw new Error("TEE_VERIFICATION_REQUIRED");
    }
    if (packet.amountStableUnits !== usdMinorToStableUnits(packet.amountMinor)) {
      throw new Error("STABLE_AMOUNT_MISMATCH");
    }
    const recipient = AccountId.fromString(packet.recipientAccountId);
    await this.assertFundingReady(recipient, packet.amountStableUnits);

    const transactions: FundingProgress["transactions"] = {};
    const decisionEvent = {
      v: 2,
      event: "ADVANCE_AUTHORIZED",
      advanceId: packet.advanceId,
      payout: {
        tokenId: this.stableTokenId.toString(),
        symbol: "USDC",
        decimals: STABLE_TOKEN_DECIMALS,
        amountUnits: packet.amountStableUnits.toString(),
        amountMinor: packet.amountMinor
      },
      employeeCommitment: packet.employeeCommitment,
      decisionCommitment: packet.decisionCommitment,
      marketCommitment: packet.marketCommitment,
      graphBlock: packet.graphBlock,
      graphDeployment: packet.graphDeployment,
      zeroGRequestId: packet.zeroGRequestId,
      zeroGProvider: packet.zeroGProvider,
      zeroGTeeVerified: packet.zeroGTeeVerified
    };
    const authorized = await new TopicMessageSubmitTransaction()
      .setTopicId(this.topicId)
      .setMessage(JSON.stringify(decisionEvent))
      .execute(this.client);
    const authorizedReceipt = await authorized.getReceipt(this.client);
    if (authorizedReceipt.status.toString() !== "SUCCESS") {
      throw new Error("HCS_AUTHORIZATION_FAILED");
    }
    const authorizationSequenceNumber = authorizedReceipt.topicSequenceNumber?.toString();
    if (!authorizationSequenceNumber) throw new Error("HCS_AUTHORIZATION_SEQUENCE_MISSING");
    transactions.authorization = await transactionEvidence(
      authorized,
      this.client,
      this.config.mirrorUrl,
      "SUCCESS"
    );
    await recordProgress?.({
      version: 2,
      stage: "AUTHORIZED",
      transactions: { ...transactions },
      authorizationSequenceNumber
    });

    const mint = await (
      await new TokenMintTransaction()
        .setTokenId(this.tokenId)
        .setMetadata([encodeMetadata(packet)])
        .freezeWith(this.client)
        .sign(this.supplyKey)
    ).execute(this.client);
    const mintReceipt = await mint.getReceipt(this.client);
    if (mintReceipt.status.toString() !== "SUCCESS" || !mintReceipt.serials[0]) {
      throw new Error("HTS_MINT_FAILED");
    }
    const serialNumber = mintReceipt.serials[0];
    const serial = serialNumber.toString();
    transactions.noteMint = await transactionEvidence(
      mint,
      this.client,
      this.config.mirrorUrl,
      "SUCCESS"
    );
    await recordProgress?.({
      version: 2,
      stage: "NOTE_MINTED",
      transactions: { ...transactions },
      noteSerial: serial,
      authorizationSequenceNumber
    });

    const transfer = new TransferTransaction()
      .addTokenTransfer(this.stableTokenId, this.treasuryId, -packet.amountStableUnits)
      .addTokenTransfer(this.stableTokenId, recipient, packet.amountStableUnits)
      .addNftTransfer(this.tokenId, serialNumber, this.treasuryId, this.poolId)
      .setTransactionMemo(`unlockd.bond ${packet.advanceId}`.slice(0, 100))
      .freezeWith(this.client);
    const signed =
      this.treasuryId.toString() === this.operatorId.toString()
        ? transfer
        : await transfer.sign(this.treasuryKey);
    const executed = await signed.execute(this.client);
    const settlementReceipt = await executed.getReceipt(this.client);
    if (settlementReceipt.status.toString() !== "SUCCESS") {
      throw new Error("HEDERA_FUNDING_FAILED");
    }
    transactions.settlement = await transactionEvidence(
      executed,
      this.client,
      this.config.mirrorUrl,
      "SUCCESS"
    );
    await recordProgress?.({
      version: 2,
      stage: "SETTLED",
      transactions: { ...transactions },
      noteSerial: serial,
      authorizationSequenceNumber
    });

    const fundedEvent = {
      v: 2,
      event: "ADVANCE_FUNDED",
      advanceId: packet.advanceId,
      payout: {
        tokenId: this.stableTokenId.toString(),
        symbol: "USDC",
        decimals: STABLE_TOKEN_DECIMALS,
        amountUnits: packet.amountStableUnits.toString()
      },
      note: `${this.tokenId.toString()}/${serial}`,
      authorizationTxId: transactions.authorization.transactionId,
      noteMintTxId: transactions.noteMint.transactionId,
      settlementTxId: transactions.settlement.transactionId
    };
    const funded = await new TopicMessageSubmitTransaction()
      .setTopicId(this.topicId)
      .setMessage(JSON.stringify(fundedEvent))
      .execute(this.client);
    const fundedReceipt = await funded.getReceipt(this.client);
    if (fundedReceipt.status.toString() !== "SUCCESS") {
      throw new Error("HCS_FUNDED_EVENT_FAILED");
    }
    const fundedSequenceNumber = fundedReceipt.topicSequenceNumber?.toString();
    if (!fundedSequenceNumber) throw new Error("HCS_FUNDED_SEQUENCE_MISSING");
    transactions.fundedEvent = await transactionEvidence(
      funded,
      this.client,
      this.config.mirrorUrl,
      "SUCCESS"
    );
    const finalProgress = {
      version: 2 as const,
      stage: "FUNDED" as const,
      transactions: { ...transactions },
      noteSerial: serial,
      authorizationSequenceNumber,
      fundedSequenceNumber
    };
    await recordProgress?.(finalProgress);

    const stableTokenId = this.stableTokenId.toString();
    const noteTokenId = this.tokenId.toString();
    const topicId = this.topicId.toString();
    return fundingResultSchema.parse({
      version: 2,
      asset: {
        tokenId: stableTokenId,
        name: "USDC DEMO",
        symbol: "USDC",
        decimals: STABLE_TOKEN_DECIMALS,
        amountUnits: packet.amountStableUnits.toString(),
        amountMinor: packet.amountMinor,
        label: "Demo USDC — no real value",
        mirrorUrl: `${this.config.mirrorUrl}/api/v1/tokens/${stableTokenId}`,
        hashscanUrl: `https://hashscan.io/testnet/token/${stableTokenId}`
      },
      note: {
        tokenId: noteTokenId,
        serial,
        mirrorUrl: `${this.config.mirrorUrl}/api/v1/tokens/${noteTokenId}/nfts/${serial}`,
        hashscanUrl: `https://hashscan.io/testnet/token/${noteTokenId}/${serial}`
      },
      topic: {
        topicId,
        authorizationSequenceNumber,
        fundedSequenceNumber,
        hashscanUrl: `https://hashscan.io/testnet/topic/${topicId}`
      },
      transactions,
      simulated: false
    });
  }

  async repay(
    packet: RepaymentPacket,
    recordProgress?: RepaymentProgressRecorder
  ): Promise<RepaymentResult> {
    if (packet.amountStableUnits !== usdMinorToStableUnits(packet.amountMinor)) {
      throw new Error("STABLE_AMOUNT_MISMATCH");
    }
    if (packet.noteTokenId !== this.tokenId.toString()) {
      throw new Error("REPAYMENT_NOTE_TOKEN_MISMATCH");
    }
    if (packet.payerAccountId !== this.config.recipientId) {
      throw new Error("REPAYMENT_PAYER_CONFIG_CHANGED");
    }
    if (packet.payerAccountId !== this.operatorId.toString()) {
      throw new Error("REPAYMENT_SIGNER_UNAVAILABLE");
    }
    const payer = AccountId.fromString(packet.payerAccountId);
    const serialNumber = Number(packet.noteSerial);
    if (!Number.isSafeInteger(serialNumber) || serialNumber <= 0) {
      throw new Error("REPAYMENT_NOTE_SERIAL_INVALID");
    }
    await this.assertRepaymentReady(payer, packet.amountStableUnits, serialNumber);

    const transactions: RepaymentProgress["transactions"] = {};
    const authorizationEvent = {
      v: 1,
      event: "REPAYMENT_AUTHORIZED",
      repaymentId: packet.repaymentId,
      advanceId: packet.advanceId,
      payerAccountId: payer.toString(),
      repayment: {
        tokenId: this.stableTokenId.toString(),
        symbol: "USDC",
        decimals: STABLE_TOKEN_DECIMALS,
        amountUnits: packet.amountStableUnits.toString(),
        amountMinor: packet.amountMinor
      },
      note: `${this.tokenId.toString()}/${packet.noteSerial}`,
      issuanceSettlementTxId: packet.issuanceSettlementTransactionId
    };
    const authorization = await new TopicMessageSubmitTransaction()
      .setTopicId(this.topicId)
      .setMessage(JSON.stringify(authorizationEvent))
      .execute(this.client);
    const authorizationReceipt = await authorization.getReceipt(this.client);
    if (authorizationReceipt.status.toString() !== "SUCCESS") {
      throw new Error("HCS_REPAYMENT_AUTHORIZATION_FAILED");
    }
    const authorizationSequenceNumber = authorizationReceipt.topicSequenceNumber?.toString();
    if (!authorizationSequenceNumber) {
      throw new Error("HCS_REPAYMENT_AUTHORIZATION_SEQUENCE_MISSING");
    }
    transactions.authorization = await transactionEvidence(
      authorization,
      this.client,
      this.config.mirrorUrl,
      "SUCCESS"
    );
    await recordProgress?.({
      version: 1,
      repaymentId: packet.repaymentId,
      stage: "AUTHORIZED",
      transactions: { ...transactions },
      authorizationSequenceNumber
    });

    const transfer = await new TransferTransaction()
      .addTokenTransfer(this.stableTokenId, payer, -packet.amountStableUnits)
      .addTokenTransfer(this.stableTokenId, this.treasuryId, packet.amountStableUnits)
      .addNftTransfer(this.tokenId, serialNumber, this.poolId, this.treasuryId)
      .setTransactionMemo(`unlockd.bond repay ${packet.advanceId}`.slice(0, 100))
      .freezeWith(this.client);
    const poolSigned =
      this.poolId.toString() === this.operatorId.toString()
        ? transfer
        : await transfer.sign(this.poolKey);
    const settlement = await poolSigned.execute(this.client);
    const settlementReceipt = await settlement.getReceipt(this.client);
    if (settlementReceipt.status.toString() !== "SUCCESS") {
      throw new Error("HEDERA_REPAYMENT_SETTLEMENT_FAILED");
    }
    transactions.settlement = await transactionEvidence(
      settlement,
      this.client,
      this.config.mirrorUrl,
      "SUCCESS"
    );
    await recordProgress?.({
      version: 1,
      repaymentId: packet.repaymentId,
      stage: "SETTLED",
      transactions: { ...transactions },
      authorizationSequenceNumber
    });

    const burn = await (
      await new TokenBurnTransaction()
        .setTokenId(this.tokenId)
        .setSerials([serialNumber])
        .freezeWith(this.client)
        .sign(this.supplyKey)
    ).execute(this.client);
    const burnReceipt = await burn.getReceipt(this.client);
    if (burnReceipt.status.toString() !== "SUCCESS") {
      throw new Error("HEDERA_NOTE_BURN_FAILED");
    }
    transactions.noteBurn = await transactionEvidence(
      burn,
      this.client,
      this.config.mirrorUrl,
      "SUCCESS"
    );
    await recordProgress?.({
      version: 1,
      repaymentId: packet.repaymentId,
      stage: "NOTE_RETIRED",
      transactions: { ...transactions },
      authorizationSequenceNumber
    });

    const repaidEvent = {
      v: 1,
      event: "ADVANCE_REPAID",
      repaymentId: packet.repaymentId,
      advanceId: packet.advanceId,
      repayment: {
        tokenId: this.stableTokenId.toString(),
        amountUnits: packet.amountStableUnits.toString()
      },
      note: `${this.tokenId.toString()}/${packet.noteSerial}`,
      repaymentAuthorizationTxId: transactions.authorization.transactionId,
      settlementTxId: transactions.settlement.transactionId,
      noteBurnTxId: transactions.noteBurn.transactionId,
      remainingPrincipalUnits: "0"
    };
    const repaid = await new TopicMessageSubmitTransaction()
      .setTopicId(this.topicId)
      .setMessage(JSON.stringify(repaidEvent))
      .execute(this.client);
    const repaidReceipt = await repaid.getReceipt(this.client);
    if (repaidReceipt.status.toString() !== "SUCCESS") {
      throw new Error("HCS_REPAID_EVENT_FAILED");
    }
    const repaidSequenceNumber = repaidReceipt.topicSequenceNumber?.toString();
    if (!repaidSequenceNumber) throw new Error("HCS_REPAID_SEQUENCE_MISSING");
    transactions.repaidEvent = await transactionEvidence(
      repaid,
      this.client,
      this.config.mirrorUrl,
      "SUCCESS"
    );
    await recordProgress?.({
      version: 1,
      repaymentId: packet.repaymentId,
      stage: "REPAID",
      transactions: { ...transactions },
      authorizationSequenceNumber,
      repaidSequenceNumber
    });

    const stableTokenId = this.stableTokenId.toString();
    const noteTokenId = this.tokenId.toString();
    const topicId = this.topicId.toString();
    return repaymentResultSchema.parse({
      version: 1,
      repaymentId: packet.repaymentId,
      advanceId: packet.advanceId,
      payerAccountId: payer.toString(),
      treasuryAccountId: this.treasuryId.toString(),
      asset: {
        tokenId: stableTokenId,
        name: "USDC DEMO",
        symbol: "USDC",
        decimals: STABLE_TOKEN_DECIMALS,
        amountUnits: packet.amountStableUnits.toString(),
        amountMinor: packet.amountMinor,
        label: "Demo USDC — no real value",
        mirrorUrl: `${this.config.mirrorUrl}/api/v1/tokens/${stableTokenId}`,
        hashscanUrl: `https://hashscan.io/testnet/token/${stableTokenId}`
      },
      note: {
        tokenId: noteTokenId,
        serial: packet.noteSerial,
        retired: true,
        mirrorUrl: `${this.config.mirrorUrl}/api/v1/tokens/${noteTokenId}/nfts/${packet.noteSerial}`,
        hashscanUrl: `https://hashscan.io/testnet/token/${noteTokenId}/${packet.noteSerial}`
      },
      topic: {
        topicId,
        authorizationSequenceNumber,
        repaidSequenceNumber,
        hashscanUrl: `https://hashscan.io/testnet/topic/${topicId}`
      },
      transactions,
      remainingPrincipalMinor: 0,
      simulated: false
    });
  }

  async ready(): Promise<boolean> {
    try {
      const reserve = BigInt(this.config.treasuryStableReserveMinor) * 10_000n;
      await this.assertFundingReady(AccountId.fromString(this.config.recipientId), 0n, reserve);
      return true;
    } catch {
      return false;
    }
  }

  private async assertFundingReady(
    recipient: AccountId,
    amount: bigint,
    reserveOverride?: bigint
  ): Promise<void> {
    const reserve = reserveOverride ?? BigInt(this.config.treasuryStableReserveMinor) * 10_000n;
    const [
      operatorBalance,
      treasuryBalance,
      stableToken,
      noteToken,
      recipientAssociated,
      poolAssociated,
      _topic
    ] = await Promise.all([
      new AccountBalanceQuery().setAccountId(this.operatorId).execute(this.client),
      new AccountBalanceQuery().setAccountId(this.treasuryId).execute(this.client),
      this.mirrorJson<MirrorToken>(`/api/v1/tokens/${this.stableTokenId.toString()}`),
      this.mirrorJson<MirrorToken>(`/api/v1/tokens/${this.tokenId.toString()}`),
      this.isAssociated(recipient, this.stableTokenId),
      this.isAssociated(this.poolId, this.tokenId),
      this.mirrorJson<{ messages: unknown[] }>(
        `/api/v1/topics/${this.topicId.toString()}/messages?limit=1`
      )
    ]);
    if (BigInt(operatorBalance.hbars.toTinybars().toString()) < MIN_OPERATOR_HBAR_TINYBAR) {
      throw new Error("OPERATOR_HBAR_RESERVE_REQUIRED");
    }
    if (
      stableToken.deleted ||
      stableToken.token_id !== this.stableTokenId.toString() ||
      stableToken.name !== "USDC DEMO" ||
      stableToken.symbol !== "USDC" ||
      stableToken.decimals !== String(STABLE_TOKEN_DECIMALS) ||
      stableToken.total_supply !== "1000000000000000" ||
      stableToken.type !== "FUNGIBLE_COMMON" ||
      stableToken.treasury_account_id !== this.treasuryId.toString()
    ) {
      throw new Error("STABLE_TOKEN_CONFIG_INVALID");
    }
    if (
      noteToken.deleted ||
      noteToken.token_id !== this.tokenId.toString() ||
      noteToken.type !== "NON_FUNGIBLE_UNIQUE" ||
      noteToken.treasury_account_id !== this.treasuryId.toString()
    ) {
      throw new Error("NOTE_TOKEN_CONFIG_INVALID");
    }
    if (!recipientAssociated) throw new Error("RECIPIENT_STABLE_ASSOCIATION_REQUIRED");
    if (!poolAssociated) throw new Error("POOL_NOTE_ASSOCIATION_REQUIRED");
    const available = BigInt(treasuryBalance.tokens?.get(this.stableTokenId)?.toString() ?? "0");
    if (available - amount < reserve) throw new Error("TREASURY_STABLE_RESERVE_REQUIRED");
  }

  private async assertRepaymentReady(
    payer: AccountId,
    amount: bigint,
    serialNumber: number
  ): Promise<void> {
    const [operatorBalance, payerBalance, payerAssociated, treasuryAssociated, note] =
      await Promise.all([
        new AccountBalanceQuery().setAccountId(this.operatorId).execute(this.client),
        new AccountBalanceQuery().setAccountId(payer).execute(this.client),
        this.isAssociated(payer, this.stableTokenId),
        this.isAssociated(this.treasuryId, this.stableTokenId),
        this.mirrorJson<MirrorNft>(`/api/v1/tokens/${this.tokenId.toString()}/nfts/${serialNumber}`)
      ]);
    if (BigInt(operatorBalance.hbars.toTinybars().toString()) < MIN_OPERATOR_HBAR_TINYBAR) {
      throw new Error("OPERATOR_HBAR_RESERVE_REQUIRED");
    }
    if (!payerAssociated) throw new Error("REPAYMENT_PAYER_STABLE_ASSOCIATION_REQUIRED");
    if (!treasuryAssociated) throw new Error("TREASURY_STABLE_ASSOCIATION_REQUIRED");
    const payerStableBalance = BigInt(
      payerBalance.tokens?.get(this.stableTokenId)?.toString() ?? "0"
    );
    if (payerStableBalance < amount) throw new Error("REPAYMENT_STABLE_BALANCE_REQUIRED");
    if (
      note.deleted ||
      note.token_id !== this.tokenId.toString() ||
      note.serial_number !== serialNumber ||
      note.account_id !== this.poolId.toString()
    ) {
      throw new Error("POOL_NOTE_OWNERSHIP_REQUIRED");
    }
  }

  private async isAssociated(accountId: AccountId, tokenId: TokenId): Promise<boolean> {
    const relationships = await this.mirrorJson<MirrorTokenRelationships>(
      `/api/v1/accounts/${accountId.toString()}/tokens?token.id=${tokenId.toString()}`
    );
    return relationships.tokens?.some((token) => token.token_id === tokenId.toString()) ?? false;
  }

  private async mirrorJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.config.mirrorUrl}${path}`);
    if (!response.ok) throw new Error("HEDERA_MIRROR_PREFLIGHT_FAILED");
    return (await response.json()) as T;
  }
}
