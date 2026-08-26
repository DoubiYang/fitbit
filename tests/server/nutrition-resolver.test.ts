import assert from 'node:assert/strict';
import test from 'node:test';

import { estimateDish, finalizeDish } from '../../src/server/meals/nutrition-resolver';

test('estimate omits kcal when eat fraction still needs confirmation', () => {
  const estimated = estimateDish({
    nameZh: '番茄炒蛋',
    ingredients: ['鸡蛋', '番茄', '食用油'],
    portionGrams: { min: 140, max: 220 },
    visibleFraction: 'partial',
    confidence: 0.72,
    needsConfirmation: ['实际食用比例'],
  });
  assert.equal(estimated.energyKcal, undefined);
  assert.equal(estimated.reason, 'needs_confirmation');
});

test('finalize uses confirmed grams and ignores a claimed vision calorie number', () => {
  const finalized = finalizeDish(
    {
      nameZh: '米饭',
      ingredients: ['稻米'],
      portionGrams: 200,
      visibleFraction: 'full',
      confidence: 0.8,
      needsConfirmation: [],
      eatFraction: 1,
    },
    { claimedEnergyKcal: 9999 },
  );
  assert.ok(finalized.energyKcal !== undefined);
  assert.notEqual(finalized.energyKcal, 9999);
  assert.ok((finalized.energyKcal ?? 0) > 100);
  assert.ok(finalized.nutrients.some((item) => item.code === 'CARBOHYDRATES' && (item.grams ?? 0) > 0));
});
