import assert from 'node:assert/strict';
import test from 'node:test';

import { dishesReadyToConfirm, parseVisionMeal } from '../../src/domain/meal-confirm';

const visionPayload = {
  foods: [
    {
      nameZh: '番茄炒蛋',
      ingredients: ['鸡蛋', '番茄', '食用油'],
      portionGrams: { min: 140, max: 220 },
      visibleFraction: 'partial',
      confidence: 0.72,
      needsConfirmation: ['油量', '实际食用比例'],
    },
    {
      nameZh: '米饭',
      ingredients: ['稻米'],
      portionGrams: { min: 150, max: 250 },
      visibleFraction: 'full',
      confidence: 0.8,
      needsConfirmation: [],
    },
  ],
  photoQuality: 'usable',
  globalUncertainties: ['共享菜无法判断实际食用比例'],
};

test('parses a one-photo multi-dish vision payload', () => {
  const parsed = parseVisionMeal(visionPayload);
  assert.equal(parsed.foods.length, 2);
  assert.equal(parsed.foods[0]?.nameZh, '番茄炒蛋');
  assert.deepEqual(parsed.foods[0]?.portionGrams, { min: 140, max: 220 });
});

test('rejects confirm when a kept dish still has a portion range or open questions', () => {
  const parsed = parseVisionMeal(visionPayload);
  const result = dishesReadyToConfirm(parsed.foods);
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.match(result.reason, /点值|确认/);
});

test('accepts confirm when every kept dish has point grams and no open questions', () => {
  const result = dishesReadyToConfirm([
    {
      nameZh: '番茄炒蛋',
      ingredients: ['鸡蛋', '番茄', '食用油'],
      portionGrams: 180,
      visibleFraction: 'partial',
      confidence: 0.72,
      needsConfirmation: [],
      eatFraction: 1,
    },
    {
      nameZh: '米饭',
      ingredients: ['稻米'],
      portionGrams: 200,
      visibleFraction: 'full',
      confidence: 0.8,
      needsConfirmation: [],
      eatFraction: 1,
    },
  ]);
  assert.equal(result.ok, true);
});

test('rejects confirm when needsConfirmation is still non-empty even with point grams', () => {
  const result = dishesReadyToConfirm([
    {
      nameZh: '番茄炒蛋',
      ingredients: ['鸡蛋', '番茄'],
      portionGrams: 180,
      visibleFraction: 'partial',
      confidence: 0.7,
      needsConfirmation: ['实际食用比例'],
      eatFraction: 1,
    },
  ]);
  assert.equal(result.ok, false);
});
