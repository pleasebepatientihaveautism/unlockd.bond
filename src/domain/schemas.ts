import { z } from "zod";

const decimalUnits = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/, "Use up to 6 decimal places");

const positiveMinor = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const assetSymbolSchema = z
  .string()
  .regex(/^(?:AAPL|[A-Z0-9]{2,12}\.PVT)$/, "Use AAPL or a Yahoo private-company ticker");

export const advanceRequestSchema = z
  .object({
    requestId: z.string().regex(/^ub_req_[a-zA-Z0-9_-]{8,80}$/),
    employeeRef: z.string().regex(/^ub_emp_[a-zA-Z0-9_-]{8,80}$/),
    synthetic: z.boolean(),
    grant: z.object({
      assetSymbol: assetSymbolSchema,
      companyIdentifier: z
        .string()
        .min(2)
        .max(120)
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, "Use a company shorthand or domain"),
      grantType: z.enum(["RSU", "OPTION"]),
      vestedUnits: decimalUnits,
      strikePriceMinor: z.number().int().min(0).max(100_000_000),
      referenceSharePriceMinor: z.number().int().positive().max(100_000_000).nullable(),
      valuationDate: z.iso.date().nullable(),
      valuationSource: z.enum(["PUBLIC_MARKET", "EMPLOYEE_409A", "ISSUER", "SYNTHETIC"]).nullable(),
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
    if (
      value.grant.grantType === "OPTION" &&
      (!value.grant.referenceSharePriceMinor ||
        !value.grant.valuationDate ||
        !value.grant.valuationSource)
    ) {
      context.addIssue({
        code: "custom",
        path: ["grant", "referenceSharePriceMinor"],
        message: "Private options require common-share price evidence and a valuation date"
      });
    }
  });

export const marketSnapshotSchema = z
  .object({
    evidenceType: z.enum(["PUBLIC_MARKET", "PRIVATE_VALUATION"]),
    source: z.enum(["the-graph", "issuer-valuation", "yahoo-finance-private"]),
    network: z.enum(["robinhood", "private-company"]),
    chainId: z.union([z.literal(0), z.literal(4663)]),
    assetSymbol: assetSymbolSchema,
    tokenAddress: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .nullable(),
    feedAddress: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .nullable(),
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
    valuationBasis: z.string().min(3).max(160),
    externalEvidenceLabel: z.string().min(3).max(160).nullable(),
    externalEvidenceUrl: z.url().nullable().optional(),
    estimatedValuationUsdMinor: z.number().int().positive().nullable().optional(),
    latestFundingDate: z.iso.date().nullable().optional(),
    simulated: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.evidenceType === "PUBLIC_MARKET" &&
      (!value.tokenAddress ||
        !value.feedAddress ||
        value.assetSymbol !== "AAPL" ||
        value.chainId !== 4663)
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidenceType"],
        message: "Public market evidence requires AAPL Robinhood token and feed addresses"
      });
    }
    if (
      value.evidenceType === "PRIVATE_VALUATION" &&
      (!value.assetSymbol.endsWith(".PVT") ||
        value.chainId !== 0 ||
        value.tokenAddress !== null ||
        value.feedAddress !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidenceType"],
        message: "Private valuation evidence requires a Yahoo .PVT ticker without token addresses"
      });
    }
  });

export const privateCompanyListingSchema = z
  .object({
    ticker: z.string().regex(/^[A-Z0-9]{2,12}\.PVT$/),
    companyName: z.string().min(1).max(160),
    priceUsdMinor: positiveMinor,
    estimatedValuationUsdMinor: z.number().int().positive().nullable(),
    latestFundingDate: z.iso.date().nullable(),
    latestShareClass: z.string().min(1).max(160).nullable(),
    sector: z.string().min(1).max(160).nullable(),
    priceUpdatedAt: z.number().int().positive(),
    source: z.literal("yahoo-finance-private"),
    evidenceUrl: z.url(),
    cacheStatus: z.enum(["hit", "miss", "stale"])
  })
  .strict();

