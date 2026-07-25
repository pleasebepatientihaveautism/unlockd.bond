import {
  AccountBalanceQuery,
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TokenId,
  TokenMintTransaction,
  TopicId,
  TopicMessageSubmitTransaction,
  TransferTransaction
} from "@hashgraph/sdk";
import { type FundingResult, fundingResultSchema } from "../../domain/schemas.js";
import type { FundingPacket, PaymentProvider } from "./types.js";

interface HederaConfig {
  operatorId: string;
  operatorKey: string;
  treasuryId: string;
  treasuryKey: string;
  supplyKey: string;
  poolId: string;
  topicId: string;
  tokenId: string;
  mirrorUrl: string;
  treasuryReserveTinybar: number;
}

function privateKey(value: string): PrivateKey {
  try {
    return PrivateKey.fromString(value);
  } catch {
    throw new Error("HEDERA_PRIVATE_KEY_INVALID");
  }
}

function encodeMetadata(packet: FundingPacket): Uint8Array {
  const compact = JSON.stringify({
    v: 1,
    type: "UNLOCKD_BOND_ADVANCE_NOTE",
    advanceId: packet.advanceId,
    decisionCommitment: packet.decisionCommitment,
    marketCommitment: packet.marketCommitment
  });
  const bytes = new TextEncoder().encode(compact);
  if (bytes.byteLength > 100) throw new Error("HTS_METADATA_TOO_LARGE");
  return bytes;
}

export class HederaPaymentProvider implements PaymentProvider {
  private readonly client: Client;
  private readonly operatorId: AccountId;
  private readonly treasuryId: AccountId;
  private readonly poolId: AccountId;
  private readonly topicId: TopicId;
  private readonly tokenId: TokenId;
  private readonly treasuryKey: PrivateKey;
  private readonly supplyKey: PrivateKey;

  constructor(private readonly config: HederaConfig) {
    this.operatorId = AccountId.fromString(config.operatorId);
    this.treasuryId = AccountId.fromString(config.treasuryId);
    this.poolId = AccountId.fromString(config.poolId);
    this.topicId = TopicId.fromString(config.topicId);
    this.tokenId = TokenId.fromString(config.tokenId);
    this.treasuryKey = privateKey(config.treasuryKey);
    this.supplyKey = privateKey(config.supplyKey);
    this.client = Client.forTestnet().setOperator(this.operatorId, privateKey(config.operatorKey));
  }

  async fund(packet: FundingPacket): Promise<FundingResult> {
    if (!packet.zeroGTeeVerified) throw new Error("TEE_VERIFICATION_REQUIRED");
    const recipient = AccountId.fromString(packet.recipientAccountId);
    const balance = await new AccountBalanceQuery()
      .setAccountId(this.treasuryId)
      .execute(this.client);
    const available = BigInt(balance.hbars.toTinybars().toString());
    if (available - packet.amountTinybar < BigInt(this.config.treasuryReserveTinybar)) {
      throw new Error("TREASURY_RESERVE_REQUIRED");
    }

    const decisionEvent = {
      v: 1,
      event: "ADVANCE_AUTHORIZED",
      advanceId: packet.advanceId,
      employeeCommitment: packet.employeeCommitment,
      decisionCommitment: packet.decisionCommitment,
      marketCommitment: packet.marketCommitment,
      graphBlock: packet.graphBlock,
      graphDeployment: packet.graphDeployment,
      zeroGRequestId: packet.zeroGRequestId,
      zeroGProvider: packet.zeroGProvider,
      zeroGTeeVerified: true
    };
    const authorized = await new TopicMessageSubmitTransaction()
      .setTopicId(this.topicId)
      .setMessage(JSON.stringify(decisionEvent))
      .execute(this.client);
    const authorizedReceipt = await authorized.getReceipt(this.client);
    if (authorizedReceipt.status.toString() !== "SUCCESS") {
      throw new Error("HCS_AUTHORIZATION_FAILED");
    }

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
    const serial = mintReceipt.serials[0];

    const transfer = new TransferTransaction()
      .addHbarTransfer(this.treasuryId, Hbar.fromTinybars(-packet.amountTinybar))
      .addHbarTransfer(recipient, Hbar.fromTinybars(packet.amountTinybar))
      .addNftTransfer(this.tokenId, serial, this.treasuryId, this.poolId)
      .setTransactionMemo(`unlockd.bond ${packet.advanceId}`.slice(0, 100))
      .freezeWith(this.client);
    const signed =
      this.treasuryId.toString() === this.operatorId.toString()
        ? transfer
        : await transfer.sign(this.treasuryKey);
    const executed = await signed.execute(this.client);
    const receipt = await executed.getReceipt(this.client);
    if (receipt.status.toString() !== "SUCCESS") throw new Error("HEDERA_FUNDING_FAILED");
    const transferRecord = await executed.getRecord(this.client);

    const fundedEvent = {
      v: 1,
      event: "ADVANCE_FUNDED",
      advanceId: packet.advanceId,
      note: `${this.tokenId.toString()}/${serial.toString()}`,
      paymentTxId: executed.transactionId.toString()
    };
    const funded = await new TopicMessageSubmitTransaction()
      .setTopicId(this.topicId)
      .setMessage(JSON.stringify(fundedEvent))
      .execute(this.client);
    const fundedReceipt = await funded.getReceipt(this.client);
    if (fundedReceipt.status.toString() !== "SUCCESS") throw new Error("HCS_FUNDED_EVENT_FAILED");

    const transactionId = executed.transactionId.toString();
    const mirrorTransactionId = transactionId.replace("@", "-").replace(/(\d+)\.(\d+)$/, "$1-$2");
    return fundingResultSchema.parse({
      paymentTxId: transactionId,
      noteTokenId: this.tokenId.toString(),
      noteSerial: serial.toString(),
      hcsTopicId: this.topicId.toString(),
      hcsSequenceNumber: fundedReceipt.topicSequenceNumber?.toString(),
      consensusTimestamp: transferRecord.consensusTimestamp.toString(),
      mirrorTransactionUrl: `${this.config.mirrorUrl}/api/v1/transactions/${encodeURIComponent(mirrorTransactionId)}`,
      mirrorTokenUrl: `${this.config.mirrorUrl}/api/v1/tokens/${this.tokenId.toString()}/nfts/${serial.toString()}`,
      simulated: false
    });
  }

  async ready(): Promise<boolean> {
    try {
      await new AccountBalanceQuery().setAccountId(this.operatorId).execute(this.client);
      return true;
    } catch {
      return false;
    }
  }
}
