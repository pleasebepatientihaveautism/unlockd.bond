# Security and privacy

## Supported scope

This repository supports synthetic employee profiles and testnet value only.
Do not submit real salary statements, grant documents, names, or personal data.

Report vulnerabilities privately to the repository maintainers. Do not include
secrets, personal data, 0G chat identifiers, or live private keys in a report.

## Trust boundaries

- The browser sees the form fields and an opaque funding confirmation token.
- The backend processes employee inputs transiently but does not persist them.
- The Graph receives only public AAPL market queries.
- 0G receives minimized structured fields through explicit private TeeML mode.
- Hedera receives salted commitments, pseudonymous IDs, bounded test payment
  data, NFT metadata commitments, and transaction references.
- Public proof endpoints never return confirmation-token hashes, commitment
  nonces, or raw inputs.

## Mandatory live-mode properties

- Live configuration is complete at startup.
- Graph data is current, healthy, non-paused, and provenance-bearing.
- 0G routing is `private`, `verify_tee` is true, and the returned Boolean is true.
- Model output passes a strict schema and cannot exceed the deterministic cap.
- Recipient, amount, network, nonce/idempotency key, expiry, and treasury
  reserve are bound before signing.
- A submitted Hedera transaction is not considered funded until the consensus
  receipt is `SUCCESS`.
- No demo adapter is accepted in live mode.

## Secret handling

Keep all `.env` files out of Git. Use a cloud secret manager in deployed
environments. Give the runtime only the keys it needs:

- 0G inference key, never a management key;
- Graph query credential;
- Hedera operator, treasury, and supply keys;
- application commitment and confirmation secrets.

The pool key is provisioning-only. Never place it in the runtime.

Rotate a compromised confirmation secret after invalidating pending
authorizations. Rotate Hedera keys onchain and replace runtime secrets through a
controlled deployment. Do not log request bodies, responses, prompts, API
headers, private keys, or funding confirmation tokens.

## Known non-production gaps

Before real users or value: legal and regulatory analysis, KYC/AML and sanctions
controls, employer/cap-table attestations, licensed market data, production HSM
or MPC custody, dual control, fairness/adverse-action validation, servicing,
appeals, incident response, corporate-action handling, reconciliation, and
independent penetration testing are required.
