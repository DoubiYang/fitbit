-- Legacy meal_versions and nutrition_write_outbox remain the completion path for
-- jobs created before this migration. New editable meals use only the tables below.
ALTER TABLE meal_drafts
  ADD COLUMN editor JSONB NULL;

CREATE TABLE current_meals (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  meal_type TEXT NOT NULL CHECK (meal_type IN ('BREAKFAST', 'LUNCH', 'DINNER', 'SNACK')),
  eaten_at TIMESTAMPTZ NOT NULL,
  content_revision INTEGER NOT NULL DEFAULT 1 CHECK (content_revision >= 1),
  sync_state TEXT NOT NULL DEFAULT 'unsynced'
    CHECK (sync_state IN ('unsynced', 'syncing', 'synced', 'recovery')),
  last_synced_generation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);

CREATE TABLE current_meal_dishes (
  meal_id UUID NOT NULL,
  user_id UUID NOT NULL,
  dish_key TEXT NOT NULL,
  name_zh TEXT NOT NULL,
  portion_grams NUMERIC(12, 3) NOT NULL CHECK (portion_grams > 0),
  PRIMARY KEY (meal_id, dish_key),
  UNIQUE (meal_id, dish_key, user_id),
  FOREIGN KEY (meal_id, user_id)
    REFERENCES current_meals (id, user_id)
    ON DELETE CASCADE
);

CREATE TABLE current_meal_ingredients (
  id UUID PRIMARY KEY,
  meal_id UUID NOT NULL,
  dish_key TEXT NOT NULL,
  user_id UUID NOT NULL,
  name_zh TEXT NOT NULL,
  grams NUMERIC(12, 3) NOT NULL CHECK (grams > 0),
  food_source TEXT NOT NULL CHECK (food_source IN ('google_health_food', 'tw_fda', 'unmatched')),
  food_source_id TEXT,
  food_source_version TEXT,
  FOREIGN KEY (meal_id, dish_key, user_id)
    REFERENCES current_meal_dishes (meal_id, dish_key, user_id)
    ON DELETE CASCADE
);

CREATE TABLE current_meal_nutrients (
  meal_id UUID NOT NULL,
  dish_key TEXT NOT NULL,
  user_id UUID NOT NULL,
  nutrient_code TEXT NOT NULL,
  grams NUMERIC(20, 9),
  kcal NUMERIC(12, 3),
  source TEXT NOT NULL,
  source_unit TEXT NOT NULL,
  current_unit TEXT NOT NULL CHECK (current_unit IN ('kcal', 'g')),
  PRIMARY KEY (meal_id, dish_key, nutrient_code),
  FOREIGN KEY (meal_id, dish_key, user_id)
    REFERENCES current_meal_dishes (meal_id, dish_key, user_id)
    ON DELETE CASCADE,
  CHECK (
    (nutrient_code = 'ENERGY' AND kcal IS NOT NULL AND grams IS NULL AND current_unit = 'kcal')
    OR (nutrient_code <> 'ENERGY' AND grams IS NOT NULL AND kcal IS NULL AND current_unit = 'g')
  )
);

CREATE TABLE meal_sync_generations (
  id UUID PRIMARY KEY,
  meal_id UUID NOT NULL,
  user_id UUID NOT NULL,
  content_revision INTEGER NOT NULL CHECK (content_revision >= 1),
  phase TEXT NOT NULL CHECK (phase IN ('pending_delete', 'pending_create', 'synced', 'recovery')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (id, meal_id, user_id),
  FOREIGN KEY (meal_id, user_id)
    REFERENCES current_meals (id, user_id)
    ON DELETE CASCADE
);

ALTER TABLE current_meals
  ADD CONSTRAINT current_meals_last_synced_generation_id_fkey
  FOREIGN KEY (last_synced_generation_id, id, user_id)
  REFERENCES meal_sync_generations (id, meal_id, user_id)
  ON DELETE SET NULL (last_synced_generation_id);

CREATE UNIQUE INDEX meal_sync_generations_one_active_per_meal_idx
  ON meal_sync_generations (meal_id)
  WHERE phase IN ('pending_delete', 'pending_create', 'recovery');

CREATE TABLE meal_sync_points (
  id UUID PRIMARY KEY,
  generation_id UUID NOT NULL,
  user_id UUID NOT NULL,
  dish_key TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('delete_target', 'create_target')),
  data_point_name TEXT NOT NULL,
  payload JSONB,
  payload_hash TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'leased', 'operation_pending', 'synced', 'retrying', 'unknown', 'failed_action_required')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ,
  lease_until TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  last_error_code TEXT,
  google_operation_name TEXT,
  recovery_state TEXT,
  recovery_requested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (data_point_name),
  CHECK (
    (role = 'delete_target' AND payload IS NULL AND payload_hash IS NULL)
    OR (role = 'create_target' AND payload IS NOT NULL AND payload_hash IS NOT NULL)
  ),
  FOREIGN KEY (generation_id, user_id)
    REFERENCES meal_sync_generations (id, user_id)
    ON DELETE CASCADE
);

CREATE FUNCTION prevent_meal_sync_point_payload_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.payload IS DISTINCT FROM OLD.payload OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash THEN
    RAISE EXCEPTION 'meal_sync_points payload and payload_hash are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER meal_sync_points_payload_immutable
BEFORE UPDATE OF payload, payload_hash ON meal_sync_points
FOR EACH ROW
EXECUTE FUNCTION prevent_meal_sync_point_payload_mutation();

CREATE INDEX current_meals_user_eaten_at_idx ON current_meals (user_id, eaten_at DESC);
CREATE INDEX current_meal_dishes_user_id_idx ON current_meal_dishes (user_id, meal_id);
CREATE INDEX current_meal_ingredients_user_id_idx ON current_meal_ingredients (user_id, meal_id, dish_key);
CREATE INDEX current_meal_nutrients_user_id_idx ON current_meal_nutrients (user_id, meal_id, dish_key);
CREATE INDEX meal_sync_generations_active_read_idx
  ON meal_sync_generations (user_id, meal_id, updated_at)
  WHERE phase IN ('pending_delete', 'pending_create', 'recovery');
CREATE INDEX meal_sync_points_due_claim_idx
  ON meal_sync_points (status, next_attempt_at, lease_until, created_at)
  WHERE status IN ('pending', 'retrying', 'operation_pending');
