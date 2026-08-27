import assert from 'node:assert/strict';
import test from 'node:test';

import type { EditableMealDraft } from '../../src/domain/meal-editor';
import { createMemoryStore } from '../../src/server/db/memory-store';

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

function editorWithTwoDishes(mealId = 'meal-1'): EditableMealDraft {
  const draft = editor(mealId);
  draft.dishes.push({
    id: 'dish-2',
    nameZh: '豆腐',
    portionGrams: 80,
    ingredients: [{
      nameZh: '豆腐', grams: 80, foodSource: 'tw_fda', foodSourceId: 'V0200202', foodSourceVersion: 'fda-test',
    }],
  });
  draft.nutrients.push({ dishId: 'dish-2', nutrientCode: 'ENERGY', value: 60, unit: 'kcal', source: 'tw_fda' });
  return draft;
}

async function savedMeal() {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.currentMeals.insertEditorDraft({
    id: 'meal-1', userId: 'u1', mealType: 'LUNCH', eatenAt: now,
    vision: { foods: [], photoQuality: 'unusable', globalUncertainties: [] },
    editor: editor(), now,
  });
  await store.currentMeals.saveEditorDraft({ userId: 'u1', draftId: 'meal-1', now });
  return store;
}

async function finishClaims(store: Awaited<ReturnType<typeof savedMeal>>, at = now): Promise<void> {
  const leaseUntil = new Date(at.getTime() + 120_000);
  const claims = await store.mealSync!.claimDuePoints({ now: at, leaseUntil, limit: 20 });
  for (const claim of claims) {
    assert.equal(await store.mealSync!.finishPoint({
      id: claim.id,
      generationId: claim.generationId,
      userId: claim.userId,
      leaseUntil,
      now: at,
    }), true);
  }
}

test('first explicit sync freezes one immutable create point and locks the current meal', async () => {
  const store = await savedMeal();

  const generation = await store.mealSync!.startGeneration({ mealId: 'meal-1', userId: 'u1', now });

  assert.equal(generation?.phase, 'pending_create');
  assert.equal((await store.currentMeals.findCurrentMeal('u1', 'meal-1'))?.syncState, 'syncing');
  const [point] = store.mealSyncPoints();
  assert.equal(point?.role, 'create_target');
  assert.match(point?.dataPointName ?? '', /\/d-[0-9a-f-]+$/u);
  assert.equal(point?.payloadHash?.length, 64);
  assert.equal(point?.payload?.name, point?.dataPointName);

  (point!.payload as { nutritionLog: { foodDisplayName: string } }).nutritionLog.foodDisplayName = 'tampered';
  assert.equal(
    ((store.mealSyncPoints()[0]?.payload as { nutritionLog: { foodDisplayName: string } }).nutritionLog.foodDisplayName),
    '鸡肉饭',
  );
});

test('concurrent explicit sync requests create only one active generation', async () => {
  const store = await savedMeal();

  const generations = await Promise.all([
    store.mealSync!.startGeneration({ mealId: 'meal-1', userId: 'u1', now }),
    store.mealSync!.startGeneration({ mealId: 'meal-1', userId: 'u1', now }),
  ]);

  assert.equal(generations.filter(Boolean).length, 1);
  assert.equal(store.mealSyncPoints().filter((point) => point.role === 'create_target').length, 1);
  assert.equal((await store.currentMeals.findCurrentMeal('u1', 'meal-1'))?.syncState, 'syncing');
});

test('a replacement generation claims every old delete before any new create', async () => {
  const store = await savedMeal();
  const first = await store.mealSync!.startGeneration({ mealId: 'meal-1', userId: 'u1', now });
  assert.ok(first);
  await finishClaims(store);
  assert.equal((await store.currentMeals.findCurrentMeal('u1', 'meal-1'))?.syncState, 'synced');

  await store.currentMeals.setCurrentMealNutrient({
    userId: 'u1', mealId: 'meal-1', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 30, unit: 'g', now,
  });
  const replacement = await store.mealSync!.startGeneration({ mealId: 'meal-1', userId: 'u1', now });
  assert.equal(replacement?.phase, 'pending_delete');
  const replacementPoints = store.mealSyncPoints().filter((point) => point.generationId === replacement?.id);
  const deletePoint = replacementPoints.find((point) => point.role === 'delete_target');
  const createPoint = replacementPoints.find((point) => point.role === 'create_target');
  assert.equal(deletePoint?.dataPointName, store.mealSyncPoints().find((point) => point.generationId === first.id)?.dataPointName);
  assert.notEqual(createPoint?.dataPointName, deletePoint?.dataPointName);

  const leaseUntil = new Date(now.getTime() + 120_000);
  const deleteClaims = await store.mealSync!.claimDuePoints({ now, leaseUntil, limit: 20 });
  assert.deepEqual(deleteClaims.map((claim) => claim.role), ['delete_target']);
  assert.equal(await store.mealSync!.finishPoint({
    id: deleteClaims[0]!.id, generationId: replacement!.id, userId: 'u1', leaseUntil, now,
  }), true);

  const createClaims = await store.mealSync!.claimDuePoints({ now, leaseUntil, limit: 20 });
  assert.deepEqual(createClaims.map((claim) => claim.role), ['create_target']);
  assert.equal(await store.mealSync!.finishPoint({
    id: createClaims[0]!.id, generationId: replacement!.id, userId: 'u1', leaseUntil, now,
  }), true);
  assert.equal((await store.currentMeals.findCurrentMeal('u1', 'meal-1'))?.lastSyncedGenerationId, replacement?.id);
  assert.deepEqual(store.mealSyncPoints().map((point) => ({ generationId: point.generationId, role: point.role })), [
    { generationId: replacement!.id, role: 'create_target' },
  ]);
});

