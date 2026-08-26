ALTER TABLE nutrition_write_outbox
  ADD COLUMN lease_until TIMESTAMPTZ,
  ADD COLUMN last_attempt_at TIMESTAMPTZ;

CREATE INDEX nutrition_write_outbox_claim_idx
  ON nutrition_write_outbox (status, next_attempt_at, lease_until, created_at);
