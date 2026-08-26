CREATE TABLE food_composition_sources (
  source_revision TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  source_license TEXT NOT NULL,
  source_record_count INTEGER NOT NULL CHECK (source_record_count >= 0),
  is_current BOOLEAN NOT NULL DEFAULT false,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX food_composition_sources_one_current_idx
  ON food_composition_sources (is_current)
  WHERE is_current;

CREATE TABLE food_composition_foods (
  source_revision TEXT NOT NULL REFERENCES food_composition_sources (source_revision),
  official_food_id TEXT NOT NULL,
  name_zh TEXT NOT NULL,
  name_en TEXT,
  category TEXT,
  description TEXT,
  PRIMARY KEY (source_revision, official_food_id)
);

CREATE TABLE food_composition_aliases (
  source_revision TEXT NOT NULL,
  official_food_id TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  display_alias TEXT NOT NULL,
  PRIMARY KEY (source_revision, official_food_id, normalized_alias),
  FOREIGN KEY (source_revision, official_food_id)
    REFERENCES food_composition_foods (source_revision, official_food_id)
    ON DELETE CASCADE
);

CREATE INDEX food_composition_aliases_lookup_idx
  ON food_composition_aliases (source_revision, normalized_alias);

CREATE TABLE food_composition_nutrients (
  source_revision TEXT NOT NULL,
  official_food_id TEXT NOT NULL,
  official_nutrient_name TEXT NOT NULL,
  official_nutrient_category TEXT,
  raw_unit TEXT NOT NULL,
  per_100g_value NUMERIC(20, 9) NOT NULL,
  canonical_code TEXT,
  canonical_grams_per_100g NUMERIC(20, 12),
  canonical_kcal_per_100g NUMERIC(12, 3),
  PRIMARY KEY (source_revision, official_food_id, official_nutrient_name),
  FOREIGN KEY (source_revision, official_food_id)
    REFERENCES food_composition_foods (source_revision, official_food_id)
    ON DELETE CASCADE,
  CHECK (
    (canonical_grams_per_100g IS NULL OR canonical_kcal_per_100g IS NULL)
    AND (canonical_code IS NOT NULL OR (canonical_grams_per_100g IS NULL AND canonical_kcal_per_100g IS NULL))
  )
);

ALTER TABLE meal_nutrition_provenance
  DROP CONSTRAINT meal_nutrition_provenance_food_source_check,
  ADD CONSTRAINT meal_nutrition_provenance_food_source_check
    CHECK (food_source IN ('google_health_food', 'tw_fda', 'unmatched'));
