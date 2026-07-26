import "dotenv/config";
import { AccountId, Client, PrivateKey, TokenBurnTransaction, TokenId } from "@hashgraph/sdk";

const serialText = process.argv[2];
if (!serialText || !/^[1-9]\d*$/.test(serialText)) {
  throw new Error("NOTE_SERIAL_REQUIRED");
}
const serial = Number(serialText);
if (!Number.isSafeInteger(serial)) throw new Error("NOTE_SERIAL_INVALID");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`CONFIG_REQUIRED:${name}`);
  return value;
}

const operatorId = required("HEDERA_OPERATOR_ID");
const operatorKey = PrivateKey.fromString(required("HEDERA_OPERATOR_KEY"));
const treasuryId = required("HEDERA_TREASURY_ID");
const tokenId = required("HEDERA_TOKEN_ID");
const supplyKey = PrivateKey.fromString(required("HEDERA_SUPPLY_KEY"));
const mirrorUrl = process.env.HEDERA_MIRROR_URL ?? "https://testnet.mirrornode.hedera.com";

const nftResponse = await fetch(`${mirrorUrl}/api/v1/tokens/${tokenId}/nfts/${serial}`);
if (!nftResponse.ok) throw new Error("NOTE_LOOKUP_FAILED");
const nft = (await nftResponse.json()) as {
  account_id: string | null;
  deleted: boolean;
  serial_number: number;
  token_id: string;
};
if (
  nft.deleted ||
  nft.account_id !== treasuryId ||
  nft.serial_number !== serial ||
  nft.token_id !== tokenId
) {
  throw new Error("NOTE_NOT_ORPHANED_IN_TREASURY");
}

const client = Client.forTestnet().setOperator(AccountId.fromString(operatorId), operatorKey);
try {
  const transaction = await (
    await new TokenBurnTransaction()
      .setTokenId(TokenId.fromString(tokenId))
      .setSerials([serial])
      .setTransactionMemo(`unlockd.bond orphan note ${serial}`.slice(0, 100))
      .freezeWith(client)
      .sign(supplyKey)
  ).execute(client);
  const receipt = await transaction.getReceipt(client);
  if (receipt.status.toString() !== "SUCCESS") throw new Error("ORPHAN_NOTE_BURN_FAILED");
  const record = await transaction.getRecord(client);
  process.stdout.write(
    `Retired orphan note ${tokenId}/${serial} at ${record.consensusTimestamp.toString()}.\n`
  );
} finally {
  client.close();
}
