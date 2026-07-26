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
  type FundingResult,
  type FundingTransaction,
  fundingResultSchema,
  type LiquidationResult,
  liquidationResultSchema,
  type RepaymentProgress,
  type RepaymentResult,
  repaymentResultSchema,
  repaymentResultV2Schema
} from "../../domain/schemas.js";
import {
  type FundingPacket,
  type FundingProgressRecorder,
  type LiquidationPacket,
  type LiquidationProgressRecorder,
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
  collateralTokenId: string;
  escrowId: string;
  escrowKey: string;
  collateralEnabled: boolean;
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

function encodeCollateralMetadata(packet: FundingPacket): Uint8Array {
  const commitment = createHash("sha256")
    .update(
      [
        "UNLOCKD_BOND_DEMO_EQUITY_COLLATERAL_V1",
        packet.advanceId,
        packet.assetSymbol,
        packet.grantType,
        packet.vestedUnits,
        packet.strikePriceMinor,
        packet.employeeCommitment
      ].join(":")
    )
    .digest();
  return Uint8Array.from([0x55, 0x42, 0x45, 0x51, 0x01, ...commitment]);
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
  private readonly collateralTokenId: TokenId;
  private readonly escrowId: AccountId;
  private readonly treasuryKey: PrivateKey;
  private readonly supplyKey: PrivateKey;
  private readonly poolKey: PrivateKey;
  private readonly escrowKey: PrivateKey;

  constructor(private readonly config: HederaConfig) {
    this.operatorId = AccountId.fromString(config.operatorId);
    this.treasuryId = AccountId.fromString(config.treasuryId);
    this.poolId = AccountId.fromString(config.poolId);
    this.topicId = TopicId.fromString(config.topicId);
    this.tokenId = TokenId.fromString(config.tokenId);
    this.stableTokenId = TokenId.fromString(config.stableTokenId);
    this.collateralTokenId = TokenId.fromString(config.collateralTokenId);
    this.escrowId = AccountId.fromString(config.escrowId);
    this.treasuryKey = privateKey(config.treasuryKey);
    this.supplyKey = privateKey(config.supplyKey);
    this.poolKey = privateKey(config.poolKey);
    this.escrowKey = privateKey(config.escrowKey);
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
    if (!this.config.collateralEnabled) {
      return this.fundWithoutCollateral(packet, recordProgress);
    }

    const transactions: {
      authorization?: FundingTransaction;
      noteMint?: FundingTransaction;
      collateralMint?: FundingTransaction;
      settlement?: FundingTransaction;
      fundedEvent?: FundingTransaction;
    } = {};
    const decisionEvent = {
      v: 3,
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
      zeroGTeeVerified: packet.zeroGTeeVerified,
      syntheticCollateral: {
        tokenId: this.collateralTokenId.toString(),
        assetSymbol: packet.assetSymbol,
        grantType: packet.grantType,
        vestedUnitsCommitment: createHash("sha256").update(packet.vestedUnits).digest("hex")
      }
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
      version: 3,
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
      version: 3,
      stage: "NOTE_MINTED",
      transactions: { ...transactions },
      noteSerial: serial,
      authorizationSequenceNumber
    });

    const collateralMint = await (
      await new TokenMintTransaction()
        .setTokenId(this.collateralTokenId)
        .setMetadata([encodeCollateralMetadata(packet)])
        .freezeWith(this.client)
        .sign(this.supplyKey)
    ).execute(this.client);
    const collateralMintReceipt = await collateralMint.getReceipt(this.client);
    if (
      collateralMintReceipt.status.toString() !== "SUCCESS" ||
      !collateralMintReceipt.serials[0]
    ) {
      throw new Error("HTS_COLLATERAL_MINT_FAILED");
    }
    const collateralSerialNumber = collateralMintReceipt.serials[0];
    const collateralSerial = collateralSerialNumber.toString();
    transactions.collateralMint = await transactionEvidence(
      collateralMint,
      this.client,
      this.config.mirrorUrl,
      "SUCCESS"
    );
    await recordProgress?.({
      version: 3,
      stage: "COLLATERAL_MINTED",
      transactions: { ...transactions },
      noteSerial: serial,
      collateralSerial,
      authorizationSequenceNumber
    });

    const transfer = new TransferTransaction()
      .addTokenTransfer(this.stableTokenId, this.treasuryId, -packet.amountStableUnits)
      .addTokenTransfer(this.stableTokenId, recipient, packet.amountStableUnits)
      .addNftTransfer(this.tokenId, serialNumber, this.treasuryId, this.poolId)
      .addNftTransfer(
        this.collateralTokenId,
        collateralSerialNumber,
        this.treasuryId,
        this.escrowId
      )
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
      version: 3,
      stage: "SETTLED",
      transactions: { ...transactions },
      noteSerial: serial,
      collateralSerial,
      authorizationSequenceNumber
    });

    const fundedEvent = {
      v: 3,
      event: "ADVANCE_FUNDED",
      advanceId: packet.advanceId,
      payout: {
        tokenId: this.stableTokenId.toString(),
        symbol: "USDC",
        decimals: STABLE_TOKEN_DECIMALS,
        amountUnits: packet.amountStableUnits.toString()
      },
      note: `${this.tokenId.toString()}/${serial}`,
      collateral: `${this.collateralTokenId.toString()}/${collateralSerial}`,
      collateralEscrowAccountId: this.escrowId.toString(),
      authorizationTxId: transactions.authorization.transactionId,
      noteMintTxId: transactions.noteMint.transactionId,
      collateralMintTxId: transactions.collateralMint.transactionId,
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
      version: 3 as const,
      stage: "FUNDED" as const,
      transactions: { ...transactions },
      noteSerial: serial,
      collateralSerial,
      authorizationSequenceNumber,
      fundedSequenceNumber
    };
    await recordProgress?.(finalProgress);

    const stableTokenId = this.stableTokenId.toString();
    const noteTokenId = this.tokenId.toString();
    const topicId = this.topicId.toString();
    return fundingResultSchema.parse({
      version: 3,
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
      collateral: {
        tokenId: this.collateralTokenId.toString(),
        serial: collateralSerial,
        escrowAccountId: this.escrowId.toString(),
        label: "Synthetic demo collateral — no real shares or value",
        mirrorUrl: `${this.config.mirrorUrl}/api/v1/tokens/${this.collateralTokenId.toString()}/nfts/${collateralSerial}`,
        hashscanUrl: `https://hashscan.io/testnet/token/${this.collateralTokenId.toString()}/${collateralSerial}`
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

  private async fundWithoutCollateral(
    packet: FundingPacket,
    recordProgress?: FundingProgressRecorder
  ): Promise<FundingResult> {
    const transactions: {
      authorization?: FundingTransaction;
      noteMint?: FundingTransaction;
      settlement?: FundingTransaction;
      fundedEvent?: FundingTransaction;
    } = {};
    const authorized = await new TopicMessageSubmitTransaction()
      .setTopicId(this.topicId)
      .setMessage(
        JSON.stringify({
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
        })
      )
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
      .addTokenTransfer(
        this.stableTokenId,
        AccountId.fromString(packet.recipientAccountId),
        packet.amountStableUnits
      )
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

    const funded = await new TopicMessageSubmitTransaction()
      .setTopicId(this.topicId)
      .setMessage(
        JSON.stringify({
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
        })
      )
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
    await recordProgress?.({
      version: 2,
      stage: "FUNDED",
      transactions: { ...transactions },
      noteSerial: serial,
      authorizationSequenceNumber,
      fundedSequenceNumber
    });

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
    if (
      packet.amountMinor <= 0 ||
      packet.previousPrincipalMinor - packet.amountMinor !== packet.remainingPrincipalMinor ||
      packet.remainingPrincipalMinor < 0
    ) {
      throw new Error("REPAYMENT_AMOUNT_INVALID");
    }
    if (packet.noteTokenId !== this.tokenId.toString()) {
      throw new Error("REPAYMENT_NOTE_TOKEN_MISMATCH");
    }
    if (
      packet.collateralTokenId &&
      packet.collateralTokenId !== this.collateralTokenId.toString()
    ) {
      throw new Error("REPAYMENT_COLLATERAL_TOKEN_MISMATCH");
    }
    if (packet.payerAccountId !== this.config.recipientId) {
      throw new Error("REPAYMENT_PAYER_CONFIG_CHANGED");
    }
    if (packet.payerAccountId !== this.operatorId.toString()) {
      throw new Error("REPAYMENT_SIGNER_UNAVAILABLE");
    }
    const payer = AccountId.fromString(packet.payerAccountId);
    const serialNumber = Number(packet.noteSerial);
    const full = packet.remainingPrincipalMinor === 0;
    if (!Number.isSafeInteger(serialNumber) || serialNumber <= 0) {
      throw new Error("REPAYMENT_NOTE_SERIAL_INVALID");
    }
    await this.assertRepaymentReady(payer, packet.amountStableUnits, serialNumber);
    let collateralSerialNumber: number | null = null;
    if (full && packet.collateralSerial) {
      collateralSerialNumber = Number(packet.collateralSerial);
      if (!Number.isSafeInteger(collateralSerialNumber) || collateralSerialNumber <= 0) {
        throw new Error("REPAYMENT_COLLATERAL_SERIAL_INVALID");
      }
      const collateral = await this.mirrorJson<MirrorNft>(
        `/api/v1/tokens/${this.collateralTokenId.toString()}/nfts/${collateralSerialNumber}`
      );
      if (
        collateral.deleted ||
        collateral.token_id !== this.collateralTokenId.toString() ||
        collateral.account_id !== this.escrowId.toString()
      ) {
        throw new Error("ESCROW_COLLATERAL_OWNERSHIP_REQUIRED");
      }
    }

    const transactions: {
      authorization?: FundingTransaction;
      settlement?: FundingTransaction;
      noteBurn?: FundingTransaction;
      completionEvent?: FundingTransaction;
    } = {};
    const authorizationResponse = await new TopicMessageSubmitTransaction()
      .setTopicId(this.topicId)
      .setMessage(
        JSON.stringify({
          v: 2,
          event: "REPAYMENT_AUTHORIZED",
          repaymentId: packet.repaymentId,
          advanceId: packet.advanceId,
          amountUnits: packet.amountStableUnits.toString(),
          previousPrincipalMinor: packet.previousPrincipalMinor,
          remainingPrincipalMinor: packet.remainingPrincipalMinor,
          kind: full ? "FULL" : "PARTIAL",
          note: `${this.tokenId.toString()}/${packet.noteSerial}`
        })
      )
      .execute(this.client);
    const authorizationReceipt = await authorizationResponse.getReceipt(this.client);
    if (authorizationReceipt.status.toString() !== "SUCCESS") {
      throw new Error("HCS_REPAYMENT_AUTHORIZATION_FAILED");
    }
    const authorizationSequenceNumber = authorizationReceipt.topicSequenceNumber?.toString();
    if (!authorizationSequenceNumber) {
      throw new Error("HCS_REPAYMENT_AUTHORIZATION_SEQUENCE_MISSING");
    }
    transactions.authorization = await transactionEvidence(
      authorizationResponse,
      this.client,
      this.config.mirrorUrl,
      "SUCCESS"
    );
    await recordProgress?.({
      version: 1,
      repaymentId: packet.repaymentId,
      stage: "AUTHORIZED",
      transactions: { authorization: transactions.authorization },
      authorizationSequenceNumber
    });

    let transfer = new TransferTransaction()
      .addTokenTransfer(this.stableTokenId, payer, -packet.amountStableUnits)
      .addTokenTransfer(this.stableTokenId, this.treasuryId, packet.amountStableUnits)
      .setTransactionMemo(`unlockd.bond repay ${packet.advanceId}`.slice(0, 100));
    if (full) {
      transfer = transfer.addNftTransfer(this.tokenId, serialNumber, this.poolId, this.treasuryId);
      if (collateralSerialNumber !== null) {
        transfer = transfer.addNftTransfer(
          this.collateralTokenId,
          collateralSerialNumber,
          this.escrowId,
          payer
        );
      }
    }
    const frozen = transfer.freezeWith(this.client);
    let signed =
      !full || this.poolId.toString() === this.operatorId.toString()
        ? frozen
        : await frozen.sign(this.poolKey);
    if (
      full &&
      collateralSerialNumber !== null &&
      this.escrowId.toString() !== this.operatorId.toString()
    ) {
      signed = await signed.sign(this.escrowKey);
    }
    const settlementResponse = await signed.execute(this.client);
    const settlementReceipt = await settlementResponse.getReceipt(this.client);
    if (settlementReceipt.status.toString() !== "SUCCESS") {
      throw new Error("HEDERA_REPAYMENT_SETTLEMENT_FAILED");
    }
    transactions.settlement = await transactionEvidence(
      settlementResponse,
      this.client,
      this.config.mirrorUrl,
      "SUCCESS"
    );
    await recordProgress?.({
      version: 1,
      repaymentId: packet.repaymentId,
      stage: "SETTLED",
      transactions: {
        authorization: transactions.authorization,
        settlement: transactions.settlement
      },
      authorizationSequenceNumber
    });

    if (full) {
      const burnResponse = await (
        await new TokenBurnTransaction()
          .setTokenId(this.tokenId)
          .setSerials([serialNumber])
          .freezeWith(this.client)
          .sign(this.supplyKey)
      ).execute(this.client);
      const burnReceipt = await burnResponse.getReceipt(this.client);
      if (burnReceipt.status.toString() !== "SUCCESS") {
        throw new Error("HEDERA_NOTE_BURN_FAILED");
      }
      transactions.noteBurn = await transactionEvidence(
        burnResponse,
        this.client,
        this.config.mirrorUrl,
        "SUCCESS"
      );
    }

    const completionResponse = await new TopicMessageSubmitTransaction()
      .setTopicId(this.topicId)
      .setMessage(
        JSON.stringify({
          v: 2,
          event: full ? "ADVANCE_REPAID" : "ADVANCE_PARTIALLY_REPAID",
          repaymentId: packet.repaymentId,
          advanceId: packet.advanceId,
          amountUnits: packet.amountStableUnits.toString(),
          remainingPrincipalMinor: packet.remainingPrincipalMinor,
          settlementTxId: transactions.settlement.transactionId,
          noteBurnTxId: transactions.noteBurn?.transactionId ?? null,
          collateralReleased: full && collateralSerialNumber !== null
        })
      )
      .execute(this.client);
    const completionReceipt = await completionResponse.getReceipt(this.client);
    if (completionReceipt.status.toString() !== "SUCCESS") {
      throw new Error("HCS_REPAYMENT_COMPLETION_FAILED");
    }
    const completionSequenceNumber = completionReceipt.topicSequenceNumber?.toString();
    if (!completionSequenceNumber) throw new Error("HCS_REPAYMENT_SEQUENCE_MISSING");
    transactions.completionEvent = await transactionEvidence(
      completionResponse,
      this.client,
      this.config.mirrorUrl,
      "SUCCESS"
    );
    await recordProgress?.({
      version: 1,
      repaymentId: packet.repaymentId,
      stage: "REPAID",
      transactions: {
        authorization: transactions.authorization,
        settlement: transactions.settlement,
        noteBurn: transactions.noteBurn,
        repaidEvent: transactions.completionEvent
      },
      authorizationSequenceNumber,
      repaidSequenceNumber: completionSequenceNumber
    });

    const stableTokenId = this.stableTokenId.toString();
    const noteTokenId = this.tokenId.toString();
    const collateralTokenId = this.collateralTokenId.toString();
    const topicId = this.topicId.toString();
    return repaymentResultV2Schema.parse({
      version: 2,
      repaymentId: packet.repaymentId,
      advanceId: packet.advanceId,
      payerAccountId: payer.toString(),
      treasuryAccountId: this.treasuryId.toString(),
      kind: full ? "FULL" : "PARTIAL",
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
        retired: full,
        mirrorUrl: `${this.config.mirrorUrl}/api/v1/tokens/${noteTokenId}/nfts/${packet.noteSerial}`,
        hashscanUrl: `https://hashscan.io/testnet/token/${noteTokenId}/${packet.noteSerial}`
      },
      collateral: {
        tokenId: packet.collateralTokenId ?? collateralTokenId,
        serial: packet.collateralSerial ?? "0",
        released: full && collateralSerialNumber !== null,
        mirrorUrl: `${this.config.mirrorUrl}/api/v1/tokens/${packet.collateralTokenId ?? collateralTokenId}/nfts/${packet.collateralSerial ?? "0"}`,
        hashscanUrl: `https://hashscan.io/testnet/token/${packet.collateralTokenId ?? collateralTokenId}/${packet.collateralSerial ?? "0"}`
      },
      topic: {
        topicId,
        authorizationSequenceNumber,
        completionSequenceNumber,
        hashscanUrl: `https://hashscan.io/testnet/topic/${topicId}`
      },
      transactions,
      previousPrincipalMinor: packet.previousPrincipalMinor,
      remainingPrincipalMinor: packet.remainingPrincipalMinor,
      simulated: false
    });
  }

  async liquidate(
    packet: LiquidationPacket,
    recordProgress?: LiquidationProgressRecorder
  ): Promise<LiquidationResult> {
    if (packet.emulatedPriceMinor >= packet.liquidationPriceMinor) {
      throw new Error("LIQUIDATION_THRESHOLD_NOT_CROSSED");
    }
    if (
      packet.noteTokenId !== this.tokenId.toString() ||
      packet.collateralTokenId !== this.collateralTokenId.toString() ||
      packet.collateralEscrowAccountId !== this.escrowId.toString()
    ) {
      throw new Error("LIQUIDATION_ASSET_CONFIG_MISMATCH");
    }
    const noteSerial = Number(packet.noteSerial);
    const collateralSerial = Number(packet.collateralSerial);
    if (
      !Number.isSafeInteger(noteSerial) ||
      noteSerial <= 0 ||
      !Number.isSafeInteger(collateralSerial) ||
      collateralSerial <= 0
    ) {
      throw new Error("LIQUIDATION_SERIAL_INVALID");
    }
    const [note, collateral, operatorBalance] = await Promise.all([
      this.mirrorJson<MirrorNft>(`/api/v1/tokens/${this.tokenId.toString()}/nfts/${noteSerial}`),
      this.mirrorJson<MirrorNft>(
        `/api/v1/tokens/${this.collateralTokenId.toString()}/nfts/${collateralSerial}`
      ),
      new AccountBalanceQuery().setAccountId(this.operatorId).execute(this.client)
    ]);
    if (BigInt(operatorBalance.hbars.toTinybars().toString()) < MIN_OPERATOR_HBAR_TINYBAR) {
      throw new Error("OPERATOR_HBAR_RESERVE_REQUIRED");
    }
    if (note.deleted || note.account_id !== this.poolId.toString()) {
      throw new Error("POOL_NOTE_OWNERSHIP_REQUIRED");
    }
    if (collateral.deleted || collateral.account_id !== this.escrowId.toString()) {
      throw new Error("ESCROW_COLLATERAL_OWNERSHIP_REQUIRED");
    }

    const transactions: {
      authorization?: FundingTransaction;
      settlement?: FundingTransaction;
      noteBurn?: FundingTransaction;
      liquidatedEvent?: FundingTransaction;
    } = {};
    const authorizationResponse = await new TopicMessageSubmitTransaction()
      .setTopicId(this.topicId)
      .setMessage(
        JSON.stringify({
          v: 1,
          event: "LIQUIDATION_AUTHORIZED",
          liquidationId: packet.liquidationId,
          advanceId: packet.advanceId,
          emulatedPriceMinor: packet.emulatedPriceMinor,
          liquidationPriceMinor: packet.liquidationPriceMinor,
          remainingPrincipalMinor: packet.remainingPrincipalMinor,
          collateral: `${packet.collateralTokenId}/${packet.collateralSerial}`
        })
      )
      .execute(this.client);
    const authorizationReceipt = await authorizationResponse.getReceipt(this.client);
    if (authorizationReceipt.status.toString() !== "SUCCESS") {
      throw new Error("HCS_LIQUIDATION_AUTHORIZATION_FAILED");
    }
    const authorizationSequenceNumber = authorizationReceipt.topicSequenceNumber?.toString();
    if (!authorizationSequenceNumber) {
      throw new Error("HCS_LIQUIDATION_AUTHORIZATION_SEQUENCE_MISSING");
    }
    transactions.authorization = await transactionEvidence(
      authorizationResponse,
      this.client,
      this.config.mirrorUrl,
      "SUCCESS"
    );
    await recordProgress?.({
      version: 1,
      liquidationId: packet.liquidationId,
      stage: "AUTHORIZED",
      transactions: { authorization: transactions.authorization },
      authorizationSequenceNumber
    });

    const frozen = new TransferTransaction()
      .addNftTransfer(this.collateralTokenId, collateralSerial, this.escrowId, this.poolId)
      .addNftTransfer(this.tokenId, noteSerial, this.poolId, this.treasuryId)
      .setTransactionMemo(`unlockd.bond liquidate ${packet.advanceId}`.slice(0, 100))
      .freezeWith(this.client);
    let signed =
      this.escrowId.toString() === this.operatorId.toString()
        ? frozen
        : await frozen.sign(this.escrowKey);
    if (this.poolId.toString() !== this.operatorId.toString()) {
      signed = await signed.sign(this.poolKey);
    }
    const settlementResponse = await signed.execute(this.client);
    const settlementReceipt = await settlementResponse.getReceipt(this.client);
    if (settlementReceipt.status.toString() !== "SUCCESS") {
      throw new Error("HEDERA_LIQUIDATION_SETTLEMENT_FAILED");
    }
    transactions.settlement = await transactionEvidence(
      settlementResponse,
      this.client,
      this.config.mirrorUrl,
      "SUCCESS"
    );
    await recordProgress?.({
      version: 1,
      liquidationId: packet.liquidationId,
      stage: "SETTLED",
      transactions: {
        authorization: transactions.authorization,
        settlement: transactions.settlement
      },
      authorizationSequenceNumber
    });

    const burnResponse = await (
      await new TokenBurnTransaction()
        .setTokenId(this.tokenId)
        .setSerials([noteSerial])
        .freezeWith(this.client)
        .sign(this.supplyKey)
    ).execute(this.client);
    const burnReceipt = await burnResponse.getReceipt(this.client);
    if (burnReceipt.status.toString() !== "SUCCESS") throw new Error("HEDERA_NOTE_BURN_FAILED");
    transactions.noteBurn = await transactionEvidence(
      burnResponse,
      this.client,
      this.config.mirrorUrl,
      "SUCCESS"
    );

    const finalResponse = await new TopicMessageSubmitTransaction()
      .setTopicId(this.topicId)
      .setMessage(
        JSON.stringify({
          v: 1,
          event: "ADVANCE_LIQUIDATED",
          liquidationId: packet.liquidationId,
          advanceId: packet.advanceId,
          settlementTxId: transactions.settlement.transactionId,
          noteBurnTxId: transactions.noteBurn.transactionId,
          remainingPrincipalMinor: 0
        })
      )
      .execute(this.client);
    const finalReceipt = await finalResponse.getReceipt(this.client);
    if (finalReceipt.status.toString() !== "SUCCESS") {
      throw new Error("HCS_LIQUIDATED_EVENT_FAILED");
    }
    const liquidatedSequenceNumber = finalReceipt.topicSequenceNumber?.toString();
    if (!liquidatedSequenceNumber) throw new Error("HCS_LIQUIDATED_SEQUENCE_MISSING");
    transactions.liquidatedEvent = await transactionEvidence(
      finalResponse,
      this.client,
      this.config.mirrorUrl,
      "SUCCESS"
    );
    await recordProgress?.({
      version: 1,
      liquidationId: packet.liquidationId,
      stage: "LIQUIDATED",
      transactions: {
        authorization: transactions.authorization,
        settlement: transactions.settlement,
        noteBurn: transactions.noteBurn,
        liquidatedEvent: transactions.liquidatedEvent
      },
      authorizationSequenceNumber,
      liquidatedSequenceNumber
    });

    const noteTokenId = this.tokenId.toString();
    const collateralTokenId = this.collateralTokenId.toString();
    return liquidationResultSchema.parse({
      version: 1,
      liquidationId: packet.liquidationId,
      advanceId: packet.advanceId,
      emulatedPriceMinor: packet.emulatedPriceMinor,
      liquidationPriceMinor: packet.liquidationPriceMinor,
      remainingPrincipalMinor: 0,
      collateral: {
        tokenId: collateralTokenId,
        serial: packet.collateralSerial,
        escrowAccountId: this.escrowId.toString(),
        label: "Synthetic demo collateral — no real shares or value",
        mirrorUrl: `${this.config.mirrorUrl}/api/v1/tokens/${collateralTokenId}/nfts/${packet.collateralSerial}`,
        hashscanUrl: `https://hashscan.io/testnet/token/${collateralTokenId}/${packet.collateralSerial}`,
        transferredToPool: true
      },
      note: {
        tokenId: noteTokenId,
        serial: packet.noteSerial,
        retired: true,
        mirrorUrl: `${this.config.mirrorUrl}/api/v1/tokens/${noteTokenId}/nfts/${packet.noteSerial}`,
        hashscanUrl: `https://hashscan.io/testnet/token/${noteTokenId}/${packet.noteSerial}`
      },
      transactions,
      simulated: false
    });
  }

  async repayLegacy(
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
    if (this.config.collateralEnabled) {
      const [
        collateralToken,
        escrowCollateralAssociated,
        recipientCollateralAssociated,
        poolCollateralAssociated
      ] = await Promise.all([
        this.mirrorJson<MirrorToken>(`/api/v1/tokens/${this.collateralTokenId.toString()}`),
        this.isAssociated(this.escrowId, this.collateralTokenId),
        this.isAssociated(recipient, this.collateralTokenId),
        this.isAssociated(this.poolId, this.collateralTokenId)
      ]);
      if (
        collateralToken.deleted ||
        collateralToken.token_id !== this.collateralTokenId.toString() ||
        collateralToken.name !== "unlockd.bond Demo Equity Collateral" ||
        collateralToken.symbol !== "UBEQ" ||
        collateralToken.type !== "NON_FUNGIBLE_UNIQUE" ||
        collateralToken.treasury_account_id !== this.treasuryId.toString()
      ) {
        throw new Error("COLLATERAL_TOKEN_CONFIG_INVALID");
      }
      if (!escrowCollateralAssociated) throw new Error("ESCROW_COLLATERAL_ASSOCIATION_REQUIRED");
      if (!recipientCollateralAssociated)
        throw new Error("RECIPIENT_COLLATERAL_ASSOCIATION_REQUIRED");
      if (!poolCollateralAssociated) throw new Error("POOL_COLLATERAL_ASSOCIATION_REQUIRED");
    }
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
