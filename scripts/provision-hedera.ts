import "dotenv/config";
import {
  AccountId,
  Client,
  PrivateKey,
  TokenAssociateTransaction,
  TokenCreateTransaction,
  TokenSupplyType,
  TokenType,
  TopicCreateTransaction
} from "@hashgraph/sdk";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};

const operatorId = AccountId.fromString(required("HEDERA_OPERATOR_ID"));
const operatorKey = PrivateKey.fromString(required("HEDERA_OPERATOR_KEY"));
const treasuryId = AccountId.fromString(required("HEDERA_TREASURY_ID"));
const supplyKey = PrivateKey.fromString(required("HEDERA_SUPPLY_KEY"));
const poolId = AccountId.fromString(required("HEDERA_POOL_ID"));
const poolKey = PrivateKey.fromString(required("HEDERA_POOL_KEY"));
const client = Client.forTestnet().setOperator(operatorId, operatorKey);

const topic = await new TopicCreateTransaction()
  .setTopicMemo("unlockd.bond lifecycle commitments")
  .setSubmitKey(operatorKey.publicKey)
  .execute(client);
const topicReceipt = await topic.getReceipt(client);
if (!topicReceipt.topicId) throw new Error("HCS_TOPIC_CREATE_FAILED");

const token = await (
  await new TokenCreateTransaction()
    .setTokenName("unlockd.bond Advance Note")
    .setTokenSymbol("UBAN")
    .setTokenType(TokenType.NonFungibleUnique)
    .setSupplyType(TokenSupplyType.Infinite)
    .setTreasuryAccountId(treasuryId)
    .setSupplyKey(supplyKey.publicKey)
    .setTokenMemo("Testnet receivable representation; not stock or legal collateral")
    .freezeWith(client)
    .sign(supplyKey)
).execute(client);
const tokenReceipt = await token.getReceipt(client);
if (!tokenReceipt.tokenId) throw new Error("HTS_TOKEN_CREATE_FAILED");

const association = await (
  await new TokenAssociateTransaction()
    .setAccountId(poolId)
    .setTokenIds([tokenReceipt.tokenId])
    .freezeWith(client)
    .sign(poolKey)
).execute(client);
const associationReceipt = await association.getReceipt(client);
if (associationReceipt.status.toString() !== "SUCCESS") throw new Error("POOL_ASSOCIATION_FAILED");

process.stdout.write(
  `${JSON.stringify(
    {
      HEDERA_TOPIC_ID: topicReceipt.topicId.toString(),
      HEDERA_TOKEN_ID: tokenReceipt.tokenId.toString(),
      HEDERA_POOL_ID: poolId.toString()
    },
    null,
    2
  )}\n`
);
client.close();
