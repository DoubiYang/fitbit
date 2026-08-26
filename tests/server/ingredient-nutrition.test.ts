import assert from 'node:assert/strict';
import test from 'node:test';

import { allocateIngredientGrams } from '../../src/server/meals/ingredient-grams';
import { mapFoodHit, pickBestHit } from '../../src/server/meals/google-food';
import { resolveDishIngredients } from '../../src/server/meals/ingredient-nutrition';

test('allocates most grams to primary ingredients and a little to oil', () => {
  const allocated = allocateIngredientGrams(['牛肉', '酱油', '芝麻'], 180);
  const beef = allocated.find((item) => item.nameZh === '牛肉');
  const soy = allocated.find((item) => item.nameZh === '酱油');
  assert.ok((beef?.grams ?? 0) > 140);
  assert.ok((soy?.grams ?? 0) <= 12);
});

test('maps a Google Food point into per-serving macros', () => {
  const hit = mapFoodHit({
    name: 'users/me/dataTypes/food/dataPoints/beef-1',
    food: {
      displayName: 'Beef, cooked',
      energyAvg: { kcal: 250 },
      totalCarbohydrate: { grams: 0 },
      totalFat: { grams: 15 },
      nutrients: [{ nutrient: 'PROTEIN', quantity: { grams: 26 } }],
      defaultServing: { amount: 100, foodMeasurementUnitDisplayName: 'gram' },
    },
  });
  assert.equal(hit?.displayName, 'Beef, cooked');
  assert.equal(hit?.proteinGrams, 26);
  assert.equal(hit?.servingGrams, 100);
});

test('keeps vitamins and minerals from the catalog nutrients list', () => {
  const hit = mapFoodHit({
    name: 'users/me/dataTypes/food/dataPoints/broccoli-1',
    food: {
      displayName: '西兰花',
      energyAvg: { kcal: 34 },
      totalCarbohydrate: { grams: 6.64 },
      totalFat: { grams: 0.37 },
      nutrients: [
        { nutrient: 'PROTEIN', quantity: { grams: 2.82 } },
        { nutrient: 'VITAMIN_C', quantity: { grams: 0.0894 } },
        { nutrient: 'VITAMIN_A', quantity: { grams: 0.00018 } },
        { nutrient: 'CALCIUM', quantity: { grams: 0.05 } },
        { nutrient: 'DIETARY_FIBER', quantity: { grams: 2.6 } },
      ],
      defaultServing: { amount: 100, foodMeasurementUnitDisplayName: '克' },
    },
  });
  assert.equal(hit?.nutrients.VITAMIN_C, 0.0894);
  assert.equal(hit?.nutrients.VITAMIN_A, 0.00018);
  assert.equal(hit?.nutrients.CALCIUM, 0.05);
  assert.equal(hit?.nutrients.DIETARY_FIBER, 2.6);
});

test('picks the catalog hit whose display name best matches the query', () => {
  const best = pickBestHit('beef', [
    { name: 'a', displayName: 'Chicken breast', energyKcal: 1, carbGrams: 0, fatGrams: 0, proteinGrams: 1, servingGrams: 100, nutrients: {} },
    { name: 'b', displayName: 'Beef, cooked, braised', energyKcal: 250, carbGrams: 0, fatGrams: 15, proteinGrams: 26, servingGrams: 100, nutrients: {} },
    { name: 'c', displayName: 'Beef broth', energyKcal: 10, carbGrams: 1, fatGrams: 0, proteinGrams: 1, servingGrams: 100, nutrients: {} },
  ]);
  assert.equal(best?.displayName, 'Beef, cooked, braised');
});

test('prefers plain garlic over garlic roll', () => {
  const best = pickBestHit('garlic', [
    { name: 'roll', displayName: 'Garlic Roll', energyKcal: 90, carbGrams: 15, fatGrams: 2, proteinGrams: 3, servingGrams: 30, nutrients: {} },
    { name: 'plain', displayName: 'Garlic', energyKcal: 4, carbGrams: 1, fatGrams: 0, proteinGrams: 0.2, servingGrams: 3, nutrients: {} },
  ]);
  assert.equal(best?.displayName, 'Garlic');
});

test('does not treat vanilla yogurt as a match for 香草', () => {
  const best = pickBestHit('香草', [
    {
      name: 'yogurt',
      displayName: '香草，柠檬或咖啡口味酸奶（脱脂）',
      energyKcal: 90,
      carbGrams: 17,
      fatGrams: 0,
      proteinGrams: 5,
      servingGrams: 170,
      nutrients: {},
    },
  ]);
  assert.equal(best, undefined);
});

