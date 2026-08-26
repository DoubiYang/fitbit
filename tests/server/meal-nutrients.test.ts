import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryStore } from '../../src/server/db/memory-store';
import { factsFromResolvedDish } from '../../src/server/meals/meal-nutrients';
import type { ResolvedDish } from '../../src/server/meals/ingredient-nutrition';
import type { VisionMeal } from '../../src/domain/meal-vision';

const now = new Date('2026-08-26T12:00:00.000Z');

function broccoliResolved(): ResolvedDish {
  return {
    dishNameZh: '西兰花',
    dishGrams: 50,
    needsConfirmation: [],
    ingredients: [
      {
        nameZh: '西兰花',
        grams: 50,
        matchedDisplayName: '西兰花',
        foodName: 'users/me/dataTypes/food/dataPoints/broccoli-1',
        energyKcal: 17,
        proteinGrams: 1.41,
        carbGrams: 3.32,
        fatGrams: 0.185,
        nutrients: {
          PROTEIN: 1.41,
          VITAMIN_C: 0.0447,
          VITAMIN_A: 0.00009,
          CALCIUM: 0.025,
          DIETARY_FIBER: 1.3,
        },
      },
    ],
    totals: {
      energyKcal: 17,
      proteinGrams: 1.41,
      carbGrams: 3.32,
      fatGrams: 0.185,
      nutrients: {
        PROTEIN: 1.41,
        VITAMIN_C: 0.0447,
        VITAMIN_A: 0.00009,
        CALCIUM: 0.025,
        DIETARY_FIBER: 1.3,
      },
    },
  };
}

test('records energy, macros and micronutrients from a resolved dish', () => {
  const facts = factsFromResolvedDish({
    dishId: 'dish-1',
    userId: 'u1',
    source: 'user_confirmed',
    visionConfidence: 0.9,
    resolved: broccoliResolved(),
  });
  const byCode = Object.fromEntries(facts.nutrients.map((row) => [row.nutrientCode, row]));
  assert.equal(byCode.ENERGY?.kcal, 17);
  assert.equal(byCode.ENERGY?.grams, undefined);
  assert.equal(byCode.FAT?.grams, 0.185);
  assert.equal(byCode.CARBOHYDRATES?.grams, 3.32);
  assert.equal(byCode.PROTEIN?.grams, 1.41);
  assert.equal(byCode.VITAMIN_C?.grams, 0.0447);
  assert.equal(byCode.VITAMIN_A?.grams, 0.00009);
  assert.equal(byCode.CALCIUM?.grams, 0.025);
  assert.equal(byCode.DIETARY_FIBER?.grams, 1.3);
  assert.equal(facts.ingredients.length, 1);
  assert.equal(facts.ingredients[0]?.foodName, '西兰花');
  assert.equal(facts.ingredients[0]?.foodSource, 'google_health_food');
  assert.equal(facts.ingredients[0]?.foodSourceId, 'users/me/dataTypes/food/dataPoints/broccoli-1');
  assert.equal(facts.ingredients[0]?.grams, 50);
  assert.equal(byCode.VITAMIN_C?.confidence, 0.9);
});

test('confirm persists micronutrients and can read them back', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  const vision: VisionMeal = {
    foods: [
      {
        nameZh: '西兰花',
        ingredients: ['西兰花'],
        portionGrams: 50,
        visibleFraction: 'full',
        confidence: 0.9,
        needsConfirmation: [],
        eatFraction: 1,
      },
    ],
    photoQuality: 'usable',
    globalUncertainties: [],
  };
  const draft = await store.meals.insertDraft({
    userId: 'u1',
    mealType: 'LUNCH',
    eatenAt: now,
    vision,
    now,
  });
  const result = await store.meals.confirmDraft({
    userId: 'u1',
    draftId: draft.id,
    writebackThisMeal: false,
    canWriteNutrition: false,
    connectionSyncable: false,
    now,
    catalog: {
      async search(query) {
        if (query !== '西兰花') {
          return [];
        }
        return [
          {
            name: 'users/me/dataTypes/food/dataPoints/broccoli-1',
            displayName: '西兰花',
            energyKcal: 34,
            carbGrams: 6.64,
            fatGrams: 0.37,
            proteinGrams: 2.82,
            servingGrams: 100,
            nutrients: {
              PROTEIN: 2.82,
              VITAMIN_C: 0.0894,
              CALCIUM: 0.05,
            },
          },
        ];
      },
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  const nutrients = await store.meals.listNutrients(result.version.userId, result.version.id);
  const byCode = Object.fromEntries(nutrients.map((row) => [row.nutrientCode, row]));
  assert.ok((byCode.VITAMIN_C?.grams ?? 0) > 0.04);
  assert.ok((byCode.CALCIUM?.grams ?? 0) > 0.02);
  assert.ok((byCode.ENERGY?.kcal ?? 0) > 10);
  const ingredients = await store.meals.listIngredients(result.version.userId, result.version.id);
  assert.equal(ingredients.length, 1);
  assert.equal(ingredients[0]?.foodName, '西兰花');
});
