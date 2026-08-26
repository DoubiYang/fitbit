ALTER TABLE meal_ingredients
  ADD COLUMN food_source TEXT,
  ADD COLUMN food_source_id TEXT,
  ADD COLUMN food_source_version TEXT;

ALTER TABLE nutrition_write_outbox
  ADD COLUMN payload JSONB;

CREATE TABLE meal_nutrition_provenance (
  dish_id UUID PRIMARY KEY REFERENCES meal_dishes (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  resolver_version TEXT NOT NULL,
  food_source TEXT NOT NULL CHECK (food_source IN ('google_health_food', 'unmatched')),
  food_source_version TEXT,
  vision_confidence DOUBLE PRECISION NOT NULL CHECK (vision_confidence >= 0 AND vision_confidence <= 1),
  total_ingredient_grams NUMERIC(12, 3) NOT NULL CHECK (total_ingredient_grams >= 0),
  matched_ingredient_grams NUMERIC(12, 3) NOT NULL CHECK (matched_ingredient_grams >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (matched_ingredient_grams <= total_ingredient_grams)
);

CREATE INDEX meal_nutrition_provenance_user_id_idx ON meal_nutrition_provenance (user_id);
