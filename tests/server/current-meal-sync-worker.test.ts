import assert from 'node:assert/strict';
import test from 'node:test';

import type { EditableMealDraft } from '../../src/domain/meal-editor';
import type { MealSyncPointClaim } from '../../src/server/auth/types';
import { createMemoryStore } from '../../src/server/db/memory-store';
import { runCurrentMealSyncOutbox } from '../../src/server/meals/current-meal-sync';
import { GoogleNutritionWriteError, type GoogleNutritionOutboxClient } from '../../src/server/meals/nutrition-outbox';

const now = new Date('2026-08-27T08:00:00.000Z');

function editor(mealId = 'meal-1'): EditableMealDraft {
  return {
    view: 'draft',
    mealId,
    mealType: 'LUNCH',
    eatenAt: now.toISOString(),
    dishes: [{
      id: 'dish-1',
      nameZh: '鸡肉饭',
      portionGrams: 150,
      ingredients: [{
        nameZh: '鸡肉',
        grams: 150,
        foodSource: 'tw_fda',
        foodSourceId: 'V0100101',
        foodSourceVersion: 'fda-test',
      }],
    }],
    nutrients: [
      { dishId: 'dish-1', nutrientCode: 'ENERGY', value: 300, unit: 'kcal', source: 'tw_fda' },
      { dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 25, unit: 'g', source: 'tw_fda' },
    ],
  };
}

async function savedMeal() {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.currentMeals.insertEditorDraft({
    id: 'meal-1', userId: 'u1', mealType: 'LUNCH', eatenAt: now,
    vision: { foods: [], photoQuality: 'unusable', globalUncertainties: [] }, editor: editor(), now,
  });
  await store.currentMeals.saveEditorDraft({ userId: 'u1', draftId: 'meal-1', now });
  return store;
}

async function savedMealWithTwoCreates() {
  const store = createMemoryStore();
  const twoDishes = editor();
  twoDishes.dishes.push({
    id: 'dish-2',
    nameZh: '豆腐',
    portionGrams: 80,
    ingredients: [{
      nameZh: '豆腐', grams: 80, foodSource: 'tw_fda', foodSourceId: 'V0200202', foodSourceVersion: 'fda-test',
    }],
  });
  twoDishes.nutrients.push({ dishId: 'dish-2', nutrientCode: 'ENERGY', value: 60, unit: 'kcal', source: 'tw_fda' });
  await store.users.insert('u1');
  await store.currentMeals.insertEditorDraft({
    id: 'meal-1', userId: 'u1', mealType: 'LUNCH', eatenAt: now,
    vision: { foods: [], photoQuality: 'unusable', globalUncertainties: [] }, editor: twoDishes, now,
  });
  await store.currentMeals.saveEditorDraft({ userId: 'u1', draftId: 'meal-1', now });
  return store;
}

function completedGoogle(overrides: Partial<GoogleNutritionOutboxClient> = {}): GoogleNutritionOutboxClient {
  return {
    create: async () => ({ done: true }),
    batchDelete: async () => ({ done: true }),
    getDataPoint: async () => undefined,
    getOperation: async () => ({ done: true }),
    ...overrides,
  };
}

test('worker executes a frozen create point and finalizes the current meal generation', async () => {
  const store = await savedMeal();
  await store.mealSync!.startGeneration({ mealId: 'meal-1', userId: 'u1', now });
  const creates: string[] = [];

  const result = await runCurrentMealSyncOutbox({
    store,
    now,
    tokenForUser: async () => 'token',
    google: completedGoogle({ create: async (_token, payload) => {
      creates.push(payload.name);
      return { done: true };
    } }),
  });

  assert.deepEqual(result, { claimed: 1, succeeded: 1, failed: 0, retrying: 0, unknown: 0 });
  assert.equal(creates.length, 1);
  assert.equal(store.mealSyncPoints()[0]?.status, 'synced');
  assert.equal((await store.currentMeals.findCurrentMeal('u1', 'meal-1'))?.syncState, 'synced');
});

