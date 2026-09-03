ALTER TABLE health_sync_cursors
  DROP CONSTRAINT health_sync_cursors_data_type_check,
  ADD CONSTRAINT health_sync_cursors_data_type_check CHECK (
    data_type IN (
      'heart-rate',
      'activity-level',
      'daily-heart-rate-zones',
      'time-in-heart-rate-zone',
      'exercise',
      'sleep',
      'daily-heart-rate-variability',
      'daily-resting-heart-rate',
      'daily-vo2-max'
    )
  );

CREATE TABLE user_body_age_profiles (
  user_id UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  birth_date DATE,
  reference_sex TEXT CHECK (reference_sex IS NULL OR reference_sex IN ('male', 'female')),
  historical_observed_hr_peak_bpm DOUBLE PRECISION CHECK (
    historical_observed_hr_peak_bpm IS NULL OR (
      historical_observed_hr_peak_bpm NOT IN ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)
      AND historical_observed_hr_peak_bpm BETWEEN 100 AND 230
    )
  ),
  first_observed_hr_peak_at TIMESTAMPTZ,
  latest_observed_hr_peak_at TIMESTAMPTZ,
  profile_revision INTEGER NOT NULL DEFAULT 0 CHECK (profile_revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (historical_observed_hr_peak_bpm IS NULL
      AND first_observed_hr_peak_at IS NULL
      AND latest_observed_hr_peak_at IS NULL)
    OR (
      historical_observed_hr_peak_bpm IS NOT NULL
      AND first_observed_hr_peak_at IS NOT NULL
      AND latest_observed_hr_peak_at IS NOT NULL
      AND latest_observed_hr_peak_at >= first_observed_hr_peak_at
    )
  )
);

CREATE TABLE air_daily_vo2 (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_family TEXT NOT NULL CHECK (source_family = 'google-wearables'),
  civil_date DATE NOT NULL,
  vo2_max DOUBLE PRECISION NOT NULL CHECK (
    vo2_max NOT IN ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)
    AND vo2_max > 0
  ),
  estimated BOOLEAN NOT NULL DEFAULT false,
  received_at TIMESTAMPTZ NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (user_id, civil_date)
);

CREATE INDEX air_daily_vo2_user_civil_date_idx
  ON air_daily_vo2 (user_id, civil_date DESC);

CREATE TABLE body_age_results (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  algorithm_version TEXT NOT NULL,
  age_years INTEGER,
  age_boundary TEXT CHECK (age_boundary IS NULL OR age_boundary IN ('below_reference_min', 'above_reference_max')),
  route TEXT CHECK (route IS NULL OR route IN ('daily_vo2', 'observed_peak_ratio')),
  status TEXT NOT NULL CHECK (
    status IN (
      'profile_missing',
      'data_accumulating',
      'daily_vo2_provisional',
      'daily_vo2_stable',
      'observed_peak_ratio_provisional',
      'stale'
    )
  ),
  coverage_days INTEGER NOT NULL CHECK (coverage_days >= 0),
  latest_input_civil_date DATE,
  last_calculated_civil_date DATE NOT NULL,
  reference_version TEXT NOT NULL,
  reference_hash TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK (profile_revision >= 0),
  chronological_age_delta_years DOUBLE PRECISION CHECK (
    chronological_age_delta_years IS NULL OR (
      chronological_age_delta_years NOT IN ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)
      AND chronological_age_delta_years BETWEEN -130 AND 130
    )
  ),
  window_days INTEGER NOT NULL CHECK (window_days > 0),
  data_gaps JSONB NOT NULL CHECK (
    jsonb_typeof(data_gaps) = 'object'
    AND data_gaps ? 'dailyVo2DaysNeeded'
    AND data_gaps ? 'rhrDaysNeeded'
    AND data_gaps ? 'observedHrPeakRequired'
    AND jsonb_typeof(data_gaps -> 'dailyVo2DaysNeeded') = 'number'
    AND jsonb_typeof(data_gaps -> 'rhrDaysNeeded') = 'number'
    AND jsonb_typeof(data_gaps -> 'observedHrPeakRequired') = 'boolean'
    AND (data_gaps ->> 'dailyVo2DaysNeeded')::integer >= 0
    AND (data_gaps ->> 'rhrDaysNeeded')::integer >= 0
  ),
  exclusion_counts JSONB NOT NULL CHECK (
    jsonb_typeof(exclusion_counts) = 'object'
    AND exclusion_counts ? 'invalidDailyVo2'
    AND exclusion_counts ? 'futureDailyVo2'
    AND exclusion_counts ? 'untrustedDailyVo2'
    AND exclusion_counts ? 'invalidDailyRhr'
    AND exclusion_counts ? 'futureDailyRhr'
    AND exclusion_counts ? 'untrustedDailyRhr'
    AND jsonb_typeof(exclusion_counts -> 'invalidDailyVo2') = 'number'
    AND jsonb_typeof(exclusion_counts -> 'futureDailyVo2') = 'number'
    AND jsonb_typeof(exclusion_counts -> 'untrustedDailyVo2') = 'number'
    AND jsonb_typeof(exclusion_counts -> 'invalidDailyRhr') = 'number'
    AND jsonb_typeof(exclusion_counts -> 'futureDailyRhr') = 'number'
    AND jsonb_typeof(exclusion_counts -> 'untrustedDailyRhr') = 'number'
    AND (exclusion_counts ->> 'invalidDailyVo2')::integer >= 0
    AND (exclusion_counts ->> 'futureDailyVo2')::integer >= 0
    AND (exclusion_counts ->> 'untrustedDailyVo2')::integer >= 0
    AND (exclusion_counts ->> 'invalidDailyRhr')::integer >= 0
    AND (exclusion_counts ->> 'futureDailyRhr')::integer >= 0
    AND (exclusion_counts ->> 'untrustedDailyRhr')::integer >= 0
  ),
  computed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, algorithm_version),
  CHECK (
    (age_years IS NULL AND age_boundary IS NULL)
    OR (age_years IS NOT NULL AND age_boundary IS NULL AND age_years BETWEEN 0 AND 130)
    OR (age_years IS NULL AND age_boundary IS NOT NULL)
  ),
  CHECK (
    (status IN ('profile_missing', 'data_accumulating')
      AND route IS NULL
      AND age_years IS NULL
      AND age_boundary IS NULL
      AND chronological_age_delta_years IS NULL)
    OR (status IN ('daily_vo2_provisional', 'daily_vo2_stable')
      AND route IS NOT DISTINCT FROM 'daily_vo2'
      AND (age_years IS NOT NULL OR age_boundary IS NOT NULL))
    OR (status = 'observed_peak_ratio_provisional'
      AND route IS NOT DISTINCT FROM 'observed_peak_ratio'
      AND (age_years IS NOT NULL OR age_boundary IS NOT NULL))
    OR (status = 'stale'
      AND route IS NOT NULL AND route IN ('daily_vo2', 'observed_peak_ratio')
      AND age_years IS NULL
      AND age_boundary IS NULL
      AND chronological_age_delta_years IS NULL)
  ),
  CHECK (chronological_age_delta_years IS NULL OR age_years IS NOT NULL)
);

CREATE INDEX body_age_results_user_computed_at_idx
  ON body_age_results (user_id, computed_at DESC);
