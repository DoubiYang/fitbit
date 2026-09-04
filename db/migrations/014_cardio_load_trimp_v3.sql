CREATE TABLE heart_rate_minute_evidence (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_family TEXT NOT NULL CHECK (source_family = 'google-wearables'),
  minute_start_utc TIMESTAMPTZ NOT NULL,
  segments JSONB NOT NULL CHECK (jsonb_typeof(segments) = 'array' AND jsonb_array_length(segments) > 0),
  PRIMARY KEY (user_id, source_family, minute_start_utc)
);

CREATE INDEX heart_rate_minute_evidence_user_minute_idx
  ON heart_rate_minute_evidence (user_id, minute_start_utc);

CREATE TABLE daily_cardio_loads (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  civil_date DATE NOT NULL,
  metric_version TEXT NOT NULL CHECK (metric_version = 'cardio-load-trimp-v3'),
  status TEXT NOT NULL CHECK (status IN ('scored', 'invalid_hr_reserve', 'insufficient_context', 'timezone_ambiguous')),
  daily_load DOUBLE PRECISION CHECK (daily_load IS NULL OR daily_load >= 0),
  qualified_seconds DOUBLE PRECISION NOT NULL CHECK (qualified_seconds >= 0),
  unverified_elevated_hr_seconds DOUBLE PRECISION NOT NULL CHECK (unverified_elevated_hr_seconds >= 0),
  raw_hr_coverage_seconds DOUBLE PRECISION NOT NULL CHECK (raw_hr_coverage_seconds >= 0),
  awake_coverage_ratio DOUBLE PRECISION CHECK (awake_coverage_ratio IS NULL OR (awake_coverage_ratio >= 0 AND awake_coverage_ratio <= 1)),
  motion_source TEXT NOT NULL CHECK (motion_source IN ('activity_level', 'exercise', 'both', 'none')),
  quality_state TEXT NOT NULL CHECK (quality_state IN ('qualified', 'incomplete', 'timezone_ambiguous')),
  rhr_base_bpm DOUBLE PRECISION CHECK (rhr_base_bpm IS NULL OR (rhr_base_bpm >= 25 AND rhr_base_bpm <= 130)),
  hr_max_est_bpm DOUBLE PRECISION CHECK (hr_max_est_bpm IS NULL OR (hr_max_est_bpm >= 100 AND hr_max_est_bpm <= 230)),
  hr_max_provenance JSONB,
  CHECK (
    (hr_max_est_bpm IS NULL AND hr_max_provenance IS NULL)
    OR (
      hr_max_est_bpm IS NOT NULL
      AND hr_max_provenance IS NOT NULL
      AND jsonb_typeof(hr_max_provenance) = 'object'
      AND hr_max_provenance->>'filterRuleVersion' = 'google-wearables-hrmax-v1'
      AND hr_max_provenance->>'sourceFamily' = 'google-wearables'
      AND hr_max_provenance ? 'minuteStartUtc'
      AND jsonb_typeof(hr_max_provenance->'bpm') = 'number'
      AND (hr_max_provenance->>'bpm')::DOUBLE PRECISION = hr_max_est_bpm
      AND jsonb_typeof(hr_max_provenance->'coverageSeconds') = 'number'
      AND (hr_max_provenance->>'coverageSeconds')::DOUBLE PRECISION >= 30
      AND (hr_max_provenance->>'coverageSeconds')::DOUBLE PRECISION <= 60
      AND jsonb_typeof(hr_max_provenance->'sampleCount') = 'number'
      AND (hr_max_provenance->>'sampleCount')::INTEGER >= 1
    )
  ),
  input_fingerprint TEXT NOT NULL CHECK (input_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  calculation_context JSONB NOT NULL CHECK (jsonb_typeof(calculation_context) = 'object' AND calculation_context <> '{}'::jsonb),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, civil_date, metric_version),
  CHECK ((status = 'scored' AND daily_load IS NOT NULL) OR (status <> 'scored')),
  CHECK ((status <> 'invalid_hr_reserve') OR daily_load IS NULL)
);

CREATE INDEX daily_cardio_loads_user_date_idx
  ON daily_cardio_loads (user_id, civil_date DESC);

CREATE TABLE weekly_cardio_baselines (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  metric_version TEXT NOT NULL CHECK (metric_version = 'cardio-load-trimp-v3'),
  status TEXT NOT NULL CHECK (status IN ('stable', 'frozen', 'calibrating')),
  weekly_load DOUBLE PRECISION CHECK (weekly_load IS NULL OR weekly_load >= 0),
  week_to_date_load DOUBLE PRECISION NOT NULL CHECK (week_to_date_load >= 0),
  rm4 DOUBLE PRECISION CHECK (rm4 IS NULL OR rm4 >= 0),
  ewma4 DOUBLE PRECISION CHECK (ewma4 IS NULL OR ewma4 >= 0),
  baseline DOUBLE PRECISION CHECK (baseline IS NULL OR baseline >= 0),
  input_fingerprint TEXT NOT NULL CHECK (input_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, week_start, metric_version)
);

CREATE INDEX weekly_cardio_baselines_user_week_idx
  ON weekly_cardio_baselines (user_id, week_start DESC);

CREATE TABLE daily_load_capacities (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  civil_date DATE NOT NULL,
  metric_version TEXT NOT NULL CHECK (metric_version = 'cardio-load-trimp-v3'),
  status TEXT NOT NULL CHECK (status IN ('scored', 'calibrating', 'unavailable')),
  actual_load DOUBLE PRECISION CHECK (actual_load IS NULL OR actual_load >= 0),
  usable_load DOUBLE PRECISION CHECK (usable_load IS NULL OR usable_load >= 0),
  utilization DOUBLE PRECISION CHECK (utilization IS NULL OR (utilization >= 0 AND utilization <= 100)),
  history_sample_count INTEGER NOT NULL CHECK (history_sample_count >= 0),
  used_global_fallback BOOLEAN NOT NULL,
  recovery_tier TEXT CHECK (recovery_tier IS NULL OR recovery_tier IN ('low', 'middle', 'high', 'unadjusted')),
  recovery_metric_version TEXT CHECK (recovery_metric_version IS NULL OR recovery_metric_version = 'whoop-style-v2'),
  recovery_civil_date DATE,
  recovery_quality TEXT CHECK (recovery_quality IS NULL OR recovery_quality IN ('unavailable', 'provisional', 'medium', 'high')),
  recovery_input_fingerprint TEXT CHECK (recovery_input_fingerprint IS NULL OR recovery_input_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  input_fingerprint TEXT NOT NULL CHECK (input_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, civil_date, metric_version)
);

CREATE INDEX daily_load_capacities_user_date_idx
  ON daily_load_capacities (user_id, civil_date DESC);

CREATE TABLE cardio_load_bootstraps (
  connection_id UUID NOT NULL REFERENCES google_health_connections (id) ON DELETE CASCADE,
  metric_version TEXT NOT NULL CHECK (metric_version = 'cardio-load-trimp-v3'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'failed', 'completed')),
  attempted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_code TEXT,
  PRIMARY KEY (connection_id, metric_version),
  CHECK ((status <> 'completed') OR completed_at IS NOT NULL),
  CHECK ((status <> 'failed') OR error_code IS NOT NULL)
);
