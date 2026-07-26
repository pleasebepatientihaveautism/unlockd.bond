# unlockd.bond

Private, verifiable equity-aware salary advances — implemented as an honest testnet
prototype for ETHGlobal Lisbon.

Future production address: [https://unlockd.bond](https://unlockd.bond)

GitHub: [pleasebepatientihaveautism/unlockd.bond](https://github.com/pleasebepatientihaveautism/unlockd.bond)

unlockd.bond evaluates a **synthetic** public-company employee profile, joins it with
live Graph market provenance, requires explicit private 0G TeeML verification,
applies a deterministic integer-only policy, and executes a bounded Hedera
Testnet payment plus an HTS Advance Note and HCS lifecycle commitments.

It is not a production lending product, legal collateral agreement, stock
assignment, payroll service, or security.

## What is implemented

- strict request, market, AI-output, and payment schemas;
- exact minor-unit and `bigint` authorization arithmetic;
- transparent private-company grant valuation from common-share evidence,
  exercise price, vested units, deterministic haircuts, and bounded LTV;
- optional Coresignal company-risk enrichment with a seven-day disk cache,
  persistent 100-call budget, ten-call demo reserve, and conservative fallback;
- explicit 0G `private` trust mode and `verify_tee: true`;
- Graph `_meta` provenance, freshness, oracle-health, and sample checks;
- idempotent `AUTHORIZED → FUNDING → FUNDED | FUNDING_FAILED` state transitions;
- Hedera Testnet HCS authorization, HTS NFT mint, atomic Demo USDC + NFT transfer,
  complete consensus transaction bundle, and final HCS event;
- PostgreSQL persistence with row locks and a memory store for tests/demo;
- one-time scoped funding confirmation tokens;
- 32 KB request limit, rate limiting, CSP/security headers, origin checks, and
  body-free structured logs;
- privacy-safe public proof receipts;
- health and dependency-readiness endpoints;
- Docker and local Compose deployment;
- explicit demo adapters that never masquerade as partner proof.

## Quick start: safe synthetic demo

Requirements: Node.js 22+, npm, and optionally Docker.

```bash
cp .env.example .env
```

Replace both placeholder application secrets with independent random values:

```bash
openssl rand -base64 48
openssl rand -base64 48
```

For the zero-infrastructure demo, remove or comment out `DATABASE_URL`. Then:

```bash
npm ci
npm run dev
```

Open `http://localhost:5173`. Demo results are visibly marked **Simulated** and
are not qualifying 0G, Graph, or Hedera evidence.

## Private-company equity pricing

The employee's private-market reference price and the company's financial-risk
signal are kept separate. For the WHOOP demo, the server parses the `WHOO.PVT`
price from Yahoo Finance's highest-valued private-companies table:

```text
gross vested value = vested options × max(common-share FMV − strike, 0)
eligible equity value = gross vested value × (1 − deterministic haircuts)
credit line = min(request, income limit, 25% equity LTV, fixed cap, risk limit)
```

Yahoo's `regularMarketPrice.raw` is used as the per-share reference price.
`latestImpliedValuation.raw` is stored only as company-level context and is never
treated as a share price. Results are cached for 15 minutes, a stale cache may
be used for up to seven days during a Yahoo outage, and evaluation fails closed
when no trustworthy price is available:

```bash
npm run yahoo:check -- WHOO.PVT
```

Coresignal `preferred_stock` and `common_stock` values are used only to adjust
the pool's required upside share. They are accounting balance-sheet values and
are never presented as an employee common-share price.

Configure the supported Coresignal Multi-source Company API through the hidden
local prompt:

```bash
npm run coresignal:configure
npm run dev:coresignal
```

This writes the key only to ignored `.env.coresignal.local` with file mode
`0600`. The Multi-source enrichment record confirms company identity and
provides general company data, but it does not currently include Craft
Companies `preferred_stock` and `common_stock` balance-sheet fields. Until a
Craft dataset delivery containing those fields is supplied, the pricing flow
uses the documented conservative company-risk fallback.

Runtime responses are cached under ignored `cache/companies/` for seven days.
`api-usage.json` persists attempted and successful calls. Once only ten of the
100 calls remain, the adapter refuses network access and returns the documented
35% fallback pool-upside share without blocking the employee flow.

Sanity-check the WHOOP example without funding:

```bash
npm run pricing:check -- whoop.com 20000 1.20 4.80 1500
```

The CLI reports valuation, financing terms, cache status, remaining API calls,
and whether Coresignal or fallback company risk was used.

## PostgreSQL

```bash
docker compose up -d postgres
npm run db:migrate
```

The application stores the decision record, derived customer pricing,
commitments, server-only commitment nonces, recipient account, authorization
limit, and receipts. It does not store raw salary, tenure, vested units,
employee reference, prompts, completions, or 0G chat IDs. Customer pricing is
removed from the public proof endpoint.

## Live partner mode

Set `APP_MODE=live` and configure every live variable in `.env.example`. Live
startup fails if any required partner, database, or Hedera key is missing.

### 1. Graph

Deploy the custom Robinhood AAPL risk subgraph described in
`docs/PRODUCT_BRIEF.md`. The
endpoint must return:

- `stockToken` with token/feed addresses, current USD minor-unit price, update
  time, and pause state;
- `priceSamples`;
- recent `transfers`;
- `_meta` with deployment, indexing errors, block number, hash, and timestamp.

The app rejects missing, stale, paused, unhealthy, or insufficient data. The
qualifying flow has no Graph-to-demo fallback.

### 2. 0G

Fund a Router account, create an inference `sk-` key, and choose a live model
whose `/v1/models` record has `verifiability: "TeeML"`.

Every request sends:

```http
X-0G-Provider-Trust-Mode: private
```

and `verify_tee: true`. Missing or false `x_0g_trace.tee_verified` fails closed.
There is no fallback to `verified` or `standard`.

### 3. Hedera

With a funded Testnet operator, the resumable bootstrap creates distinct
treasury, pool, and NFT supply keys; creates funded treasury/pool accounts; then
creates and associates the HCS topic and HTS collection:

```bash
npm run hedera:provision
```

The script reads the 24-word operator mnemonic from a hidden TTY prompt, verifies
the derived public key against Mirror Node before spending, and never stores the
mnemonic. Runtime material is written atomically to ignored
`.env.hedera.local` with file mode `0600`; public IDs and links are written to
`hedera-testnet-evidence.json`. The bootstrap is resumable after a partial
network failure. It also creates a fixed-supply HTS token named `USDC DEMO`
with symbol `USDC`, six decimals, and an initial/maximum supply of
1,000,000,000 tokens. This is a custom unbacked Testnet token, not Circle USDC
and not redeemable for dollars.

For an honest hackathon flow with synthetic market/risk evaluation but real
Hedera settlement:

```bash
npm run dev:hedera
npm run hedera:demo
npm run hedera:verify
```

`hedera:demo` executes a 10 Demo USDC advance to the configured recipient.
`hedera:verify` independently checks all four transactions, the exact stable
token transfer, NFT owner, and both HCS messages through Mirror Node. The public
result is saved in `hedera-demo-receipt.json`.

`HEDERA_POOL_KEY` is used only by provisioning for token association and is not
read by the application runtime.

The live funding adapter:

1. verifies TEE status;
2. verifies the Demo USDC treasury reserve and recipient association;
3. commits `ADVANCE_AUTHORIZED` to HCS;
4. mints one Advance Note NFT;
5. atomically transfers Demo USDC to the recipient and the NFT to the pool;
6. requires a Hedera consensus `SUCCESS` receipt;
7. commits `ADVANCE_FUNDED` to HCS.

One USD cent maps exactly to 10,000 six-decimal Demo USDC base units. The
application never treats the demo token as Circle-issued or as real money.

## API

### Evaluate

`POST /api/advances/evaluate`

The `Idempotency-Key` header must equal `body.requestId`.

### Fund

`POST /api/advances/:advanceId/fund`

Requires the opaque confirmation token returned by a successful evaluation.
Concurrent or repeated requests do not execute a second payment.
An ambiguous partner failure becomes terminal and requires operator
reconciliation plus a new request/nonce; the API never automatically retries a
payment.

### Public proof

`GET /api/advances/:advanceId`

Returns only the public-safe evidence envelope; confirmation tokens and raw
employee inputs are excluded. The customer-only equity pricing breakdown is
returned by Evaluate and Fund, but is deliberately removed from this public
proof endpoint.

### Operations

- `GET /api/health` — process liveness only.
- `GET /api/ready` — database, market evidence, company data, private risk, and
  Hedera preflight. Coresignal readiness never spends an API call.

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

See `docs/PRODUCTION_CHECKLIST.md` for the testnet launch gate and `SECURITY.md`
for the threat boundary.
