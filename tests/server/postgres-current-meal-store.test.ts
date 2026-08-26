import assert from 'node:assert/strict';
import test from 'node:test';

import type { EditableMealDraft } from '../../src/domain/meal-editor';
import { createPostgresStoreForTesting } from '../../src/server/db/postgres-store';
import { CurrentMealEditLockedError } from '../../src/server/meals/types';

type Query = { text: string; values: unknown[] | undefined };
type QueryResponse = { rows: Array<Record<string, unknown>>; rowCount?: number } | Error;
type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number };

const now = new Date('2026-08-26T12:00:00.000Z');

function editor(mealId = 'draft-1'): EditableMealDraft {
  return {
    view: 'draft',
    mealId,
    mealType: 'LUNCH',
    eatenAt: now.toISOString(),
    dishes: [{
      id: 'dish-1',
      nameZh: '雞肉飯',
      portionGrams: 150,
      ingredients: [{
        nameZh: '雞肉',
        grams: 150,
        foodSource: 'tw_fda',
        foodSourceId: 'V0100101',
        foodSourceVersion: 'fda-sha',
      }],
    }],
    nutrients: [
      { dishId: 'dish-1', nutrientCode: 'ENERGY', value: 300, unit: 'kcal', source: 'tw_fda' },
      { dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 12.5, unit: 'g', source: 'tw_fda' },
    ],
  };
}

function editorWithTwoDishes(): EditableMealDraft {
  const draft = editor();
  draft.dishes[0] = {
    ...draft.dishes[0]!,
    ingredients: [
      draft.dishes[0]!.ingredients[0]!,
      { nameZh: '白飯', grams: 30, foodSource: 'unmatched', foodSourceId: undefined, foodSourceVersion: undefined },
    ],
  };
  draft.dishes.push({
    id: 'dish-2',
    nameZh: '豆腐',
    portionGrams: 80,
    ingredients: [{
      nameZh: '豆腐', grams: 80, foodSource: 'tw_fda', foodSourceId: 'V0200202', foodSourceVersion: 'fda-sha',
    }],
  });
  draft.nutrients.push({ dishId: 'dish-2', nutrientCode: 'ENERGY', value: 60, unit: 'kcal', source: 'tw_fda' });
  return draft;
}

function mealRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'draft-1',
    user_id: 'u1',
    meal_type: 'LUNCH',
    eaten_at: now,
    content_revision: 1,
    sync_state: 'unsynced',
    last_synced_generation_id: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function dishRow(): Record<string, unknown> {
  return {
    meal_id: 'draft-1', user_id: 'u1', dish_key: 'dish-1', name_zh: '雞肉飯', portion_grams: '150.000',
  };
}

function ingredientRow(): Record<string, unknown> {
  return {
    meal_id: 'draft-1', user_id: 'u1', dish_key: 'dish-1', name_zh: '雞肉', grams: '150.000',
    food_source: 'tw_fda', food_source_id: 'V0100101', food_source_version: 'fda-sha',
  };
}

function nutrientRows(): Array<Record<string, unknown>> {
  return [
    {
      meal_id: 'draft-1', user_id: 'u1', dish_key: 'dish-1', nutrient_code: 'ENERGY', grams: null, kcal: '300.000',
      source: 'tw_fda', source_unit: 'kcal', current_unit: 'kcal',
    },
    {
      meal_id: 'draft-1', user_id: 'u1', dish_key: 'dish-1', nutrient_code: 'PROTEIN', grams: '12.500000000', kcal: null,
      source: 'tw_fda', source_unit: 'g', current_unit: 'g',
    },
  ];
}

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

  async query(text: string, values?: unknown[]): Promise<QueryResult> {
    this.queries.push({ text, values });
    const response = this.responses.shift();
    if (!response) throw new Error(`unexpected query: ${text}`);
    if (response instanceof Error) throw response;
    return { rows: response.rows, rowCount: response.rowCount ?? response.rows.length };
  }
}

function currentMealReadResponses(): QueryResponse[] {
  return [
    { rows: [mealRow()] },
    { rows: [dishRow()] },
    { rows: [ingredientRow()] },
    { rows: nutrientRows() },
  ];
}

