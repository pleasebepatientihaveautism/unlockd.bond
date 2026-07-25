import type { AdvanceRequest, MarketSnapshot } from "../src/domain/schemas.js";
import { loadConfig } from "../src/server/config.js";

export const requestFixture = (overrides: Partial<AdvanceRequest> = {}): AdvanceRequest => ({
  requestId: "ub_req_1234567890abcdef",
  employeeRef: "ub_emp_1234567890abcdef",
  recipientAccountId: "0.0.653284",
  synthetic: true,
  employment: {
    tenureMonths: 38,
    monthlyNetIncomeMinor: 650_000,
    statusVerified: true
  },
  grant: {
    assetSymbol: "AAPL",
    grantType: "RSU",
    vestedUnits: "120.000000",
    strikePriceMinor: 0,
    transferRestricted: true,
    attestationCommitment: `sha256:${"a".repeat(64)}`
  },
  request: {
    amountMinor: 150_000,
    currency: "USD",
    termDays: 30
  },
  ...overrides
});

export const marketFixture = (overrides: Partial<MarketSnapshot> = {}): MarketSnapshot => {
  const now = Math.floor(Date.now() / 1000);
  return {
    source: "the-graph",
    network: "robinhood",
    chainId: 4663,
    assetSymbol: "AAPL",
    tokenAddress: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
    feedAddress: "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0",
    priceUsdMinor: 21_347,
    priceUpdatedAt: now - 10,
    oraclePaused: false,
    sampleCount: 30,
    realizedVolatilityBps: 4200,
    transferCount24h: 83,
    subgraphDeployment: "QmTestDeployment",
    indexedBlock: 12_345_678,
    indexedBlockHash: `0x${"b".repeat(64)}`,
    indexedBlockTimestamp: now - 8,
    hasIndexingErrors: false,
    simulated: false,
    ...overrides
  };
};

export const testConfig = () =>
  loadConfig({
    NODE_ENV: "test",
    APP_MODE: "demo",
    PORT: "3000",
    COMMITMENT_SECRET: "commitment-secret-at-least-thirty-two-characters",
    CONFIRMATION_SECRET: "confirmation-secret-at-least-thirty-two-characters"
  });