test('does not treat 油桃 as a match for 油', () => {
  const best = pickBestHit('油', [
    { name: 'nectarine', displayName: '油桃', energyKcal: 60, carbGrams: 14, fatGrams: 0.4, proteinGrams: 1.4, servingGrams: 140, nutrients: {} },
    { name: 'avocado', displayName: '牛油果', energyKcal: 160, carbGrams: 9, fatGrams: 15, proteinGrams: 2, servingGrams: 100, nutrients: {} },
  ]);
  assert.equal(best, undefined);
});

test('uses 克 as grams and ignores the Fitbit multiplier', () => {
  const hit = mapFoodHit({
    name: 'users/me/dataTypes/food/dataPoints/beef-zh',
    food: {
      displayName: '牛肉',
      energyAvg: { kcal: 288 },
      totalCarbohydrate: { grams: 0 },
      totalFat: { grams: 19.54 },
      nutrients: [{ nutrient: 'PROTEIN', quantity: { grams: 26.33 } }],
      defaultServing: {
        amount: 100,
        foodMeasurementUnitDisplayName: '克',
        multiplier: 0.010168650320598058,
      },
    },
  });
  assert.equal(hit?.servingGrams, 100);
});

test('converts a tablespoon default serving using a 克 serving', () => {
  const hit = mapFoodHit({
    name: 'users/me/dataTypes/food/dataPoints/soy',
    food: {
      displayName: '酱油',
      energyAvg: { kcal: 8 },
      totalCarbohydrate: { grams: 1.22 },
      totalFat: { grams: 0.01 },
      nutrients: [{ nutrient: 'PROTEIN', quantity: { grams: 1 } }],
      defaultServing: {
        amount: 1,
        foodMeasurementUnitDisplayName: '餐匙/汤匙',
        multiplier: 1,
      },
      servings: [
        { amount: 1, foodMeasurementUnitDisplayName: '餐匙/汤匙', multiplier: 1 },
        { amount: 100, foodMeasurementUnitDisplayName: '克', multiplier: 6.25 },
      ],
    },
  });
  assert.equal(hit?.servingGrams, 16);
});

test('treats cilantro as a seasoning instead of half the dish', () => {
  const allocated = allocateIngredientGrams(['牛肉', '香菜'], 125);
  const herb = allocated.find((item) => item.nameZh === '香菜');
  assert.ok((herb?.grams ?? 0) <= 5);
});

test('resolves each ingredient against the catalog and scales to grams', async () => {
  const resolved = await resolveDishIngredients(
    {
      nameZh: '酱牛肉',
      ingredients: ['牛肉', '酱油'],
      portionGrams: { min: 150, max: 200 },
      visibleFraction: 'full',
      confidence: 0.7,
      needsConfirmation: ['酱汁量'],
    },
    {
      async search(query) {
        if (query.includes('牛肉') || query.toLowerCase().includes('beef')) {
          return [
            {
              name: 'foods/beef',
              displayName: 'Beef, cooked',
              energyKcal: 250,
              carbGrams: 0,
              fatGrams: 15,
              proteinGrams: 26,
              servingGrams: 100,
              nutrients: { PROTEIN: 26 },
            },
          ];
        }
        return [];
      },
    },
  );
  assert.equal(resolved.dishNameZh, '酱牛肉');
  assert.equal(resolved.ingredients.length, 2);
  const beef = resolved.ingredients.find((item) => item.nameZh === '牛肉');
  assert.equal(beef?.matchedDisplayName, 'Beef, cooked');
  assert.ok((beef?.energyKcal ?? 0) > 200);
  assert.ok((resolved.totals.energyKcal ?? 0) > 200);
});

test('scales vitamins to ingredient grams and sums them on the dish', async () => {
  const resolved = await resolveDishIngredients(
    {
      nameZh: '西兰花',
      ingredients: ['西兰花'],
      portionGrams: 50,
      visibleFraction: 'full',
      confidence: 0.9,
      needsConfirmation: [],
    },
    {
      async search() {
        return [
          {
            name: 'foods/broccoli',
            displayName: '西兰花',
            energyKcal: 34,
            carbGrams: 6.64,
            fatGrams: 0.37,
            proteinGrams: 2.82,
            servingGrams: 100,
            nutrients: { VITAMIN_C: 0.0894, VITAMIN_A: 0.00018, PROTEIN: 2.82 },
          },
        ];
      },
    },
  );
  const vitaminC = resolved.ingredients[0]?.nutrients.VITAMIN_C ?? 0;
  assert.ok(Math.abs(vitaminC - 0.0447) < 1e-9);
  assert.ok(Math.abs((resolved.totals.nutrients.VITAMIN_C ?? 0) - 0.0447) < 1e-9);
});