export const riskDecisionSchema = z
  .object({
    schemaVersion: z.literal("unlockd-bond-risk-v1"),
    decision: z.enum(["approve", "counter", "reject"]),
    riskBand: z.enum(["LOW", "MEDIUM", "HIGH"]),
    recommendedAdvanceMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
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

const fundingResultV1Schema = z
  .object({
    paymentTxId: z.string().min(3).max(200),
    noteTokenId: z.string().min(3).max(80),
    noteSerial: z.string().regex(/^\d+$/),
    hcsTopicId: z.string().min(3).max(80),
    hcsSequenceNumber: z.string().regex(/^\d+$/),
    consensusTimestamp: z.string().min(3).max(80),
    consensusStatus: z.enum(["SUCCESS", "SIMULATED"]),
    mirrorTransactionUrl: z.string().url(),
    mirrorTokenUrl: z.string().url(),
    hashscanTransactionUrl: z.string().url(),
    hashscanTokenUrl: z.string().url(),
    hashscanTopicUrl: z.string().url(),
    simulated: z.boolean()
  })
  .strict();

export const fundingTransactionSchema = z
  .object({
    transactionId: z.string().min(3).max(200),
    consensusTimestamp: z.string().min(3).max(80),
    consensusStatus: z.enum(["SUCCESS", "SIMULATED"]),
    mirrorUrl: z.string().url(),
    hashscanUrl: z.string().url()
  })
  .strict();

export const fundingProgressSchema = z
  .object({
    version: z.literal(2),
    stage: z.enum(["AUTHORIZED", "NOTE_MINTED", "SETTLED", "FUNDED"]),
    transactions: z
      .object({
        authorization: fundingTransactionSchema.optional(),
        noteMint: fundingTransactionSchema.optional(),
        settlement: fundingTransactionSchema.optional(),
        fundedEvent: fundingTransactionSchema.optional()
      })
      .strict(),
    noteSerial: z.string().regex(/^\d+$/).optional(),
    authorizationSequenceNumber: z.string().regex(/^\d+$/).optional(),
    fundedSequenceNumber: z.string().regex(/^\d+$/).optional()
  })
  .strict();

export const fundingResultV2Schema = z
  .object({
    version: z.literal(2),
    asset: z
      .object({
        tokenId: z.string().regex(/^0\.0\.\d{3,12}$/),
        name: z.literal("USDC DEMO"),
        symbol: z.literal("USDC"),
        decimals: z.literal(6),
        amountUnits: z.string().regex(/^[1-9]\d*$/),
        amountMinor: positiveMinor,
        label: z.literal("Demo USDC — no real value"),
        mirrorUrl: z.string().url(),
        hashscanUrl: z.string().url()
      })
      .strict(),
    note: z
      .object({
        tokenId: z.string().regex(/^0\.0\.\d{3,12}$/),
        serial: z.string().regex(/^\d+$/),
        mirrorUrl: z.string().url(),
        hashscanUrl: z.string().url()
      })
      .strict(),
    topic: z
      .object({
        topicId: z.string().regex(/^0\.0\.\d{3,12}$/),
        authorizationSequenceNumber: z.string().regex(/^\d+$/),
        fundedSequenceNumber: z.string().regex(/^\d+$/),
        hashscanUrl: z.string().url()
      })
      .strict(),
    transactions: z
      .object({
        authorization: fundingTransactionSchema,
        noteMint: fundingTransactionSchema,
        settlement: fundingTransactionSchema,
        fundedEvent: fundingTransactionSchema
      })
      .strict(),
    simulated: z.boolean()
  })
  .strict();

export const fundingResultSchema = z.union([fundingResultV2Schema, fundingResultV1Schema]);

export type AdvanceRequest = z.infer<typeof advanceRequestSchema>;
export type AssetSymbol = z.infer<typeof assetSymbolSchema>;
export type MarketSnapshot = z.infer<typeof marketSnapshotSchema>;
export type RiskDecision = z.infer<typeof riskDecisionSchema>;
export type RiskReceipt = z.infer<typeof riskReceiptSchema>;
export type FundingResult = z.infer<typeof fundingResultSchema>;
export type FundingResultV2 = z.infer<typeof fundingResultV2Schema>;
export type FundingProgress = z.infer<typeof fundingProgressSchema>;
export type FundingTransaction = z.infer<typeof fundingTransactionSchema>;
export type PrivateCompanyListing = z.infer<typeof privateCompanyListingSchema>;

export const confirmationSchema = z
  .object({
    confirmationToken: z.string().min(32).max(300)
  })
  .strict();
