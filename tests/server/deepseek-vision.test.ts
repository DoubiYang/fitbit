import assert from 'node:assert/strict';
import test from 'node:test';

import { recognizeMealPhoto } from '../../src/server/meals/deepseek-vision';
import { ingestMealPhoto } from '../../src/server/meals/photo-ingest';

test('recognizeMealPhoto parses a mocked model json payload', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const meal = await recognizeMealPhoto(ingestMealPhoto(jpeg), 'test-key', {
    async complete() {
      return JSON.stringify({
        foods: [
          {
            nameZh: '牛肉',
            ingredients: ['牛肉'],
            portionGrams: { min: 80, max: 140 },
            visibleFraction: 'full',
            confidence: 0.7,
            needsConfirmation: ['油量'],
          },
        ],
        photoQuality: 'usable',
        globalUncertainties: [],
      });
    },
  });
  assert.equal(meal.foods[0]?.nameZh, '牛肉');
});
