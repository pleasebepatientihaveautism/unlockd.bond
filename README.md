# unlockd.bond

Equity-aware financing positions with auditable Hedera Testnet settlement.

[unlockd.bond](https://unlockd.bond) ·
[GitHub](https://github.com/pleasebepatientihaveautism/unlockd.bond)

unlockd.bond is an ETHGlobal Lisbon prototype that turns a synthetic employee
equity profile into a bounded Demo USDC financing position. It values vested
private-company equity, applies deterministic policy limits, records the
position lifecycle, and produces inspectable Hedera receipts.

The project is a testnet demonstration. It is not a production lending product,
legal collateral agreement, stock assignment, payroll service, security, or
source of real USDC. The synthetic collateral represents no shares, ownership,
or enforceable claim.

## Current product flow

1. Select a supported private company and enter a synthetic RSU or option grant.
2. Review the reference share price, vested equity value, 70% equity cap,
   advance amount, and liquidation threshold.
3. Authorize and fund the position with Demo USDC.
4. Inspect the open position, valuation history, maturity, Advance Note, and
   synthetic collateral receipt.
5. Make a partial or full repayment. Partial repayments reduce both outstanding
   principal and the liquidation threshold.
6. Emulate a lower valuation and preview liquidation behavior.
7. Close the position through full repayment or a confirmed synthetic
   liquidation.

## What is implemented

- private-company catalogue and per-share price evidence from Yahoo Finance;
- RSU and option valuation with vested units, strike price, exact intrinsic
  value, and a 70% equity LTV cap;
- optional Coresignal company enrichment with a seven-day disk cache, persistent
  request budget, reserved demo calls, and conservative fallback;
- exact minor-unit and `bigint` payment arithmetic;
- idempotent funding, repayment, and liquidation operations;
- open and closed position views scoped to the current browser session;
- valuation history, per-share chart, strike line, and dynamic liquidation
  threshold;
- partial and full principal-only repayments with zero demo interest and fees;
- synthetic price-drop preview and explicit liquidation confirmation;
- Hedera Consensus Service lifecycle events;
- HTS Demo USDC, Advance Note NFTs, and synthetic collateral NFTs;
- collateral escrow, release on full repayment, and transfer to the pool on
  liquidation;
- public-safe proof receipts with HashScan and Mirror Node links;
- PostgreSQL persistence with row locks and an in-memory demo store;
- request validation, rate limiting, CSP/security headers, origin checks,
  body-free structured logs, readiness checks, Docker, and local Compose.

## Tech stack

- TypeScript and Node.js 22
- React 19 and Vite
- Express 5 and Zod
- PostgreSQL
- Hedera SDK, HTS, HCS, Mirror Node, and HashScan
- Vitest and Biome

## Quick start

Requirements: Node.js 22+ and npm. Docker is optional.

```bash
cp .env.example .env
```

Replace the two placeholder application secrets with independent random values:

```bash
openssl rand -base64 48
openssl rand -base64 48
```

For the zero-infrastructure demo, remove or comment out `DATABASE_URL`, then run:

```bash
npm ci
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). All payments, tokens, and
receipts in the default mode are visibly marked as simulated.

### Run with PostgreSQL

```bash
docker compose up -d postgres
npm run db:migrate
npm run dev
```

The second migration adds session ownership and the funded-position lifecycle
states used by the Positions workspace.

## Private-company pricing

The employee grant value and company-level financial signal remain separate.
For the WHOOP example, the application reads `WHOO.PVT` from Yahoo Finance's
private-company dataset.

```text
intrinsic value per option = max(reference share price - strike price, 0)
gross vested value         = vested units × intrinsic value per unit
equity LTV cap             = gross vested value × 70%
advance amount             = min(request, decision limit, equity LTV cap)
```

Yahoo's per-share market-price field is used as the share reference.
Company-level implied valuation is stored only as context and is never treated
as a share price. Responses are cached for 15 minutes; a stale cache may be used
for up to seven days during an upstream outage. Evaluation fails closed when no
trustworthy price is available.

Coresignal company figures can adjust the pool's displayed upside share. They
do not replace the employee's per-share reference price or the 70% equity cap.

Check a private-company price:

```bash
npm run yahoo:check -- WHOO.PVT
```

Check the complete WHOOP pricing example without funding:

```bash
npm run pricing:check -- whoop.com 20000 1.20 4.80 1500
```

The pricing command reports the reference valuation, financing terms, cache
status, remaining enrichment-call budget, and whether enrichment or the
conservative fallback was used.

To configure the optional Coresignal integration without exposing the key in
shell history:

```bash
npm run coresignal:configure
npm run dev:coresignal
```

The configuration command writes the key to ignored
`.env.coresignal.local` with file mode `0600`.

## Position lifecycle

Funded positions are grouped into open and closed tabs and are bound to an
HttpOnly browser session. A position records:

- original and remaining principal;
- funding and maturity timestamps;
- grant type and strike price;
- valuation observations and evidence links;
- the current liquidation threshold;
- Advance Note and synthetic collateral identifiers;
- repayment history and terminal liquidation evidence.

The threshold uses exact integer arithmetic:

```text
RSU threshold per share =
  remaining principal / (vested units × 70%)

option threshold per share =
  strike price + remaining principal / (vested units × 70%)
```

The price-drop tool is an emulator, not a market oracle. A preview is
non-mutating. Liquidation requires a separate idempotent confirmation and only
proceeds when the emulated price is below the calculated threshold.

## Hedera Testnet

Provisioning creates or resumes:

- treasury, pool, and synthetic collateral escrow accounts;
- an HCS lifecycle topic;
- an HTS Advance Note NFT collection;
- an HTS synthetic equity collateral NFT collection;
- a fixed-supply, six-decimal `USDC DEMO` token.

```bash
npm run hedera:provision
```

The script reads the operator mnemonic from a hidden terminal prompt, verifies
the derived public key through Mirror Node, and never stores the mnemonic.
Runtime values are written to ignored `.env.hedera.local` with file mode
`0600`; public identifiers and explorer links are written to
`hedera-testnet-evidence.json`.

Run the server and testnet lifecycle:

```bash
npm run dev:hedera
npm run hedera:demo
npm run hedera:lifecycle
npm run hedera:verify
```

- `hedera:demo` creates and funds a 10 Demo USDC advance.
- `hedera:lifecycle` funds the advance and repays its full principal.
- `hedera:verify` independently checks token movements, NFT ownership and
  retirement, HCS messages, and consensus receipts through Mirror Node.
- `hedera:retire-orphan` recovers an orphaned Advance Note after a partially
  completed lifecycle.

Public verification output is saved to `hedera-demo-receipt.json`.

### Funding

The collateral-enabled receipt flow:

1. writes `ADVANCE_AUTHORIZED` to HCS;
2. mints an Advance Note NFT;
3. mints a synthetic collateral NFT;
4. atomically transfers Demo USDC to the recipient, the Advance Note to the
   pool, and synthetic collateral to escrow;
5. requires a Hedera consensus `SUCCESS` receipt;
6. writes `ADVANCE_FUNDED` to HCS.

If collateral configuration is absent, the adapter retains the earlier
non-collateral receipt path for existing testnet setups.

### Repayment

Partial repayment returns the exact Demo USDC amount to the treasury and keeps
both NFTs locked while principal remains. Full repayment additionally returns
the Advance Note to the treasury, releases synthetic collateral from escrow,
burns the Advance Note, and writes the terminal HCS event.

An ambiguous execution failure becomes `REPAYMENT_REVIEW_REQUIRED`. The service
does not automatically resubmit a payment whose final state is uncertain.

### Liquidation

After an emulated price crosses the threshold, confirmed liquidation:

1. writes `LIQUIDATION_AUTHORIZED` to HCS;
2. transfers synthetic collateral from escrow to the pool;
3. returns and burns the Advance Note;
4. sets remaining principal to zero;
5. writes `ADVANCE_LIQUIDATED` to HCS.

An ambiguous failure becomes `LIQUIDATION_REVIEW_REQUIRED` and requires
operator reconciliation.

One USD cent maps to exactly 10,000 six-decimal Demo USDC base units. The token
is custom, unbacked, testnet-only, and not redeemable for dollars.

## API

All mutating lifecycle endpoints use schema validation. Endpoints that accept an
operation ID also require the `Idempotency-Key` header to match that ID.

### Configuration and market

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/config` | Public runtime mode and demo asset configuration |
| `GET` | `/api/market/private-companies` | Supported private-company catalogue |

### Advances

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/advances/evaluate` | Evaluate a synthetic grant and create an authorization |
| `POST` | `/api/advances/:advanceId/fund` | Fund an authorized advance |
| `GET` | `/api/advances/:advanceId` | Read the public-safe proof envelope |
| `GET` | `/api/advances/:advanceId/payoff` | Read exact principal-only payoff terms |
| `POST` | `/api/advances/:advanceId/repay` | Compatibility endpoint for full repayment |

### Positions

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/positions?status=open\|closed` | List session-owned positions |
| `GET` | `/api/positions/:advanceId` | Read a position and lifecycle state |
| `GET` | `/api/positions/:advanceId/valuations` | Read valuation observations |
| `POST` | `/api/positions/:advanceId/repay` | Make a partial or full repayment |
| `POST` | `/api/positions/:advanceId/liquidation/preview` | Preview a synthetic threshold crossing |
| `POST` | `/api/positions/:advanceId/liquidate` | Confirm an idempotent synthetic liquidation |

### Operations

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Process liveness |
| `GET` | `/api/ready` | Store, market, enrichment, policy, and payment readiness |

Raw employee inputs, session identifiers, signing keys, confirmation tokens,
and commitment nonces are excluded from public proof responses.

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the system boundary,
[`docs/PRODUCTION_CHECKLIST.md`](docs/PRODUCTION_CHECKLIST.md) for launch gates,
and [`SECURITY.md`](SECURITY.md) for security assumptions.
