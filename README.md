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
- explicit 0G `private` trust mode and `verify_tee: true`;
- Graph `_meta` provenance, freshness, oracle-health, and sample checks;
- idempotent `AUTHORIZED → FUNDING → FUNDED | FUNDING_FAILED` state transitions;
- Hedera Testnet HCS authorization, HTS NFT mint, atomic HBAR + NFT transfer,
  consensus receipt, and final HCS event;
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

## PostgreSQL

```bash
docker compose up -d postgres
npm run db:migrate
```

The application stores only the public-safe decision record, commitments,
server-only commitment nonces, recipient account, authorization limit, and
receipts. It does not store salary, tenure, vested units, employee reference,
prompts, completions, or 0G chat IDs.

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
network failure.

For an honest hackathon flow with synthetic market/risk evaluation but real
Hedera settlement:

```bash
npm run dev:hedera
npm run hedera:demo
npm run hedera:verify
```

`hedera:demo` executes a $10-presentation-value advance to the operator account.
`hedera:verify` independently checks the payment `SUCCESS`, NFT owner, and exact
`ADVANCE_FUNDED` HCS message through Mirror Node. The public result is saved in
`hedera-demo-receipt.json`.

`HEDERA_POOL_KEY` is used only by provisioning for token association and is not
read by the application runtime.

The live funding adapter:

1. verifies TEE status;
2. verifies the treasury fee reserve;
3. commits `ADVANCE_AUTHORIZED` to HCS;
4. mints one Advance Note NFT;
5. atomically transfers test HBAR to the employee and the NFT to the pool;
6. requires a Hedera consensus `SUCCESS` receipt;
7. commits `ADVANCE_FUNDED` to HCS.

`PAYOUT_TINYBAR_PER_USD_MINOR` is an explicit **testnet-only presentation
conversion**, not an exchange rate or price oracle.

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
employee inputs are excluded.

### Operations

- `GET /api/health` — process liveness only.
- `GET /api/ready` — database plus Graph, 0G, and Hedera preflight.

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

See `docs/PRODUCTION_CHECKLIST.md` for the testnet launch gate and `SECURITY.md`
for the threat boundary.
