import { z } from "zod";

const decimalUnits = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/, "Use up to 6 decimal places");

const positiveMinor = z.number().int().positive().max(100_000_000);
const hederaAccount = z.string().regex(/^0\.0\.\d{3,12}$/);

export const advanceRequestSchema = z
  .object({
    requestId: z.string().regex(/^ub_req_[a-zA-Z0-9_-]{8,80}$/),
    employeeRef: z.string().regex(/^ub_emp_[a-zA-Z0-9_-]{8,80}$/),
    recipientAccountId: hederaAccount,
    synthetic: z.boolean(),
    employment: z.object({
      tenureMonths: z.number().int().min(1).max(600),
      monthlyNetIncomeMinor: positiveMinor,
      statusVerified: z.boolean()
    }),
    grant: z.object({
      assetSymbol: z.literal("AAPL"),
      grantType: z.enum(["RSU", "OPTION"]),
      vestedUnits: decimalUnits,
      strikePriceMinor: z.number().int().min(0).max(100_000_000),
      transferRestricted: z.literal(true),
      attestationCommitment: z.string().regex(/^sha256:[a-f0-9]{64}$/)
    }),
    request: z.object({
      amountMinor: positiveMinor,
      currency: z.literal("USD"),
      termDays: z.union([z.literal(14), z.literal(30), z.literal(45)])
    })
  })
  .strict()
  .superRefine((value, context) => {
    if (value.grant.grantType === "RSU" && value.grant.strikePriceMinor !== 0) {
      context.addIssue({
        code: "custom",
        path: ["grant", "strikePriceMinor"],
        message: "RSU strike price must be zero"
      });
    }
  });

export const marketSnapshotSchema = z
  .object({
    source: z.literal("the-graph"),
    network: z.literal("robinhood"),
    chainId: z.literal(4663),
    assetSymbol: z.literal("AAPL"),
    tokenAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    feedAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    priceUsdMinor: positiveMinor,
    priceUpdatedAt: z.number().int().positive(),
    oraclePaused: z.boolean(),
    sampleCount: z.number().int().min(0).max(1000),
    realizedVolatilityBps: z.number().int().min(0).max(100_000).nullable(),
    transferCount24h: z.number().int().min(0),
    subgraphDeployment: z.string().min(3).max(200),
    indexedBlock: z.number().int().positive(),
    indexedBlockHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
    indexedBlockTimestamp: z.number().int().positive(),
    hasIndexingErrors: z.boolean(),
    simulated: z.boolean()
  })
  .strict();

export const riskDecisionSchema = z
  .object({
    schemaVersion: z.literal("unlockd-bond-risk-v1"),
    decision: z.enum(["approve", "counter", "reject"]),
    riskBand: z.enum(["LOW", "MEDIUM", "HIGH"]),
    recommendedAdvanceMinor: z.number().int().min(0).max(100_000_000),
    volatilityHaircutBps: z.number().int().min(0).max(10_000),
    liquidityHaircutBps: z.number().int().min(0).max(10_000),
    reasonCodes: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]{2,60}$/))
      .min(1)
      .max(8),
    assumptions: z.array(z.string().max(160)).max(5)
  })
  .strict();

export const riskReceiptSchema = z
  .object({
    requestId: z.string().min(3).max(200),
    provider: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
    trustMode: z.literal("private"),
    teeVerified: z.boolean(),
    independentlyVerified: z.boolean().nullable(),
    simulated: z.boolean()
  })
  .strict();

export const fundingResultSchema = z
  .object({
    paymentTxId: z.string().min(3).max(200),
    noteTokenId: z.string().min(3).max(80),
    noteSerial: z.string().regex(/^\d+$/),
    hcsTopicId: z.string().min(3).max(80),
    hcsSequenceNumber: z.string().regex(/^\d+$/),
    consensusTimestamp: z.string().min(3).max(80),
    mirrorTransactionUrl: z.string().url(),
    mirrorTokenUrl: z.string().url(),
    simulated: z.boolean()
  })
  .strict();

export type AdvanceRequest = z.infer<typeof advanceRequestSchema>;
export type MarketSnapshot = z.infer<typeof marketSnapshotSchema>;
export type RiskDecision = z.infer<typeof riskDecisionSchema>;
export type RiskReceipt = z.infer<typeof riskReceiptSchema>;
export type FundingResult = z.infer<typeof fundingResultSchema>;

export const confirmationSchema = z
  .object({
    confirmationToken: z.string().min(32).max(300)
  })
  .strict();