test('an in-flight create keeps its lease after the original lease window passes', async () => {
  const store = await savedMeal();
  await store.mealSync!.startGeneration({ mealId: 'meal-1', userId: 'u1', now });
  const names: string[] = [];
  let releaseCreate: (() => void) | undefined;
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  const google = completedGoogle({
    create: async (_token, payload) => {
      names.push(payload.name);
      if (names.length === 1) {
        notifyStarted();
        return new Promise((resolve) => { releaseCreate = () => resolve({ done: true }); });
      }
      return { done: true };
    },
  });
  const workerOne = runCurrentMealSyncOutbox({
    store, now, limit: 20, tokenForUser: async () => 'token', google,
  });

  await started;
  const workerTwo = await runCurrentMealSyncOutbox({
    store,
    now: new Date(now.getTime() + 120_001),
    limit: 20,
    tokenForUser: async () => 'token',
    google,
  });
  releaseCreate?.();
  await workerOne;

  assert.equal(workerTwo.claimed, 0);
  assert.equal(names.length, 1);
});

test('a multi-create generation posts only one point per worker run', async () => {
  const store = await savedMealWithTwoCreates();
  await store.mealSync!.startGeneration({ mealId: 'meal-1', userId: 'u1', now });
  const names: string[] = [];

  await runCurrentMealSyncOutbox({
    store,
    now,
    limit: 20,
    tokenForUser: async () => 'token',
    google: completedGoogle({ create: async (_token, payload) => { names.push(payload.name); return { done: true }; } }),
  });

  assert.equal(names.length, 1);
  assert.equal((await store.currentMeals.findCurrentMeal('u1', 'meal-1'))?.syncState, 'syncing');
});

test('worker validates public limits and caps a batch claim before its single-point claim', async () => {
  const store = await savedMeal();
  const original = store.mealSync!;
  const claims: Array<MealSyncPointClaim & { mode?: string }> = [];
  store.mealSync = {
    ...original,
    claimDuePoints: async (input) => {
      claims.push(input);
      return [];
    },
  };
  const input = { store, now, tokenForUser: async () => 'token', google: completedGoogle() };

  await assert.rejects(() => runCurrentMealSyncOutbox({ ...input, limit: 0 }), /limit must be a positive integer/u);
  await runCurrentMealSyncOutbox({ ...input, limit: 999 });

  assert.deepEqual(claims.map((claim) => ({ limit: claim.limit, mode: claim.mode })), [
    { limit: 20, mode: 'batch_delete' },
    { limit: 1, mode: 'single' },
  ]);
});

test('worker completes all replacement deletes before it creates the new immutable payload', async () => {
  const store = await savedMeal();
  await store.mealSync!.startGeneration({ mealId: 'meal-1', userId: 'u1', now });
  await runCurrentMealSyncOutbox({ store, now, tokenForUser: async () => 'token', google: completedGoogle() });
  await store.currentMeals.setCurrentMealNutrient({
    userId: 'u1', mealId: 'meal-1', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 30, unit: 'g', now,
  });
  await store.mealSync!.startGeneration({ mealId: 'meal-1', userId: 'u1', now });
  let deletes = 0;
  let creates = 0;
  const google = completedGoogle({
    batchDelete: async (_token, names) => { deletes += 1; assert.equal(names.length, 1); return { done: true }; },
    create: async () => { creates += 1; return { done: true }; },
  });

  await runCurrentMealSyncOutbox({ store, now, tokenForUser: async () => 'token', google });
  assert.equal(deletes, 1);
  assert.equal(creates, 0);
  await runCurrentMealSyncOutbox({ store, now, tokenForUser: async () => 'token', google });
  assert.equal(creates, 1);
  assert.equal((await store.currentMeals.findCurrentMeal('u1', 'meal-1'))?.syncState, 'synced');
});

test('an unknown write is recovered only by an exact GET and never receives a duplicate POST', async () => {
  const store = await savedMeal();
  await store.mealSync!.startGeneration({ mealId: 'meal-1', userId: 'u1', now });
  let creates = 0;
  const getNames: string[] = [];
  const google = completedGoogle({
    create: async () => { creates += 1; throw new Error('connection lost after request'); },
    getDataPoint: async (_token, name) => { getNames.push(name); return undefined; },
  });

  await runCurrentMealSyncOutbox({ store, now, tokenForUser: async () => 'token', google });
  await runCurrentMealSyncOutbox({ store, now: new Date(now.getTime() + 60_000), tokenForUser: async () => 'token', google });
  assert.equal(creates, 1);
  await store.mealSync!.beginRecovery({ mealId: 'meal-1', userId: 'u1', now, reason: 'retry_this_meal' });
  await runCurrentMealSyncOutbox({ store, now, tokenForUser: async () => 'token', google });

  assert.equal(creates, 1);
  assert.deepEqual(getNames, [store.mealSyncPoints()[0]?.dataPointName]);
  assert.equal(store.mealSyncPoints()[0]?.status, 'unknown');
});

