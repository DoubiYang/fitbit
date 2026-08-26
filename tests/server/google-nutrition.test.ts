import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGoogleNutritionDataPoint, canonicalNutritionHash } from '../../src/server/meals/google-nutrition';
import type { MealDishRow, MealNutrientRow, MealVersionRow } from '../../src/server/meals/types';

const dish: MealDishRow = {
  id: 'dish-1',
  versionId: 'version-1',
  userId: 'u1',
  clientShortId: 'd-550e8400-e29b-41d4-a716-446655440000',
  nameZh: '番茄炒蛋',
  portionGrams: 180,
  source: 'user_confirmed',
};

const version: MealVersionRow = {
  id: 'version-1',
  userId: 'u1',
  previousVersionId: undefined,
  mealType: 'LUNCH',
  eatenAt: new Date('2026-08-26T04:00:00.000Z'),
  writebackThisMeal: true,
  confirmedAt: new Date('2026-08-26T04:10:00.000Z'),
};

function nutrient(nutrientCode: string, grams: number | undefined, kcal?: number): MealNutrientRow {
  return { dishId: dish.id, userId: dish.userId, nutrientCode, grams, kcal, source: 'user_confirmed', confidence: 0.8 };
}

test('projects every known Google-supported nutrient and excludes local extensions', () => {
  const built = buildGoogleNutritionDataPoint({
    dish,
    version,
    nutrients: [
      nutrient('ENERGY', undefined, 220),
      nutrient('FAT', 14),
      nutrient('CARBOHYDRATES', 8),
      nutrient('PROTEIN', 12),
      nutrient('VITAMIN_C', 0.044),
      nutrient('VITAMIN_A', 0.0002),
      nutrient('CALCIUM', 0.1),
      nutrient('DIETARY_FIBER', 3),
      nutrient('OMEGA_3', 0.5),
      nutrient('CHOLINE', 0.2),
    ],
  });
  assert.ok(built);
  if (!built) {
    return;
  }
  assert.equal(built.dataPoint.name, `users/me/dataTypes/nutrition-log/dataPoints/${dish.clientShortId}`);
  const log = built.dataPoint.nutritionLog;
  assert.equal(log.foodDisplayName, '番茄炒蛋');
  assert.equal(log.mealType, 'LUNCH');
  assert.equal(log.energy?.kcal, 220);
  assert.equal(log.energyFromFat?.kcal, 126);
  assert.equal(log.totalCarbohydrate?.grams, 8);
  assert.equal(log.totalFat?.grams, 14);
  assert.equal('food' in log, false);
  const byCode = Object.fromEntries((log.nutrients ?? []).map((item) => [item.nutrient, item.quantity]));
  assert.equal(byCode.PROTEIN?.grams, 12);
  assert.equal(byCode.VITAMIN_C?.grams, 0.044);
  assert.equal(byCode.VITAMIN_C?.userProvidedUnit, 'MILLIGRAM');
  assert.equal(byCode.VITAMIN_A?.userProvidedUnit, 'MICROGRAM');
  assert.equal(byCode.CALCIUM?.userProvidedUnit, 'MILLIGRAM');
  assert.equal(byCode.DIETARY_FIBER?.grams, 3);
  assert.equal(byCode.CARBOHYDRATES, undefined);
  assert.equal(byCode.FAT, undefined);
  assert.equal(byCode.OMEGA_3, undefined);
  assert.equal(byCode.CHOLINE, undefined);
  assert.equal(canonicalNutritionHash(log), built.payloadHash);
});

test('does not build an empty anonymous nutrition log', () => {
  const built = buildGoogleNutritionDataPoint({ dish, version, nutrients: [] });
  assert.equal(built, undefined);
});
