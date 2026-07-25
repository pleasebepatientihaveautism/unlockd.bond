CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS advances (
  advance_id text PRIMARY KEY,
  request_id text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN (
    'AUTHORIZED', 'FUNDING', 'FUNDED', 'FUNDING_FAILED', 'REJECTED'
  )),
  mode text NOT NULL CHECK (mode IN ('demo', 'live')),
  recipient_account_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  confirmation_token_hash text NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS advances_created_at_idx ON advances (created_at DESC);
