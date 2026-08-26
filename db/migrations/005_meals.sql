ALTER TABLE users
  ADD COLUMN nutrition_writeback_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE meal_drafts (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  meal_type TEXT NOT NULL CHECK (meal_type IN ('BREAKFAST', 'LUNCH', 'DINNER', 'SNACK')),
  eaten_at TIMESTAMPTZ NOT NULL,
  vision JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE meal_versions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  previous_version_id UUID REFERENCES meal_versions (id),
  meal_type TEXT NOT NULL CHECK (meal_type IN ('BREAKFAST', 'LUNCH', 'DINNER', 'SNACK')),
  eaten_at TIMESTAMPTZ NOT NULL,
  writeback_this_meal BOOLEAN NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE meal_dishes (
  id UUID PRIMARY KEY,
  version_id UUID NOT NULL REFERENCES meal_versions (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client_short_id TEXT NOT NULL,
  name_zh TEXT NOT NULL,
  portion_grams NUMERIC(12, 3) NOT NULL,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_short_id)
);

CREATE TABLE meal_ingredients (
  id UUID PRIMARY KEY,
  dish_id UUID NOT NULL REFERENCES meal_dishes (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  food_name TEXT NOT NULL,
  grams NUMERIC(12, 3) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE meal_nutrients (
  dish_id UUID NOT NULL REFERENCES meal_dishes (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  nutrient_code TEXT NOT NULL,
  grams NUMERIC(20, 9),
  kcal NUMERIC(12, 3),
  source TEXT NOT NULL,
  confidence DOUBLE PRECISION,
  PRIMARY KEY (dish_id, nutrient_code)
);

CREATE TABLE nutrition_write_outbox (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  dish_id UUID NOT NULL REFERENCES meal_dishes (id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'delete')),
  data_point_name TEXT NOT NULL,
  payload_hash TEXT,
  status TEXT NOT NULL CHECK (
    status IN (
      'local_only',
      'write_pending',
      'operation_pending',
      'synced',
      'retrying',
      'unknown',
      'failed_action_required'
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_error_code TEXT,
  google_operation_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE google_nutrition_links (
  dish_id UUID PRIMARY KEY REFERENCES meal_dishes (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  data_point_name TEXT NOT NULL UNIQUE
);

CREATE INDEX meal_drafts_user_id_idx ON meal_drafts (user_id);
CREATE INDEX meal_versions_user_id_idx ON meal_versions (user_id, confirmed_at DESC);
CREATE INDEX meal_dishes_user_id_idx ON meal_dishes (user_id);
CREATE INDEX nutrition_write_outbox_due_idx ON nutrition_write_outbox (status, next_attempt_at);
