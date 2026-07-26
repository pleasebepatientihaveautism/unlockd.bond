# Architecture

```mermaid
flowchart LR
  UI["React employee flow"] --> API["Express API"]
  API --> GRAPH["Graph market adapter"]
  API --> ZG["0G private TeeML adapter"]
  GRAPH --> POLICY["Deterministic policy"]
  ZG --> POLICY
  POLICY --> STORE["PostgreSQL state and idempotency"]
  STORE --> HEDERA["Hedera bounded signer"]
  HEDERA --> HCS["HCS commitments"]
  HEDERA --> HTS["HTS note plus Demo USDC transfer"]
  HCS --> PROOF["Privacy-safe proof receipt"]
  HTS --> PROOF
  PROOF --> UI
```

## Separation of duties

| Layer | Authority |
|---|---|
| Graph adapter | Reads public market evidence only |
| 0G adapter | Recommends risk band, amount, and reason codes |
| Policy | Calculates exact caps and rejects unhealthy evidence |
| Store | Enforces request/payment idempotency and expiry |
| Hedera adapter | Executes one pre-authorized testnet action |
| UI | Collects synthetic inputs, confirms, and presents proof |

The model cannot create a transaction, choose an arbitrary recipient, bypass
the policy cap, or access a signing key.

## Stored data

`advances.record` contains the public-safe evidence model plus a server-only
confirmation-token HMAC. No raw request or prompt is stored. Salt material is
not published, so public commitments cannot be dictionary-tested without a
backend compromise.

## State machine

```mermaid
stateDiagram-v2
  [*] --> AUTHORIZED
  AUTHORIZED --> FUNDING
  FUNDING --> FUNDED
  FUNDING --> FUNDING_FAILED
  AUTHORIZED --> REJECTED: policy or AI rejection
```

The PostgreSQL implementation uses `SELECT … FOR UPDATE` to acquire the funding
transition. A repeated request observes `FUNDING` or `FUNDED` and cannot create a
second payment. `FUNDING_FAILED` is deliberately terminal because a timeout can
be ambiguous; an operator must reconcile Hedera before authorizing a new
request/nonce.

## Failure semantics

- Validation and policy failures return 422.
- Expired or invalid state returns 409.
- Partner execution failures return 502 and move the record to
  `FUNDING_FAILED`.
- A live readiness check returns 503 when any dependency is unavailable.
- Live adapters do not silently downgrade to demo behavior.