test('an unknown point takes priority over an action-required point until exact recovery completes', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.currentMeals.insertEditorDraft({
    id: 'meal-1', userId: 'u1', mealType: 'LUNCH', eatenAt: now,
    vision: { foods: [], photoQuality: 'unusable', globalUncertainties: [] }, editor: editorWithTwoDishes(), now,
  });
  await store.currentMeals.saveEditorDraft({ userId: 'u1', draftId: 'meal-1', now });
  const generation = await store.mealSync!.startGeneration({ mealId: 'meal-1', userId: 'u1', now });
  assert.ok(generation);
  const leaseUntil = new Date(now.getTime() + 120_000);
  const initialClaims = await store.mealSync!.claimDuePoints({ now, leaseUntil, limit: 20 });
  assert.equal(initialClaims.length, 2);
  const unknown = initialClaims[0]!;
  const failed = initialClaims[1]!;
  await store.mealSync!.markPointUnknown({ ...unknown, leaseUntil, now, errorCode: 'request_timeout' });
  await store.mealSync!.markPointFailedActionRequired({ ...failed, leaseUntil, now, errorCode: 'google_403' });

  const requested = await store.mealSync!.beginRecovery({ mealId: 'meal-1', userId: 'u1', now, reason: 'retry_this_meal' });
  assert.equal(requested?.id, generation.id);
  assert.equal(store.mealSyncPoints().find((point) => point.id === failed.id)?.status, 'failed_action_required');
  const recoveryClaims = await store.mealSync!.claimDuePoints({ now, leaseUntil, limit: 20 });
  assert.deepEqual(recoveryClaims.map((claim) => ({ id: claim.id, status: claim.status })), [{ id: unknown.id, status: 'unknown' }]);

  await store.mealSync!.finishPoint({ id: unknown.id, generationId: generation.id, userId: 'u1', leaseUntil, now });
  await store.mealSync!.beginRecovery({ mealId: 'meal-1', userId: 'u1', now, reason: 'writeback_restored' });
  assert.equal(store.mealSyncPoints().find((point) => point.id === failed.id)?.status, 'pending');
});

test('action-required recovery restores an existing Google operation instead of creating a new write state', async () => {
  const store = await savedMeal();
  const generation = await store.mealSync!.startGeneration({ mealId: 'meal-1', userId: 'u1', now });
  assert.ok(generation);
  const firstLease = new Date(now.getTime() + 120_000);
  const [write] = await store.mealSync!.claimDuePoints({ now, leaseUntil: firstLease, limit: 1 });
  assert.ok(write);
  const operationCheckAt = new Date(now.getTime() + 60_000);
  assert.equal(await store.mealSync!.markPointOperationPending({
    id: write.id, generationId: generation.id, userId: 'u1', leaseUntil: firstLease,
    operationName: 'operations/known-write', nextAttemptAt: operationCheckAt, now,
  }), true);
  const secondLease = new Date(operationCheckAt.getTime() + 120_000);
  const [operation] = await store.mealSync!.claimDuePoints({ now: operationCheckAt, leaseUntil: secondLease, limit: 1 });
  assert.equal(operation?.status, 'operation_pending');
  assert.equal(await store.mealSync!.markPointFailedActionRequired({
    id: operation!.id, generationId: generation.id, userId: 'u1', leaseUntil: secondLease,
    now: operationCheckAt, errorCode: 'google_401',
  }), true);

  await store.mealSync!.beginRecovery({ mealId: 'meal-1', userId: 'u1', now: operationCheckAt, reason: 'writeback_prerequisites_restored' });

  const restored = store.mealSyncPoints().find((point) => point.id === write.id);
  assert.equal(restored?.status, 'operation_pending');
  assert.equal(restored?.googleOperationName, 'operations/known-write');
  assert.match(restored?.dataPointName ?? '', /\/d-[0-9a-f-]+$/u);
});

test('a retrying point stays in its pending phase and becomes claimable after its backoff', async () => {
  const store = await savedMeal();
  const generation = await store.mealSync!.startGeneration({ mealId: 'meal-1', userId: 'u1', now });
  assert.ok(generation);
  const firstLease = new Date(now.getTime() + 120_000);
  const [first] = await store.mealSync!.claimDuePoints({ now, leaseUntil: firstLease, limit: 1 });
  assert.ok(first);
  const retryAt = new Date(now.getTime() + 60_000);
  assert.equal(await store.mealSync!.retryPoint({
    id: first.id, generationId: generation.id, userId: 'u1', leaseUntil: firstLease, now,
    nextAttemptAt: retryAt, errorCode: 'google_503',
  }), true);

  const state = await store.mealSync!.readGenerationState({ mealId: 'meal-1', userId: 'u1' });
  assert.equal(state?.generation.phase, 'pending_create');
  assert.equal((await store.currentMeals.findCurrentMeal('u1', 'meal-1'))?.syncState, 'syncing');
  assert.deepEqual(await store.mealSync!.claimDuePoints({ now, leaseUntil: firstLease, limit: 1 }), []);
  const secondLease = new Date(retryAt.getTime() + 120_000);
  const [retried] = await store.mealSync!.claimDuePoints({ now: retryAt, leaseUntil: secondLease, limit: 1 });
  assert.equal(retried?.id, first.id);
  assert.equal(retried?.status, 'retrying');
});
