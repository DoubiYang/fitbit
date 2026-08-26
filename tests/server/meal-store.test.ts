import assert from 'node:assert/strict';
import test from 'node:test';

import type { VisionMeal } from '../../src/domain/meal-vision';
import { createMemoryStore } from '../../src/server/db/memory-store';
import type { TwFdaFoodCatalog } from '../../src/server/nutrition/tw-fda';

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

function resolvedCatalog(): TwFdaFoodCatalog {
  return {
    async findExact(nameZh) {
      return {
        sourceRevision: 'tw-fda-test-sha',
        officialFoodId: `test-${nameZh}`,
        nameZh,
        aliases: [],
        nutrients: [
          { officialName: '熱量', rawUnit: 'kcal', per100gValue: 100 },
          { officialName: '粗蛋白', rawUnit: 'g', per100gValue: 4 },
          { officialName: '總碳水化合物', rawUnit: 'g', per100gValue: 20 },
          { officialName: '粗脂肪', rawUnit: 'g', per100gValue: 2 },
          { officialName: '維生素C', rawUnit: 'mg', per100gValue: 20 },
        ],
      };
    },
  };
}

function localCatalog(): TwFdaFoodCatalog {
  return {
    async findExact(nameZh) {
      return {
        sourceRevision: 'tw-fda-test-sha',
        officialFoodId: `test-${nameZh}`,
        nameZh,
        aliases: [],
        nutrients: [
          { officialName: '熱量', rawUnit: 'kcal', per100gValue: 100 },
          { officialName: '粗蛋白', rawUnit: 'g', per100gValue: 4 },
          { officialName: '總碳水化合物', rawUnit: 'g', per100gValue: 20 },
          { officialName: '粗脂肪', rawUnit: 'g', per100gValue: 2 },
          { officialName: '維生素C', rawUnit: 'mg', per100gValue: 20 },
        ],
      };
    },
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
    catalog: resolvedCatalog(),
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.dishes.length, 2);
  assert.equal(result.outbox.length, 2);
  assert.ok(result.outbox.every((row) => row.status === 'write_pending'));
  assert.ok(result.outbox.every((row) => row.dataPointName.startsWith('users/me/dataTypes/nutrition-log/dataPoints/d-')));
  const nutrientCodes = result.outbox[0]?.payload?.nutritionLog.nutrients?.map((item) => item.nutrient);
  assert.ok(nutrientCodes?.includes('VITAMIN_C'));
  assert.ok(result.outbox.every((row) => row.payloadHash));
  assert.equal((await store.meals.findDraft('u1', draft.id)), undefined);
});

test('confirm keeps an unresolved dish local-only even when writeback is enabled', async () => {
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
  assert.equal(result.nutrients.length, 0);
  assert.ok(result.outbox.every((row) => row.status === 'local_only'));
  assert.ok(result.outbox.every((row) => row.payload === undefined));
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

test('confirm uses local Taiwan FDA facts without requiring an OAuth connection', async () => {
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
    writebackThisMeal: false,
    canWriteNutrition: false,
    connectionSyncable: false,
    catalog: localCatalog(),
    now,
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.ok(result.nutrients.some((row) => row.nutrientCode === 'VITAMIN_C'));
  assert.ok(result.ingredients.every((row) => row.foodSource === 'tw_fda'));
  assert.ok(result.ingredients.every((row) => row.foodSourceVersion === 'tw-fda-test-sha'));
});
