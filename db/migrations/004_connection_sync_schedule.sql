ALTER TABLE google_health_connections
  ADD COLUMN next_sync_at TIMESTAMPTZ,
  ADD COLUMN sync_retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN sync_lease_until TIMESTAMPTZ,
  ADD COLUMN last_sync_attempt_at TIMESTAMPTZ;

UPDATE google_health_connections
SET next_sync_at = now()
WHERE status IN ('active', 'partial');
