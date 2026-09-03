ALTER TABLE daily_cardio
  ADD COLUMN provenance_version SMALLINT,
  ADD COLUMN input_fingerprint TEXT,
  ADD COLUMN calculation_context JSONB,
  ADD CONSTRAINT daily_cardio_homepage_strain_provenance_check CHECK (
    COALESCE(
      (provenance_version IS NULL
        AND input_fingerprint IS NULL
        AND calculation_context IS NULL)
      OR (
        provenance_version = 1
        AND input_fingerprint IS NOT NULL
        AND input_fingerprint ~ '^sha256:[a-f0-9]{64}$'
        AND calculation_context IS NOT NULL
        AND jsonb_typeof(calculation_context) = 'object'
        AND calculation_context <> '{}'::jsonb
      ),
      false
    )
  );

ALTER TABLE metric_results
  ADD COLUMN provenance_version SMALLINT,
  ADD COLUMN input_fingerprint TEXT,
  ADD COLUMN calculation_context JSONB,
  ADD COLUMN quality_flags TEXT[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT metric_results_homepage_strain_provenance_check CHECK (
    COALESCE(
      (provenance_version IS NULL
        AND input_fingerprint IS NULL
        AND calculation_context IS NULL)
      OR (
        provenance_version = 1
        AND input_fingerprint IS NOT NULL
        AND input_fingerprint ~ '^sha256:[a-f0-9]{64}$'
        AND calculation_context IS NOT NULL
        AND jsonb_typeof(calculation_context) = 'object'
        AND calculation_context <> '{}'::jsonb
      ),
      false
    )
  ),
  ADD CONSTRAINT metric_results_quality_flags_known_check CHECK (
    quality_flags <@ ARRAY['sleep_history_incomplete']::TEXT[]
  );
