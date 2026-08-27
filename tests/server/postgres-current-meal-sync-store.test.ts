import assert from 'node:assert/strict';
import test from 'node:test';

import { createPostgresStoreForTesting } from '../../src/server/db/postgres-store';

type Query = { text: string; values: unknown[] | undefined };
type QueryResponse = { rows: Array<Record<string, unknown>>; rowCount?: number };

const now = new Date('2026-08-27T08:00:00.000Z');

class RecordingPool {
  readonly queries: Query[] = [];
  private readonly responses: QueryResponse[];
  readonly client = {
    query: async (text: string, values?: unknown[]) => this.query(text, values),
    release: () => undefined,
  };

  constructor(responses: QueryResponse[]) {
    this.responses = [...responses];
  }

  async connect() {
    return this.client;
  }

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text, values });
    const response = this.responses.shift();
    if (!response) throw new Error(`unexpected query: ${text}`);
    return { rows: response.rows, rowCount: response.rowCount ?? response.rows.length };
  }
}

function currentMealRows(): QueryResponse[] {
  return [
    { rows: [{
      id: 'meal-1', user_id: 'u1', meal_type: 'LUNCH', eaten_at: now,
      content_revision: 3, sync_state: 'unsynced', last_synced_generation_id: null,
      created_at: now, updated_at: now,
    }] },
    { rows: [{ meal_id: 'meal-1', user_id: 'u1', dish_key: 'dish-1', name_zh: '鸡肉饭', portion_grams: '150' }] },
    { rows: [{
      meal_id: 'meal-1', user_id: 'u1', dish_key: 'dish-1', name_zh: '鸡肉', grams: '150',
      food_source: 'tw_fda', food_source_id: 'V0100101', food_source_version: 'fda-test',
    }] },
    { rows: [
      { meal_id: 'meal-1', user_id: 'u1', dish_key: 'dish-1', nutrient_code: 'ENERGY', grams: null, kcal: '300', source: 'tw_fda', source_unit: 'kcal', current_unit: 'kcal' },
      { meal_id: 'meal-1', user_id: 'u1', dish_key: 'dish-1', nutrient_code: 'PROTEIN', grams: '25', kcal: null, source: 'tw_fda', source_unit: 'g', current_unit: 'g' },
    ] },
  ];
}

function generationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'generation-1', meal_id: 'meal-1', user_id: 'u1', content_revision: 3,
    phase: 'pending_create', created_at: now, updated_at: now,
    ...overrides,
  };
}

function createPointRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'point-1', generation_id: 'generation-1', user_id: 'u1', dish_key: 'dish-1', role: 'create_target',
    data_point_name: 'users/me/dataTypes/nutrition-log/dataPoints/d-original',
    payload: { name: 'users/me/dataTypes/nutrition-log/dataPoints/d-original', nutritionLog: {} }, payload_hash: 'a'.repeat(64),
    status: 'synced', attempt_count: 1, next_attempt_at: null, lease_until: null, last_attempt_at: now,
    last_error_code: null, google_operation_name: null, recovery_state: null, recovery_requested_at: null,
    ...overrides,
  };
}

test('PostgreSQL startGeneration locks the current meal and freezes an immutable create payload in one transaction', async () => {
  const pool = new RecordingPool([
    { rows: [] },
    ...currentMealRows(),
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
  ]);
  const store = createPostgresStoreForTesting(pool);

  const generation = await store.mealSync!.startGeneration({ mealId: 'meal-1', userId: 'u1', now });

  assert.equal(generation?.contentRevision, 3);
  assert.equal(generation?.phase, 'pending_create');
  assert.equal(pool.queries[0]?.text, 'BEGIN');
  const currentMealLock = pool.queries.find((query) => /FROM current_meals/u.test(query.text));
  assert.match(currentMealLock?.text ?? '', /FOR UPDATE/u);
  assert.deepEqual(currentMealLock?.values, ['meal-1', 'u1']);
  const activeLock = pool.queries.find((query) => /FROM meal_sync_generations/u.test(query.text));
  assert.match(activeLock?.text ?? '', /FOR UPDATE/u);
  const pointInsert = pool.queries.find((query) => /INSERT INTO meal_sync_points/u.test(query.text));
  assert.match(String(pointInsert?.values?.[4]), /\/d-[0-9a-f-]+$/u);
  assert.match(String(pointInsert?.values?.[5]), /"nutritionLog"/u);
  assert.equal(pool.queries.at(-1)?.text, 'COMMIT');
});

