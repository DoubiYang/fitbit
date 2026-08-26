import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { recognizeMealPhoto } from '../../src/server/meals/deepseek-vision';
import { ingestMealPhoto } from '../../src/server/meals/photo-ingest';

test('recognizeMealPhoto parses a mocked model json payload', async () => {
  const jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const meal = await recognizeMealPhoto(await ingestMealPhoto(jpeg), 'test-key', {
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
