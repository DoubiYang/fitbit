import assert from 'node:assert/strict';
import test from 'node:test';

import type { VisionMeal } from '../../src/domain/meal-vision';
import {
  draftFromVision,
  googlePayloadProjection,
  replaceDishIngredients,
  setDishNutrient,
} from '../../src/server/meals/current-meal';
import { isGoogleSupportedNutrient } from '../../src/server/meals/google-nutrition';
import type { LocalTwFdaFood, TwFdaFoodCatalog } from '../../src/server/nutrition/tw-fda';

const foods: Record<string, LocalTwFdaFood> = {
  雞肉: {
    sourceRevision: 'source-sha',
    officialFoodId: 'CHICKEN',
    nameZh: '雞肉',
    aliases: [],
    nutrients: [
      { officialName: '熱量', rawUnit: 'kcal', per100gValue: 200 },
      { officialName: '粗蛋白', rawUnit: 'g', per100gValue: 20 },
      { officialName: '粗脂肪', rawUnit: 'g', per100gValue: 10 },
      { officialName: '膽鹼', rawUnit: 'mg', per100gValue: 80 },
    ],
  },
  白飯: {
    sourceRevision: 'source-sha',
    officialFoodId: 'RICE',
    nameZh: '白飯',
    aliases: [],
    nutrients: [
      { officialName: '熱量', rawUnit: 'kcal', per100gValue: 100 },
      { officialName: '總碳水化合物', rawUnit: 'g', per100gValue: 25 },
    ],
  },
};

const catalog: TwFdaFoodCatalog = { async findExact(nameZh) { return foods[nameZh]; } };

function vision(foods: VisionMeal['foods']): VisionMeal {
  return { foods, photoQuality: 'usable', globalUncertainties: [] };
}

function sourceDish(nameZh: string, ingredients: string[], portionGrams: number | { min: number; max: number }) {
  return {
    nameZh,
    ingredients,
    portionGrams,
    visibleFraction: 'full' as const,
    confidence: 0.9,
    needsConfirmation: [],
  };
}

