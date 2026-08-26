import assert from 'node:assert/strict';
import test from 'node:test';

import type { VisionMeal } from '../../src/domain/meal-vision';
import { createMemoryStore } from '../../src/server/db/memory-store';

const now = new Date('2026-08-26T12:00:00.000Z');

function rangeVision(): VisionMeal {
  return {
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
    globalUncertainties: [],
  };
}

function readyVision(): VisionMeal {
  return {
    foods: [
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
    ],
    photoQuality: 'usable',
    globalUncertainties: [],
  };
}

test('confirm fails closed when a kept dish is still a range', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  const draft = await store.meals.insertDraft({
    userId: 'u1',
    mealType: 'LUNCH',
    eatenAt: now,
    vision: rangeVision(),
    now,
  });
  const result = await store.meals.confirmDraft({
    userId: 'u1',
    draftId: draft.id,
    writebackThisMeal: true,
    canWriteNutrition: true,
    connectionSyncable: true,
    now,
  });
  assert.equal(result.ok, false);
  assert.equal((await store.meals.listVersions('u1')).length, 0);
});

test('confirm creates one dish and outbox row per ready dish when writeback is on', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.users.setNutritionWritebackEnabled('u1', true);
  const draft = await store.meals.insertDraft({
    userId: 'u1',
    mealType: 'LUNCH',
    eatenAt: now,
    vision: readyVision(),
    now,
  });
  const result = await store.meals.confirmDraft({
    userId: 'u1',
    draftId: draft.id,
    writebackThisMeal: true,
    canWriteNutrition: true,
    connectionSyncable: true,
    now,
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.dishes.length, 2);
  assert.equal(result.outbox.length, 2);
  assert.ok(result.outbox.every((row) => row.status === 'write_pending'));
  assert.ok(result.outbox.every((row) => row.dataPointName.startsWith('users/me/dataTypes/nutrition-log/dataPoints/d-')));
  assert.equal((await store.meals.findDraft('u1', draft.id)), undefined);
});

test('confirm stores local_only outbox when writeback is off', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  const draft = await store.meals.insertDraft({
    userId: 'u1',
    mealType: 'LUNCH',
    eatenAt: now,
    vision: readyVision(),
    now,
  });
  const result = await store.meals.confirmDraft({
    userId: 'u1',
    draftId: draft.id,
    writebackThisMeal: true,
    canWriteNutrition: true,
    connectionSyncable: true,
    now,
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.ok(result.outbox.every((row) => row.status === 'local_only'));
});