test('a failed exact-GET recovery stays unknown so it cannot replay the original create', async () => {
  const store = await savedMeal();
  await store.mealSync!.startGeneration({ mealId: 'meal-1', userId: 'u1', now });
  let creates = 0;
  const google = completedGoogle({
    create: async () => { creates += 1; throw new Error('connection lost after request'); },
    getDataPoint: async () => { throw new GoogleNutritionWriteError(503); },
  });

  await runCurrentMealSyncOutbox({ store, now, tokenForUser: async () => 'token', google });
  await store.mealSync!.beginRecovery({ mealId: 'meal-1', userId: 'u1', now, reason: 'retry_this_meal' });
  await runCurrentMealSyncOutbox({ store, now, tokenForUser: async () => 'token', google });
  await runCurrentMealSyncOutbox({ store, now: new Date(now.getTime() + 60_000), tokenForUser: async () => 'token', google });

  assert.equal(creates, 1);
  assert.equal(store.mealSyncPoints()[0]?.status, 'unknown');
});

test('a token failure while recovering an unknown write stays exact-GET-only after auth is restored', async () => {
  const store = await savedMeal();
  await store.mealSync!.startGeneration({ mealId: 'meal-1', userId: 'u1', now });
  let creates = 0;
  const initialGoogle = completedGoogle({
    create: async () => { creates += 1; throw new Error('connection lost after request'); },
  });
  await runCurrentMealSyncOutbox({ store, now, tokenForUser: async () => 'token', google: initialGoogle });
  await store.mealSync!.beginRecovery({ mealId: 'meal-1', userId: 'u1', now, reason: 'retry_this_meal' });
  await runCurrentMealSyncOutbox({
    store,
    now,
    tokenForUser: async () => { throw new Error('refresh token unavailable'); },
    google: initialGoogle,
  });
  assert.equal(store.mealSyncPoints()[0]?.status, 'unknown');

  const recoveryNames: string[] = [];
  await store.mealSync!.beginRecovery({
    mealId: 'meal-1', userId: 'u1', now: new Date(now.getTime() + 1_000), reason: 'auth_restored',
  });
  await runCurrentMealSyncOutbox({
    store,
    now: new Date(now.getTime() + 1_000),
    tokenForUser: async () => 'fresh-token',
    google: completedGoogle({ getDataPoint: async (_token, name) => { recoveryNames.push(name); return undefined; } }),
  });

  assert.equal(creates, 1);
  assert.deepEqual(recoveryNames, [store.mealSyncPoints()[0]?.dataPointName]);
  assert.equal(store.mealSyncPoints()[0]?.status, 'unknown');
});

test('a 403 exact-GET recovery stays exact-GET-only after authorization is restored', async () => {
  const store = await savedMeal();
  await store.mealSync!.startGeneration({ mealId: 'meal-1', userId: 'u1', now });
  let creates = 0;
  const initialGoogle = completedGoogle({
    create: async () => { creates += 1; throw new Error('connection lost after request'); },
    getDataPoint: async () => { throw new GoogleNutritionWriteError(403); },
  });
  await runCurrentMealSyncOutbox({ store, now, tokenForUser: async () => 'token', google: initialGoogle });
  await store.mealSync!.beginRecovery({ mealId: 'meal-1', userId: 'u1', now, reason: 'retry_this_meal' });
  await runCurrentMealSyncOutbox({ store, now, tokenForUser: async () => 'token', google: initialGoogle });
  assert.equal(store.mealSyncPoints()[0]?.status, 'unknown');

  const recoveryNames: string[] = [];
  await store.mealSync!.beginRecovery({
    mealId: 'meal-1', userId: 'u1', now: new Date(now.getTime() + 1_000), reason: 'authorization_restored',
  });
  await runCurrentMealSyncOutbox({
    store,
    now: new Date(now.getTime() + 1_000),
    tokenForUser: async () => 'fresh-token',
    google: completedGoogle({ getDataPoint: async (_token, name) => { recoveryNames.push(name); return undefined; } }),
  });

  assert.equal(creates, 1);
  assert.deepEqual(recoveryNames, [store.mealSyncPoints()[0]?.dataPointName]);
  assert.equal(store.mealSyncPoints()[0]?.status, 'unknown');
});