function twoDishCurrentMealReadResponses(): QueryResponse[] {
  return [
    { rows: [mealRow()] },
    { rows: [dishRow(), { meal_id: 'draft-1', user_id: 'u1', dish_key: 'dish-2', name_zh: '豆腐', portion_grams: '80.000' }] },
    { rows: [
      ingredientRow(),
      {
        meal_id: 'draft-1', user_id: 'u1', dish_key: 'dish-1', name_zh: '白飯', grams: '30.000',
        food_source: 'unmatched', food_source_id: null, food_source_version: null,
      },
      {
        meal_id: 'draft-1', user_id: 'u1', dish_key: 'dish-2', name_zh: '豆腐', grams: '80.000',
        food_source: 'tw_fda', food_source_id: 'V0200202', food_source_version: 'fda-sha',
      },
    ] },
    { rows: [
      ...nutrientRows(),
      {
        meal_id: 'draft-1', user_id: 'u1', dish_key: 'dish-2', nutrient_code: 'ENERGY', grams: null, kcal: '60.000',
        source: 'tw_fda', source_unit: 'kcal', current_unit: 'kcal',
      },
    ] },
  ];
}

test('saves an editor draft atomically after locking the current meal and writing all current children', async () => {
  const pool = new RecordingPool([
    { rows: [] },
    { rows: [{ ...mealRow(), editor: editor() }] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
  ]);
  const store = createPostgresStoreForTesting(pool);

  const saved = await store.currentMeals.saveEditorDraft({ userId: 'u1', draftId: 'draft-1', now });

  assert.equal(saved.contentRevision, 1);
  assert.equal(saved.syncState, 'unsynced');
  assert.deepEqual(saved.dishes[0]?.ingredients[0], editor().dishes[0]?.ingredients[0]);
  assert.equal(pool.queries[0]?.text, 'BEGIN');
  assert.match(pool.queries[2]?.text ?? '', /FROM current_meals/u);
  assert.match(pool.queries[2]?.text ?? '', /user_id = \$2/u);
  assert.match(pool.queries[2]?.text ?? '', /FOR UPDATE/u);
  const draftDelete = pool.queries.findIndex((query) => /DELETE FROM meal_drafts/u.test(query.text));
  const nutrientInsert = pool.queries.findIndex((query) => /INSERT INTO current_meal_nutrients/u.test(query.text));
  assert.ok(nutrientInsert >= 0 && nutrientInsert < draftDelete);
  assert.deepEqual(pool.queries[nutrientInsert]?.values?.slice(0, 9), [
    'draft-1', 'u1', 'dish-1', 'ENERGY', null, 300, 'tw_fda', 'kcal', 'kcal',
  ]);
  assert.equal(pool.queries.at(-1)?.text, 'COMMIT');
});

test('rolls back the whole save transaction when writing a current child fails', async () => {
  const pool = new RecordingPool([
    { rows: [] },
    { rows: [{ ...mealRow(), editor: editor() }] },
    { rows: [] },
    { rows: [] },
    new Error('current child write failed'),
    { rows: [] },
  ]);
  const store = createPostgresStoreForTesting(pool);

  await assert.rejects(store.currentMeals.saveEditorDraft({ userId: 'u1', draftId: 'draft-1', now }), /current child write failed/u);

  assert.equal(pool.queries[0]?.text, 'BEGIN');
  assert.equal(pool.queries.at(-1)?.text, 'ROLLBACK');
  assert.equal(pool.queries.some((query) => /DELETE FROM meal_drafts/u.test(query.text)), false);
});

test('reads current meals through user-scoped queries and restores provenance and canonical nutrient values', async () => {
  const pool = new RecordingPool(currentMealReadResponses());
  const store = createPostgresStoreForTesting(pool);

  const snapshot = await store.currentMeals.findCurrentMeal('u1', 'draft-1');

  assert.deepEqual(snapshot?.dishes[0]?.ingredients[0], editor().dishes[0]?.ingredients[0]);
  assert.deepEqual(snapshot?.nutrients, editor().nutrients);
  assert.equal(pool.queries.length, 4);
  for (const query of pool.queries) {
    assert.match(query.text, /user_id = \$2/u);
    assert.deepEqual(query.values?.slice(0, 2), ['draft-1', 'u1']);
  }
});

test('rejects malformed JSONB editor snapshots instead of returning unchecked input', async () => {
  const pool = new RecordingPool([{ rows: [{ editor: { view: 'draft', mealId: 'draft-1' } }] }]);
  const store = createPostgresStoreForTesting(pool);

  await assert.rejects(store.currentMeals.findEditorDraft('u1', 'draft-1'));
  assert.match(pool.queries[0]?.text ?? '', /editor IS NOT NULL/u);
  assert.match(pool.queries[0]?.text ?? '', /user_id = \$2/u);
});

test('does not replace children or increment revision when saved content is unchanged', async () => {
  const pool = new RecordingPool([
    { rows: [] },
    ...currentMealReadResponses(),
    { rows: [] },
    { rows: [] },
  ]);
  const store = createPostgresStoreForTesting(pool);

  const unchanged = await store.currentMeals.replaceCurrentMealContent({ userId: 'u1', mealId: 'draft-1', editor: editor(), now });

  assert.equal(unchanged?.contentRevision, 1);
  assert.equal(pool.queries.some((query) => /DELETE FROM current_meal_dishes/u.test(query.text)), false);
  assert.equal(pool.queries.some((query) => /UPDATE current_meals/u.test(query.text)), false);
  assert.equal(pool.queries.at(-1)?.text, 'COMMIT');
});

test('does not replace current content when the editor uses a different offset for the same instant', async () => {
  const pool = new RecordingPool([
    { rows: [] },
    ...currentMealReadResponses(),
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
  ]);
  const store = createPostgresStoreForTesting(pool);
  const sameInstant = editor();
  sameInstant.eatenAt = '2026-08-26T20:00:00.000+08:00';

  const unchanged = await store.currentMeals.replaceCurrentMealContent({
    userId: 'u1', mealId: 'draft-1', editor: sameInstant, now,
  });

  assert.equal(unchanged?.contentRevision, 1);
  assert.equal(pool.queries.some((query) => /DELETE FROM current_meal_dishes/u.test(query.text)), false);
  assert.equal(pool.queries.some((query) => /UPDATE current_meals/u.test(query.text)), false);
  assert.equal(pool.queries.at(-1)?.text, 'COMMIT');
});

test('does not replace current content when dishes, ingredients, and nutrients are only reordered', async () => {
  const pool = new RecordingPool([
    { rows: [] },
    ...twoDishCurrentMealReadResponses(),
    { rows: [] },
  ]);
  const store = createPostgresStoreForTesting(pool);
  const reordered = editorWithTwoDishes();
  reordered.dishes = reordered.dishes
    .map((dish) => ({ ...dish, ingredients: [...dish.ingredients].reverse() }))
    .reverse();
  reordered.nutrients = [...reordered.nutrients].reverse();

  const unchanged = await store.currentMeals.replaceCurrentMealContent({
    userId: 'u1', mealId: 'draft-1', editor: reordered, now,
  });

  assert.equal(unchanged?.contentRevision, 1);
  assert.equal(pool.queries.some((query) => /DELETE FROM current_meal_dishes/u.test(query.text)), false);
  assert.equal(pool.queries.some((query) => /UPDATE current_meals/u.test(query.text)), false);
  assert.equal(pool.queries.at(-1)?.text, 'COMMIT');
});

test('replaces saved content atomically with a new revision and resolver provenance', async () => {
  const pool = new RecordingPool([
    { rows: [] },
    ...currentMealReadResponses(),
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
  ]);
  const store = createPostgresStoreForTesting(pool);
  const replacement = editor();
  replacement.dishes[0] = {
    id: 'dish-1',
    nameZh: '豆腐飯',
    portionGrams: 180,
    ingredients: [{
      nameZh: '豆腐', grams: 180, foodSource: 'tw_fda', foodSourceId: 'V0200202', foodSourceVersion: 'new-sha',
    }],
  };
  replacement.nutrients = [
    { dishId: 'dish-1', nutrientCode: 'ENERGY', value: 250, unit: 'kcal', source: 'tw_fda' },
    { dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 18, unit: 'g', source: 'tw_fda' },
  ];

  const updated = await store.currentMeals.replaceCurrentMealContent({
    userId: 'u1', mealId: 'draft-1', editor: replacement, now,
  });

  assert.equal(updated?.contentRevision, 2);
  assert.deepEqual(updated?.dishes, replacement.dishes);
  const lock = pool.queries.find((query) => /FROM current_meals/u.test(query.text));
  assert.match(lock?.text ?? '', /FOR UPDATE/u);
  const childDelete = pool.queries.findIndex((query) => /DELETE FROM current_meal_dishes/u.test(query.text));
  const insertedIngredient = pool.queries.find((query) => /INSERT INTO current_meal_ingredients/u.test(query.text));
  assert.ok(childDelete >= 0 && childDelete < pool.queries.indexOf(insertedIngredient!));
  assert.deepEqual(insertedIngredient?.values?.slice(1), [
    'draft-1', 'dish-1', 'u1', '豆腐', 180, 'tw_fda', 'V0200202', 'new-sha',
  ]);
  assert.equal(pool.queries.some((query) => /DELETE FROM meal_drafts/u.test(query.text)), false);
  assert.equal(pool.queries.at(-1)?.text, 'COMMIT');
});

test('updates one nutrient using canonical storage while marking only that nutrient as user-edited', async () => {
  const pool = new RecordingPool([
    { rows: [] },
    ...currentMealReadResponses(),
    { rows: [{ meal_id: 'draft-1' }] },
    { rows: [{ ...mealRow({ content_revision: 2, sync_state: 'unsynced', updated_at: now }) }] },
    { rows: [] },
  ]);
  const store = createPostgresStoreForTesting(pool);

  const updated = await store.currentMeals.setCurrentMealNutrient({
    userId: 'u1', mealId: 'draft-1', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 13_500, unit: 'mg', now,
  });

  assert.deepEqual(updated?.nutrients, [
    editor().nutrients[0]!,
    { dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 13.5, unit: 'g', source: 'user_edit' },
  ]);
  const nutrientUpdate = pool.queries.find((query) => /UPDATE current_meal_nutrients/u.test(query.text));
  assert.match(nutrientUpdate?.text ?? '', /user_id = \$2/u);
  assert.deepEqual(nutrientUpdate?.values, ['draft-1', 'u1', 'dish-1', 'PROTEIN', 13.5, null, 'user_edit', 'g', 'g']);
  const mealUpdate = pool.queries.find((query) => /UPDATE current_meals/u.test(query.text));
  assert.match(mealUpdate?.text ?? '', /user_id = \$2/u);
  assert.equal(pool.queries.some((query) => /meal_sync_points/u.test(query.text)), false);
  assert.equal(pool.queries.at(-1)?.text, 'COMMIT');
});

test('does not increment revision when a direct nutrient edit is already the current user-visible value', async () => {
  const pool = new RecordingPool([
    { rows: [] },
    ...currentMealReadResponses(),
    { rows: [] },
    { rows: [] },
  ]);
  const store = createPostgresStoreForTesting(pool);

  const unchanged = await store.currentMeals.setCurrentMealNutrient({
    userId: 'u1', mealId: 'draft-1', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 12_500, unit: 'mg', now,
  });

  assert.equal(unchanged?.contentRevision, 1);
  assert.equal(pool.queries.some((query) => /UPDATE current_meal_nutrients/u.test(query.text)), false);
  assert.equal(pool.queries.some((query) => /UPDATE current_meals/u.test(query.text)), false);
  assert.equal(pool.queries.at(-1)?.text, 'COMMIT');
});

test('rejects a saved content replacement after the row lock observes an active sync generation', async () => {
  const pool = new RecordingPool([
    { rows: [] },
    ...[
      { rows: [mealRow({ sync_state: 'syncing' })] },
      { rows: [dishRow()] },
      { rows: [ingredientRow()] },
      { rows: nutrientRows() },
    ],
    { rows: [] },
  ]);
  const store = createPostgresStoreForTesting(pool);

  await assert.rejects(
    store.currentMeals.replaceCurrentMealContent({ userId: 'u1', mealId: 'draft-1', editor: editor(), now }),
    CurrentMealEditLockedError,
  );

  assert.match(pool.queries[1]?.text ?? '', /FOR UPDATE/u);
  assert.equal(pool.queries.some((query) => /UPDATE current_meals/u.test(query.text)), false);
  assert.equal(pool.queries.at(-1)?.text, 'ROLLBACK');
});
