import assert from 'node:assert/strict';
import test from 'node:test';

import type { VisionMeal } from '../../src/domain/meal-vision';
import { createMemoryStore } from '../../src/server/db/memory-store';
import {
  GoogleNutritionWriteError,
  runNutritionOutbox,
  type GoogleNutritionOutboxClient,
} from '../../src/server/meals/nutrition-outbox';
import type { TwFdaFoodCatalog } from '../../src/server/nutrition/tw-fda';

const now = new Date('2026-08-26T12:00:00.000Z');

const catalog: TwFdaFoodCatalog = {
  async findExact(nameZh) {
    return {
      sourceRevision: 'tw-fda-test-sha',
      officialFoodId: `food-${nameZh}`,
      nameZh,
      aliases: [],
      nutrients: [
        { officialName: '熱量', rawUnit: 'kcal', per100gValue: 100 },
        { officialName: '粗蛋白', rawUnit: 'g', per100gValue: 4 },
        { officialName: '維生素C', rawUnit: 'mg', per100gValue: 20 },
      ],
    };
  },
};

async function pendingOutbox() {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.users.setNutritionWritebackEnabled('u1', true);
  const vision: VisionMeal = {
    foods: [
      {
        nameZh: '西兰花',
        ingredients: ['西兰花'],
        portionGrams: 100,
        visibleFraction: 'full',
        confidence: 0.9,
        needsConfirmation: [],
        eatFraction: 1,
      },
    ],
    photoQuality: 'usable',
    globalUncertainties: [],
  };
  const draft = await store.meals.insertDraft({ userId: 'u1', mealType: 'LUNCH', eatenAt: now, vision, now });
  const confirmed = await store.meals.confirmDraft({
    userId: 'u1',
    draftId: draft.id,
    writebackThisMeal: true,
    canWriteNutrition: true,
    connectionSyncable: true,
    catalog,
    now,
  });
  assert.equal(confirmed.ok, true);
  if (!confirmed.ok) {
    throw new Error('expected confirmed meal');
  }
  return { store, outboxId: confirmed.outbox[0]!.id };
}

function client(overrides: Partial<GoogleNutritionOutboxClient> = {}): GoogleNutritionOutboxClient {
  return {
    async create() { return { done: true }; },
    async getDataPoint() { return undefined; },
    async getOperation() { return { done: false }; },
    ...overrides,
  };
}

test('claims one due outbox row, creates one Google data point and marks it synced', async () => {
  const pending = await pendingOutbox();
  let creates = 0;
  const result = await runNutritionOutbox({
    store: pending.store,
    now,
    tokenForUser: async () => 'access-token',
    google: client({ async create() { creates += 1; return { done: true }; } }),
  });

  assert.deepEqual(result, { claimed: 1, succeeded: 1, failed: 0, retrying: 0, unknown: 0 });
  assert.equal(creates, 1);
  assert.equal(pending.store.outboxRows().find((row) => row.id === pending.outboxId)?.status, 'synced');
});

test('marks a 401 or 403 as action-required without retrying', async () => {
  const pending = await pendingOutbox();
  const result = await runNutritionOutbox({
    store: pending.store,
    now,
    tokenForUser: async () => 'access-token',
    google: client({ async create() { throw new GoogleNutritionWriteError(401); } }),
  });

  assert.equal(result.failed, 1);
  assert.equal(pending.store.outboxRows().find((row) => row.id === pending.outboxId)?.status, 'failed_action_required');
});

test('does not mark a completed Google operation with an error as synced', async () => {
  const pending = await pendingOutbox();
  const result = await runNutritionOutbox({
    store: pending.store,
    now,
    tokenForUser: async () => 'access-token',
    google: client({ async create() { return { done: true, error: { code: 13 } }; } }),
  });

  assert.equal(result.unknown, 1);
  assert.equal(pending.store.outboxRows().find((row) => row.id === pending.outboxId)?.status, 'unknown');
});

test('schedules a 5xx create failure for retry', async () => {
  const pending = await pendingOutbox();
  const result = await runNutritionOutbox({
    store: pending.store,
    now,
    tokenForUser: async () => 'access-token',
    google: client({ async create() { throw new GoogleNutritionWriteError(503); } }),
  });

  assert.equal(result.retrying, 1);
  const row = pending.store.outboxRows().find((item) => item.id === pending.outboxId);
  assert.equal(row?.status, 'retrying');
  assert.equal(row?.nextAttemptAt?.toISOString(), '2026-08-26T12:01:00.000Z');
});

test('marks an indeterminate create unknown when exact-name recovery finds no data point', async () => {
  const pending = await pendingOutbox();
  const result = await runNutritionOutbox({
    store: pending.store,
    now,
    tokenForUser: async () => 'access-token',
    google: client({ async create() { throw new Error('network timeout'); } }),
  });

  assert.equal(result.unknown, 1);
  assert.equal(pending.store.outboxRows().find((row) => row.id === pending.outboxId)?.status, 'unknown');
});

test('times out a hung create before its lease can expire, reconciles once, and never recreates it', async () => {
  const pending = await pendingOutbox();
  let creates = 0;
  let recoveries = 0;
  const google = client({
    async create() {
      creates += 1;
      return new Promise(() => undefined);
    },
    async getDataPoint() {
      recoveries += 1;
      return undefined;
    },
  });

  const first = await runNutritionOutbox({
    store: pending.store,
    now,
    tokenForUser: async () => 'access-token',
    google,
    requestTimeoutMs: 5,
  });
  const second = await runNutritionOutbox({
    store: pending.store,
    now,
    tokenForUser: async () => 'access-token',
    google,
    requestTimeoutMs: 5,
  });

  assert.equal(first.unknown, 1);
  assert.equal(second.claimed, 0);
  assert.equal(creates, 1);
  assert.equal(recoveries, 1);
  const row = pending.store.outboxRows().find((item) => item.id === pending.outboxId);
  assert.equal(row?.status, 'unknown');
  assert.equal(row?.lastErrorCode, 'request_timeout');
});
