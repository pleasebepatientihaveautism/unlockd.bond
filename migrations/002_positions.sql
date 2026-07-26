ALTER TABLE advances
  ADD COLUMN IF NOT EXISTS owner_session_hash text;

ALTER TABLE advances
  DROP CONSTRAINT IF EXISTS advances_state_check;

ALTER TABLE advances
  ADD CONSTRAINT advances_state_check CHECK (state IN (
    'AUTHORIZED',
    'FUNDING',
    'FUNDED',
    'FUNDING_FAILED',
    'REPAYMENT_PENDING',
    'REPAYMENT_REVIEW_REQUIRED',
    'REPAID',
    'LIQUIDATION_PENDING',
    'LIQUIDATION_REVIEW_REQUIRED',
    'LIQUIDATED',
    'REJECTED'
  ));

ALTER TABLE advances
  DROP CONSTRAINT IF EXISTS advances_mode_check;

ALTER TABLE advances
  ADD CONSTRAINT advances_mode_check CHECK (mode IN ('demo', 'hedera-demo', 'live'));

CREATE INDEX IF NOT EXISTS advances_owner_session_created_idx
  ON advances (owner_session_hash, created_at DESC)
  WHERE owner_session_hash IS NOT NULL;