test('uses UUID dish IDs and a vision range midpoint only to create initial explicit ingredient grams', async () => {
  const draft = await draftFromVision({
    mealId: 'meal-1',
    mealType: 'LUNCH',
    eatenAt: '2026-08-26T12:00:00.000+08:00',
    vision: vision([
      sourceDish('雞肉飯', ['雞肉', '白飯'], { min: 100, max: 200 }),
      sourceDish('白飯', ['白飯'], 30),
    ]),
  }, catalog);

  const dishId = draft.dishes[0]!.id;
  assert.match(dishId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
  assert.notEqual(draft.dishes[0]?.id, draft.dishes[1]?.id);
  assert.equal(draft.dishes[0]?.portionGrams, 150);
  assert.deepEqual(draft.dishes[0]?.ingredients, [
    { nameZh: '雞肉', grams: 75, foodSource: 'tw_fda', foodSourceId: 'CHICKEN', foodSourceVersion: 'source-sha' },
    { nameZh: '白飯', grams: 75, foodSource: 'tw_fda', foodSourceId: 'RICE', foodSourceVersion: 'source-sha' },
  ]);
  assert.ok(draft.nutrients.every((nutrient) => nutrient.source === 'tw_fda'));

  const replaced = await replaceDishIngredients(draft, {
    kind: 'replace_ingredients',
    dishId,
    nameZh: '改過的雞肉飯',
    ingredients: [{ nameZh: '雞肉', grams: 35 }, { nameZh: '白飯', grams: 10 }],
  }, catalog);

  assert.equal(replaced.dishes[0]?.portionGrams, 45);
  assert.equal(replaced.dishes[0]?.id, dishId);
  assert.deepEqual(replaced.dishes[0]?.ingredients, [
    { nameZh: '雞肉', grams: 35, foodSource: 'tw_fda', foodSourceId: 'CHICKEN', foodSourceVersion: 'source-sha' },
    { nameZh: '白飯', grams: 10, foodSource: 'tw_fda', foodSourceId: 'RICE', foodSourceVersion: 'source-sha' },
  ]);
});

test('replacing one dish discards all of only that dish’s prior nutrient values', async () => {
  const draft = await draftFromVision({
    mealId: 'meal-1',
    mealType: 'LUNCH',
    eatenAt: '2026-08-26T12:00:00.000+08:00',
    vision: vision([
      sourceDish('雞肉飯', ['雞肉'], 50),
      sourceDish('白飯', ['白飯'], 40),
    ]),
  }, catalog);
  const firstDishId = draft.dishes[0]!.id;
  const secondDishId = draft.dishes[1]!.id;
  const edited = setDishNutrient(draft, {
    kind: 'set_nutrient', dishId: firstDishId, nutrientCode: 'ENERGY', value: 999, unit: 'kcal',
  });
  const otherBefore = edited.nutrients.filter((item) => item.dishId === secondDishId);

  const replaced = await replaceDishIngredients(edited, {
    kind: 'replace_ingredients',
    dishId: firstDishId,
    nameZh: '白飯',
    ingredients: [{ nameZh: '白飯', grams: 30 }],
  }, catalog);

  const current = replaced.nutrients.filter((item) => item.dishId === firstDishId);
  assert.deepEqual(current, [
    { dishId: firstDishId, nutrientCode: 'ENERGY', value: 30, unit: 'kcal', source: 'tw_fda' },
    { dishId: firstDishId, nutrientCode: 'CARBOHYDRATES', value: 7.5, unit: 'g', source: 'tw_fda' },
  ]);
  assert.deepEqual(replaced.nutrients.filter((item) => item.dishId === secondDishId), otherBefore);
});

test('rejects invalid ingredient replacement patches before reading the food catalog', async () => {
  const draft = await draftFromVision({
    mealId: 'meal-1',
    mealType: 'LUNCH',
    eatenAt: '2026-08-26T12:00:00.000+08:00',
    vision: vision([sourceDish('雞肉飯', ['雞肉'], 50)]),
  }, catalog);
  let catalogCalls = 0;
  const countedCatalog: TwFdaFoodCatalog = {
    async findExact(nameZh) {
      catalogCalls += 1;
      return foods[nameZh];
    },
  };
  const invalidIngredient = {
    kind: 'replace_ingredients',
    dishId: draft.dishes[0]!.id,
    nameZh: '雞肉飯',
    ingredients: [{ nameZh: '雞肉', grams: 50, unexpected: true }],
  };

  await assert.rejects(
    replaceDishIngredients(draft, invalidIngredient as never, countedCatalog),
  );
  await assert.rejects(
    replaceDishIngredients(draft, { ...invalidIngredient, kind: 'set_nutrient' } as never, countedCatalog),
  );
  assert.equal(catalogCalls, 0);
});

test('edits exactly one existing nutrient and rejects unknown nutrients or dishes', async () => {
  const draft = await draftFromVision({
    mealId: 'meal-1',
    mealType: 'LUNCH',
    eatenAt: '2026-08-26T12:00:00.000+08:00',
    vision: vision([sourceDish('雞肉飯', ['雞肉'], 50)]),
  }, catalog);
  const dishId = draft.dishes[0]!.id;
  const updated = setDishNutrient(draft, {
    kind: 'set_nutrient', dishId, nutrientCode: 'PROTEIN', value: 12_500, unit: 'mg',
  });

  assert.equal(updated.nutrients.find((item) => item.nutrientCode === 'PROTEIN')?.value, 12.5);
  assert.equal(updated.nutrients.find((item) => item.nutrientCode === 'PROTEIN')?.unit, 'g');
  assert.deepEqual(
    updated.nutrients.filter((item) => item.nutrientCode !== 'PROTEIN'),
    draft.nutrients.filter((item) => item.nutrientCode !== 'PROTEIN'),
  );
  assert.throws(() => setDishNutrient(draft, {
    kind: 'set_nutrient', dishId, nutrientCode: 'ZINC', value: 1, unit: 'mg',
  }), /unknown nutrient/);
  assert.throws(() => setDishNutrient(draft, {
    kind: 'set_nutrient', dishId: 'missing', nutrientCode: 'PROTEIN', value: 1, unit: 'g',
  }), /unknown dish/);
});

test('shares the Google support rule with the current-draft projection without removing local-only facts', async () => {
  const draft = await draftFromVision({
    mealId: 'meal-1',
    mealType: 'LUNCH',
    eatenAt: '2026-08-26T12:00:00.000+08:00',
    vision: vision([sourceDish('雞肉飯', ['雞肉'], 50)]),
  }, catalog);

  const withMicronutrient = {
    ...draft,
    nutrients: [...draft.nutrients, {
      dishId: draft.dishes[0]!.id,
      nutrientCode: 'VITAMIN_C',
      value: 0.01,
      unit: 'g' as const,
      source: 'tw_fda' as const,
    }],
  };
  const projection = googlePayloadProjection(withMicronutrient);

  assert.deepEqual(projection.dishes, draft.dishes);
  assert.deepEqual(projection.nutrients.map((item) => item.nutrientCode), ['ENERGY', 'PROTEIN', 'FAT', 'VITAMIN_C']);
  for (const nutrientCode of ['ENERGY', 'FAT', 'VITAMIN_C', 'TW_FDA:膽鹼']) {
    assert.equal(
      projection.nutrients.some((nutrient) => nutrient.nutrientCode === nutrientCode),
      isGoogleSupportedNutrient(nutrientCode),
    );
  }
  assert.ok(draft.nutrients.some((item) => item.nutrientCode === 'TW_FDA:膽鹼'));
});