test('PostgreSQL finishPoint finalizes only its exact leased generation without searching another meal', async () => {
  const leaseUntil = new Date(now.getTime() + 120_000);
  const pool = new RecordingPool([
    { rows: [] },
    { rows: [{ generation_id: 'generation-1' }] },
    { rows: [generationRow()] },
    { rows: [createPointRow()] },
    { rows: [{ last_synced_generation_id: null }] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
  ]);
  const store = createPostgresStoreForTesting(pool);

  const finished = await store.mealSync!.finishPoint({
    id: 'point-1', generationId: 'generation-1', userId: 'u1', leaseUntil, now,
  });

  assert.equal(finished, true);
  assert.equal(pool.queries.some((query) => query.values?.includes('')), false);
  assert.ok(pool.queries.some((query) => /SET sync_state = 'synced'/u.test(query.text)));
  assert.equal(pool.queries.at(-1)?.text, 'COMMIT');
});

test('PostgreSQL recovery returns the resumed pending phase after action-required preconditions are restored', async () => {
  const pool = new RecordingPool([
    { rows: [] },
    { rows: [generationRow({ phase: 'recovery' })] },
    { rows: [createPointRow({ status: 'failed_action_required' })] },
    { rows: [] },
    { rows: [createPointRow({ status: 'pending', next_attempt_at: now })] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
  ]);
  const store = createPostgresStoreForTesting(pool);

  const resumed = await store.mealSync!.beginRecovery({
    mealId: 'meal-1', userId: 'u1', now, reason: 'writeback_prerequisites_restored',
  });

  assert.equal(resumed?.phase, 'pending_create');
  assert.equal(pool.queries.at(-1)?.text, 'COMMIT');
});

test('PostgreSQL recovery gives an unknown point priority over action-required resumption', async () => {
  const pool = new RecordingPool([
    { rows: [] },
    { rows: [generationRow({ phase: 'recovery' })] },
    { rows: [
      createPointRow({ id: 'unknown-point', status: 'unknown' }),
      createPointRow({ id: 'failed-point', status: 'failed_action_required' }),
    ] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
  ]);
  const store = createPostgresStoreForTesting(pool);

  const resumed = await store.mealSync!.beginRecovery({
    mealId: 'meal-1', userId: 'u1', now, reason: 'retry_this_meal',
  });

  assert.equal(resumed?.phase, 'recovery');
  assert.ok(pool.queries.some((query) => /SET recovery_requested_at/u.test(query.text)));
  assert.equal(pool.queries.some((query) => /SET status = \$4/u.test(query.text)), false);
  assert.equal(pool.queries.at(-1)?.text, 'COMMIT');
});

test('PostgreSQL retrying keeps its generation pending and the current meal syncing', async () => {
  const leaseUntil = new Date(now.getTime() + 120_000);
  const retryAt = new Date(now.getTime() + 60_000);
  const pool = new RecordingPool([
    { rows: [] },
    { rows: [{ generation_id: 'generation-1' }] },
    { rows: [generationRow()] },
    { rows: [createPointRow({ status: 'retrying', next_attempt_at: retryAt })] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
  ]);
  const store = createPostgresStoreForTesting(pool);

  const retried = await store.mealSync!.retryPoint({
    id: 'point-1', generationId: 'generation-1', userId: 'u1', leaseUntil, now,
    nextAttemptAt: retryAt, errorCode: 'google_503',
  });

  assert.equal(retried, true);
  const generationUpdate = pool.queries.find((query) => /UPDATE meal_sync_generations/u.test(query.text));
  assert.equal(generationUpdate?.values?.[2], 'pending_create');
  const mealUpdate = pool.queries.find((query) => /UPDATE current_meals/u.test(query.text));
  assert.equal(mealUpdate?.values?.[2], 'syncing');
  assert.equal(pool.queries.at(-1)?.text, 'COMMIT');
});