test('worker polls an accepted operation instead of replaying its create request', async () => {
  const store = await savedMeal();
  await store.mealSync!.startGeneration({ mealId: 'meal-1', userId: 'u1', now });
  let creates = 0;
  let operationReads = 0;
  const google = completedGoogle({
    create: async () => { creates += 1; return { done: false, name: 'operations/create-1' }; },
    getOperation: async (_token, name) => { operationReads += 1; assert.equal(name, 'operations/create-1'); return { done: true, name }; },
  });

  await runCurrentMealSyncOutbox({ store, now, tokenForUser: async () => 'token', google });
  await runCurrentMealSyncOutbox({
    store, now: new Date(now.getTime() + 60_000), tokenForUser: async () => 'token', google,
  });

  assert.equal(creates, 1);
  assert.equal(operationReads, 1);
  assert.equal((await store.currentMeals.findCurrentMeal('u1', 'meal-1'))?.syncState, 'synced');
});

test('transient Google errors stay syncing and retry after their backoff', async () => {
  const store = await savedMeal();
  await store.mealSync!.startGeneration({ mealId: 'meal-1', userId: 'u1', now });
  let creates = 0;
  const google = completedGoogle({
    create: async () => {
      creates += 1;
      if (creates === 1) throw new GoogleNutritionWriteError(503);
      return { done: true };
    },
  });

  const first = await runCurrentMealSyncOutbox({ store, now, tokenForUser: async () => 'token', google });
  assert.equal(first.retrying, 1);
  assert.equal((await store.currentMeals.findCurrentMeal('u1', 'meal-1'))?.syncState, 'syncing');
  await runCurrentMealSyncOutbox({ store, now: new Date(now.getTime() + 59_000), tokenForUser: async () => 'token', google });
  assert.equal(creates, 1);
  await runCurrentMealSyncOutbox({ store, now: new Date(now.getTime() + 60_000), tokenForUser: async () => 'token', google });
  assert.equal(creates, 2);
  assert.equal((await store.currentMeals.findCurrentMeal('u1', 'meal-1'))?.syncState, 'synced');
});

test('permission failures require action while a timed-out create stays unknown', async () => {
  const actionStore = await savedMeal();
  await actionStore.mealSync!.startGeneration({ mealId: 'meal-1', userId: 'u1', now });
  const permission = await runCurrentMealSyncOutbox({
    store: actionStore,
    now,
    tokenForUser: async () => 'token',
    google: completedGoogle({ create: async () => { throw new GoogleNutritionWriteError(403); } }),
  });
  assert.equal(permission.failed, 1);
  assert.equal(actionStore.mealSyncPoints()[0]?.status, 'failed_action_required');

  const timeoutStore = await savedMeal();
  await timeoutStore.mealSync!.startGeneration({ mealId: 'meal-1', userId: 'u1', now });
  let creates = 0;
  const timedOut = await runCurrentMealSyncOutbox({
    store: timeoutStore,
    now,
    requestTimeoutMs: 5,
    tokenForUser: async () => 'token',
    google: completedGoogle({ create: async () => {
      creates += 1;
      return new Promise(() => undefined);
    } }),
  });
  assert.equal(timedOut.unknown, 1);
  assert.equal(timeoutStore.mealSyncPoints()[0]?.status, 'unknown');
  await runCurrentMealSyncOutbox({
    store: timeoutStore,
    now: new Date(now.getTime() + 60_000),
    requestTimeoutMs: 5,
    tokenForUser: async () => 'token',
    google: completedGoogle({ create: async () => { creates += 1; return { done: true }; } }),
  });
  assert.equal(creates, 1);
});
