# Testnet production checklist

## Automated gate

- [ ] `npm ci`
- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] container builds as non-root
- [ ] migrations run once against the target PostgreSQL instance

## Secrets and access

- [ ] `.env` is not tracked
- [ ] commitment and confirmation secrets are independent and at least 32 bytes
- [ ] 0G runtime receives an inference key, not a management key
- [ ] pool key is available only to the bounded signer and cannot authorize
      unrelated account actions
- [ ] Hedera operator, treasury, pool, and supply roles are reviewed
- [ ] deployed key material comes from a secret manager
- [ ] logs and APM payload capture are verified body-free

## Dependency kill tests

- [ ] 0G model catalog currently contains the configured TeeML model
- [ ] real private inference returns structured output and `tee_verified: true`
- [ ] Graph endpoint returns live AAPL evidence and healthy `_meta`
- [ ] stale, paused, indexing-error, and insufficient-sample cases fail closed
- [ ] Hedera topic, token, treasury, pool association, and balances are valid
- [ ] one atomic Demo USDC + NFT transfer reaches consensus `SUCCESS`
- [ ] one full repayment returns exact Demo USDC, returns and burns the expected
      NFT serial, and writes both repayment HCS messages
- [ ] repayment replay and ambiguous-settlement tests fail closed
- [ ] Mirror Node shows the payment, NFT owner, and HCS messages

## Runtime

- [ ] HTTPS termination is configured
- [ ] `ALLOWED_ORIGINS` contains only deployed origins
- [ ] health and readiness checks are connected to the platform
- [ ] readiness failure removes the instance from service
- [ ] PostgreSQL TLS validates the server certificate
- [ ] database backups and restore test exist
- [ ] alerts cover 5xx rate, funding failures, dependency readiness, and low
      treasury balance without capturing payloads
- [ ] `USDC DEMO` is visibly labeled as a custom unbacked Testnet token

## Evidence and honesty

- [ ] demo mode is visibly labeled and never used as partner proof
- [ ] no real employee data appears in screenshots or recordings
- [ ] proof UI exposes no raw input, prompt, 0G chat ID, or commitment nonce
- [ ] no claim says the NFT is stock, a lien, or legal collateral
- [ ] submission lists exact Graph deployment, 0G model/provider, Hedera account,
      topic, token, transaction, and consensus receipt
- [ ] a submitted transaction ID is not described as funded before `SUCCESS`

## Explicit real-production stop

Do not accept real users, money, salary data, or equity claims until every legal,
regulatory, identity, custody, fairness, servicing, reconciliation, licensed
market-data, privacy, and incident-response gap in `SECURITY.md` is closed.
