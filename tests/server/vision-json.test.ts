import assert from 'node:assert/strict';
import test from 'node:test';

import { parseVisionMeal } from '../../src/domain/meal-vision';
import { extractJsonObject } from '../../src/server/meals/extract-json';

test('extracts a json object from markdown fences', () => {
  const extracted = extractJsonObject('```json\n{"foods":[],"photoQuality":"usable","globalUncertainties":[]}\n```');
  assert.deepEqual(extracted, { foods: [], photoQuality: 'usable', globalUncertainties: [] });
});

test('parses model json into vision meal after fence strip', () => {
  const raw = JSON.stringify({
    foods: [
      {
        nameZh: '米饭',
        ingredients: ['稻米'],
        portionGrams: { min: 150, max: 220 },
        visibleFraction: 'full',
        confidence: 0.8,
        needsConfirmation: [],
      },
    ],
    photoQuality: 'usable',
    globalUncertainties: [],
  });
  const meal = parseVisionMeal(extractJsonObject(`here\n\`\`\`json\n${raw}\n\`\`\``));
  assert.equal(meal.foods[0]?.nameZh, '米饭');
});
