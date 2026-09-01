CREATE TABLE heart_rate_minute_aggregates (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_family TEXT NOT NULL CHECK (source_family = 'google-wearables'),
  minute_start_utc TIMESTAMPTZ NOT NULL,
  civil_date DATE NOT NULL,
  utc_offset INTEGER NOT NULL CHECK (utc_offset BETWEEN -840 AND 840),
  iana_time_zone TEXT,
  local_minute_of_day INTEGER NOT NULL CHECK (local_minute_of_day BETWEEN 0 AND 1500),
  avg_bpm DOUBLE PRECISION NOT NULL CHECK (avg_bpm >= 1 AND avg_bpm <= 250),
  min_bpm DOUBLE PRECISION NOT NULL CHECK (min_bpm >= 1 AND min_bpm <= 250),
  max_bpm DOUBLE PRECISION NOT NULL CHECK (max_bpm >= 1 AND max_bpm <= 250),
  sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
  coverage_seconds DOUBLE PRECISION NOT NULL CHECK (coverage_seconds >= 0 AND coverage_seconds <= 60),
  activity_level TEXT NOT NULL CHECK (
    activity_level IN ('SEDENTARY', 'LIGHTLY_ACTIVE', 'MODERATELY_ACTIVE', 'VERY_ACTIVE', 'unknown')
  ),
  PRIMARY KEY (user_id, source_family, minute_start_utc),
  CHECK (max_bpm >= min_bpm)
);

CREATE INDEX heart_rate_minute_aggregates_user_civil_date_idx
  ON heart_rate_minute_aggregates (user_id, civil_date DESC);

CREATE TABLE activity_level_intervals (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_family TEXT NOT NULL CHECK (source_family = 'google-wearables'),
  interval_start_utc TIMESTAMPTZ NOT NULL,
  interval_end_utc TIMESTAMPTZ NOT NULL,
  activity_level_type TEXT NOT NULL CHECK (
    activity_level_type IN ('SEDENTARY', 'LIGHTLY_ACTIVE', 'MODERATELY_ACTIVE', 'VERY_ACTIVE')
  ),
  PRIMARY KEY (user_id, source_family, interval_start_utc),
  CHECK (interval_end_utc > interval_start_utc)
);

CREATE INDEX activity_level_intervals_user_start_idx
  ON activity_level_intervals (user_id, interval_start_utc);

CREATE TABLE daily_heart_rate_zones (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_family TEXT NOT NULL CHECK (source_family = 'google-wearables'),
  civil_date DATE NOT NULL,
  zones JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source_family, civil_date)
);

CREATE INDEX daily_heart_rate_zones_user_civil_date_idx
  ON daily_heart_rate_zones (user_id, civil_date DESC);

CREATE TABLE daily_time_in_zone (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_family TEXT NOT NULL CHECK (source_family = 'google-wearables'),
  civil_date DATE NOT NULL,
  light_minutes DOUBLE PRECISION NOT NULL CHECK (light_minutes >= 0),
  moderate_minutes DOUBLE PRECISION NOT NULL CHECK (moderate_minutes >= 0),
  vigorous_minutes DOUBLE PRECISION NOT NULL CHECK (vigorous_minutes >= 0),
  peak_minutes DOUBLE PRECISION NOT NULL CHECK (peak_minutes >= 0),
  PRIMARY KEY (user_id, source_family, civil_date)
);

CREATE INDEX daily_time_in_zone_user_civil_date_idx
  ON daily_time_in_zone (user_id, civil_date DESC);

CREATE TABLE exercise_intervals (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_family TEXT NOT NULL CHECK (source_family = 'google-wearables'),
  source_record_id TEXT NOT NULL,
  start_time_utc TIMESTAMPTZ NOT NULL,
  end_time_utc TIMESTAMPTZ NOT NULL,
  utc_offset INTEGER NOT NULL CHECK (utc_offset BETWEEN -840 AND 840),
  civil_date DATE NOT NULL,
  PRIMARY KEY (user_id, source_family, source_record_id),
  CHECK (end_time_utc > start_time_utc)
);

