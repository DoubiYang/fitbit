import assert from 'node:assert/strict';
import test from 'node:test';

import type { VisionMeal } from '../../src/domain/meal-vision';
import {
  draftFromVision,
  googlePayloadProjection,
  replaceDishIngredients,
  setDishNutrient,
} from '../../src/server/meals/current-meal';
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

test('uses a vision range midpoint only to create the initial explicit ingredient grams', async () => {
  const draft = await draftFromVision({
    mealId: 'meal-1',
    mealType: 'LUNCH',
    eatenAt: '2026-08-26T12:00:00.000+08:00',
    vision: vision([sourceDish('雞肉飯', ['雞肉', '白飯'], { min: 100, max: 200 })]),
  }, catalog);

  assert.equal(draft.dishes[0]?.id, 'dish:0');
  assert.equal(draft.dishes[0]?.portionGrams, 150);
  assert.deepEqual(draft.dishes[0]?.ingredients, [{ nameZh: '雞肉', grams: 75 }, { nameZh: '白飯', grams: 75 }]);

  const replaced = await replaceDishIngredients(draft, {
    kind: 'replace_ingredients',
    dishId: 'dish:0',
    nameZh: '改過的雞肉飯',
    ingredients: [{ nameZh: '雞肉', grams: 35 }, { nameZh: '白飯', grams: 10 }],
  }, catalog);

  assert.equal(replaced.dishes[0]?.portionGrams, 45);
  assert.deepEqual(replaced.dishes[0]?.ingredients, [{ nameZh: '雞肉', grams: 35 }, { nameZh: '白飯', grams: 10 }]);
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
  const edited = setDishNutrient(draft, {
    kind: 'set_nutrient', dishId: 'dish:0', nutrientCode: 'ENERGY', value: 999, unit: 'kcal',
  });
  const otherBefore = edited.nutrients.filter((item) => item.dishId === 'dish:1');

  const replaced = await replaceDishIngredients(edited, {
    kind: 'replace_ingredients',
    dishId: 'dish:0',
    nameZh: '白飯',
    ingredients: [{ nameZh: '白飯', grams: 30 }],
  }, catalog);

  const current = replaced.nutrients.filter((item) => item.dishId === 'dish:0');
  assert.deepEqual(current, [
    { dishId: 'dish:0', nutrientCode: 'ENERGY', value: 30, unit: 'kcal' },
    { dishId: 'dish:0', nutrientCode: 'CARBOHYDRATES', value: 7.5, unit: 'g' },
  ]);
  assert.deepEqual(replaced.nutrients.filter((item) => item.dishId === 'dish:1'), otherBefore);
});

test('edits exactly one existing nutrient and rejects unknown nutrients or dishes', async () => {
  const draft = await draftFromVision({
    mealId: 'meal-1',
    mealType: 'LUNCH',
    eatenAt: '2026-08-26T12:00:00.000+08:00',
    vision: vision([sourceDish('雞肉飯', ['雞肉'], 50)]),
  }, catalog);
  const updated = setDishNutrient(draft, {
    kind: 'set_nutrient', dishId: 'dish:0', nutrientCode: 'PROTEIN', value: 12_500, unit: 'mg',
  });

  assert.equal(updated.nutrients.find((item) => item.nutrientCode === 'PROTEIN')?.value, 12_500);
  assert.equal(updated.nutrients.find((item) => item.nutrientCode === 'PROTEIN')?.unit, 'mg');
  assert.deepEqual(
    updated.nutrients.filter((item) => item.nutrientCode !== 'PROTEIN'),
    draft.nutrients.filter((item) => item.nutrientCode !== 'PROTEIN'),
  );
  assert.throws(() => setDishNutrient(draft, {
    kind: 'set_nutrient', dishId: 'dish:0', nutrientCode: 'ZINC', value: 1, unit: 'mg',
  }), /unknown nutrient/);
  assert.throws(() => setDishNutrient(draft, {
    kind: 'set_nutrient', dishId: 'missing', nutrientCode: 'PROTEIN', value: 1, unit: 'g',
  }), /unknown dish/);
});

test('projects Google-supported nutrients without removing local-only draft facts', async () => {
  const draft = await draftFromVision({
    mealId: 'meal-1',
    mealType: 'LUNCH',
    eatenAt: '2026-08-26T12:00:00.000+08:00',
    vision: vision([sourceDish('雞肉飯', ['雞肉'], 50)]),
  }, catalog);

  const projection = googlePayloadProjection(draft);

  assert.deepEqual(projection.dishes, draft.dishes);
  assert.deepEqual(projection.nutrients.map((item) => item.nutrientCode), ['ENERGY', 'PROTEIN']);
  assert.ok(draft.nutrients.some((item) => item.nutrientCode === 'TW_FDA:膽鹼'));
});