CREATE INDEX exercise_intervals_user_civil_date_idx
  ON exercise_intervals (user_id, civil_date DESC);

CREATE TABLE daily_cardio (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  civil_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('complete', 'provisional', 'incomplete', 'timezone_ambiguous', 'unavailable')
  ),
  strain DOUBLE PRECISION CHECK (strain IS NULL OR (strain >= 0 AND strain <= 21)),
  dose DOUBLE PRECISION CHECK (dose IS NULL OR dose >= 0),
  light_minutes DOUBLE PRECISION NOT NULL CHECK (light_minutes >= 0),
  moderate_minutes DOUBLE PRECISION NOT NULL CHECK (moderate_minutes >= 0),
  vigorous_minutes DOUBLE PRECISION NOT NULL CHECK (vigorous_minutes >= 0),
  peak_minutes DOUBLE PRECISION NOT NULL CHECK (peak_minutes >= 0),
  known_context_minutes INTEGER NOT NULL CHECK (known_context_minutes >= 0),
  raw_coverage_minutes INTEGER NOT NULL CHECK (raw_coverage_minutes >= 0),
  attributed_minutes INTEGER NOT NULL CHECK (attributed_minutes >= 0),
  metric_version TEXT NOT NULL CHECK (metric_version = 'whoop-style-v2'),
  PRIMARY KEY (user_id, civil_date)
);

CREATE INDEX daily_cardio_user_civil_date_idx
  ON daily_cardio (user_id, civil_date DESC);

CREATE TABLE health_sync_cursors (
  connection_id UUID NOT NULL REFERENCES google_health_connections (id) ON DELETE CASCADE,
  data_type TEXT NOT NULL CHECK (
    data_type IN (
      'heart-rate',
      'activity-level',
      'daily-heart-rate-zones',
      'time-in-heart-rate-zone',
      'exercise',
      'sleep',
      'daily-heart-rate-variability',
      'daily-resting-heart-rate'
    )
  ),
  successful_watermark TIMESTAMPTZ,
  last_error_code TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, data_type)
);

CREATE INDEX health_sync_cursors_due_idx
  ON health_sync_cursors (next_attempt_at)
  WHERE next_attempt_at IS NOT NULL;

CREATE TABLE metric_results (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  civil_date DATE NOT NULL,
  metric_name TEXT NOT NULL CHECK (metric_name IN ('strain', 'sleep_performance', 'recovery')),
  metric_version TEXT NOT NULL CHECK (metric_version = 'whoop-style-v2'),
  score DOUBLE PRECISION,
  status TEXT CHECK (
    status IS NULL OR status IN ('complete', 'provisional', 'incomplete', 'timezone_ambiguous', 'unavailable')
  ),
  quality TEXT CHECK (
    quality IS NULL OR quality IN ('unavailable', 'provisional', 'medium', 'high')
  ),
  reason TEXT,
  evidence JSONB NOT NULL,
  source JSONB NOT NULL,
  coverage JSONB NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, civil_date, metric_name, metric_version)
);

CREATE INDEX metric_results_user_civil_date_idx
  ON metric_results (user_id, civil_date DESC);

CREATE TABLE user_sleep_goal_history (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  effective_civil_date DATE NOT NULL,
  goal_minutes INTEGER NOT NULL CHECK (goal_minutes BETWEEN 300 AND 900),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, effective_civil_date)
);

CREATE INDEX user_sleep_goal_history_user_effective_idx
  ON user_sleep_goal_history (user_id, effective_civil_date DESC);

CREATE TABLE user_health_time_zone_history (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  effective_at TIMESTAMPTZ NOT NULL,
  iana_time_zone TEXT NOT NULL,
  is_backfill_anchor BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, effective_at)
);

CREATE UNIQUE INDEX user_health_time_zone_history_backfill_anchor_uidx
  ON user_health_time_zone_history (user_id)
  WHERE is_backfill_anchor;

CREATE INDEX user_health_time_zone_history_user_effective_idx
  ON user_health_time_zone_history (user_id, effective_at DESC);
