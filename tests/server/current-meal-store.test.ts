import assert from 'node:assert/strict';
import test from 'node:test';

import type { EditableMealDraft } from '../../src/domain/meal-editor';
import { createMemoryStore } from '../../src/server/db/memory-store';

const now = new Date('2026-08-26T12:00:00.000Z');

function editorDraft(mealId = 'draft-1'): EditableMealDraft {
  return {
    view: 'draft',
    mealId,
    mealType: 'LUNCH',
    eatenAt: '2026-08-26T12:00:00.000Z',
    dishes: [{
      id: 'dish-1',
      nameZh: '雞肉飯',
      portionGrams: 150,
      ingredients: [
        { nameZh: '雞肉', grams: 50, foodSource: 'unmatched', foodSourceId: undefined, foodSourceVersion: undefined },
        { nameZh: '白飯', grams: 100, foodSource: 'unmatched', foodSourceId: undefined, foodSourceVersion: undefined },
      ],
    }],
    nutrients: [
      { dishId: 'dish-1', nutrientCode: 'ENERGY', value: 300, unit: 'kcal', source: 'user_edit' },
      { dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 25, unit: 'g', source: 'user_edit' },
    ],
  };
}

test('editor draft reads expose only the editor snapshot, never raw vision', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  const editor = editorDraft();

  await store.currentMeals.insertEditorDraft({
    id: 'draft-1',
    userId: 'u1',
    mealType: 'LUNCH',
    eatenAt: now,
    vision: { foods: [], photoQuality: 'unusable', globalUncertainties: ['raw-only'] },
    editor,
    now,
  });

  assert.deepEqual(await store.currentMeals.findEditorDraft('u1', 'draft-1'), editor);
  assert.equal('vision' in (await store.currentMeals.findEditorDraft('u1', 'draft-1'))!, false);
});

test('saving an editor draft removes its raw draft and creates one unsynced current snapshot without legacy outbox rows', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.currentMeals.insertEditorDraft({
    id: 'draft-1', userId: 'u1', mealType: 'LUNCH', eatenAt: now,
    vision: { foods: [], photoQuality: 'unusable', globalUncertainties: ['delete-me'] },
    editor: editorDraft(), now,
  });

  const saved = await store.currentMeals.saveEditorDraft({ userId: 'u1', draftId: 'draft-1', now });

  assert.equal(saved.id, 'draft-1');
  assert.equal(saved.contentRevision, 1);
  assert.equal(saved.syncState, 'unsynced');
  assert.equal(await store.currentMeals.findEditorDraft('u1', 'draft-1'), undefined);
  assert.equal(await store.meals.findDraft('u1', 'draft-1'), undefined);
  assert.deepEqual(await store.currentMeals.findCurrentMeal('u1', 'draft-1'), saved);
  assert.equal(store.currentMealSnapshots().length, 1);
  assert.deepEqual(store.outboxRows(), []);
  assert.deepEqual(store.mealSyncPoints(), []);
});

test('replacing saved content retains only the current dish nutrients and persists changed meal type/time', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.currentMeals.insertEditorDraft({
    id: 'draft-1', userId: 'u1', mealType: 'LUNCH', eatenAt: now,
    vision: { foods: [], photoQuality: 'unusable', globalUncertainties: [] }, editor: editorDraft(), now,
  });
  await store.currentMeals.saveEditorDraft({ userId: 'u1', draftId: 'draft-1', now });
  const replacement = editorDraft('draft-1');
  replacement.dishes[0] = {
    id: 'dish-1', nameZh: '白飯', portionGrams: 30,
    ingredients: [{ nameZh: '白飯', grams: 30, foodSource: 'unmatched', foodSourceId: undefined, foodSourceVersion: undefined }],
  };
  replacement.nutrients = [
    { dishId: 'dish-1', nutrientCode: 'ENERGY', value: 30, unit: 'kcal', source: 'user_edit' },
    { dishId: 'dish-1', nutrientCode: 'CARBOHYDRATES', value: 7.5, unit: 'g', source: 'user_edit' },
  ];
  replacement.mealType = 'DINNER';
  replacement.eatenAt = '2026-08-26T18:30:00.000Z';

  const updated = await store.currentMeals.replaceCurrentMealContent({ userId: 'u1', mealId: 'draft-1', editor: replacement, now });

  assert.equal(updated?.contentRevision, 2);
  assert.equal(updated?.syncState, 'unsynced');
  assert.equal(updated?.mealType, 'DINNER');
  assert.equal(updated?.eatenAt.toISOString(), '2026-08-26T18:30:00.000Z');
  assert.deepEqual(updated?.nutrients, replacement.nutrients);
  assert.deepEqual(store.currentMealSnapshots()[0]?.nutrients, replacement.nutrients);
  assert.equal(store.currentMealSnapshots()[0]?.nutrients.some((row) => row.nutrientCode === 'PROTEIN'), false);
});

test('editor draft identity and meal type must agree with its stored current-meal identity', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');

  await assert.rejects(store.currentMeals.insertEditorDraft({
    id: 'draft-1', userId: 'u1', mealType: 'LUNCH', eatenAt: now,
    vision: { foods: [], photoQuality: 'unusable', globalUncertainties: [] }, editor: editorDraft('another-meal'), now,
  }), /editor meal id/);
  await assert.rejects(store.currentMeals.insertEditorDraft({
    id: 'draft-1', userId: 'u1', mealType: 'MIDNIGHT' as never, eatenAt: now,
    vision: { foods: [], photoQuality: 'unusable', globalUncertainties: [] },
    editor: { ...editorDraft(), mealType: 'MIDNIGHT' }, now,
  }), /meal type/);
});

test('a direct saved nutrient update changes exactly one current nutrient', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.currentMeals.insertEditorDraft({
    id: 'draft-1', userId: 'u1', mealType: 'LUNCH', eatenAt: now,
    vision: { foods: [], photoQuality: 'unusable', globalUncertainties: [] }, editor: editorDraft(), now,
  });
  await store.currentMeals.saveEditorDraft({ userId: 'u1', draftId: 'draft-1', now });
  const before = (await store.currentMeals.findCurrentMeal('u1', 'draft-1'))!;

  const updated = await store.currentMeals.setCurrentMealNutrient({
    userId: 'u1', mealId: 'draft-1', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 12_500, unit: 'mg', now,
  });

  assert.equal(updated?.contentRevision, 2);
  assert.deepEqual(updated?.nutrients, [
    before.nutrients[0],
    { dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 12.5, unit: 'g', source: 'user_edit' },
  ]);
});

test('a failed memory transaction rolls back a draft save without partial current state', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.currentMeals.insertEditorDraft({
    id: 'draft-1', userId: 'u1', mealType: 'LUNCH', eatenAt: now,
    vision: { foods: [], photoQuality: 'unusable', globalUncertainties: [] }, editor: editorDraft(), now,
  });

  await assert.rejects(store.withTransaction(async (tx) => {
    if (!tx.currentMeals) throw new Error('memory store must expose current meals');
    await tx.currentMeals.saveEditorDraft({ userId: 'u1', draftId: 'draft-1', now });
    throw new Error('force rollback');
  }), /force rollback/);

  assert.deepEqual(await store.currentMeals.findEditorDraft('u1', 'draft-1'), editorDraft());
  assert.equal(await store.currentMeals.findCurrentMeal('u1', 'draft-1'), undefined);
  assert.equal(store.currentMealSnapshots().length, 0);
});

test('a failed memory transaction preserves independently written parent state', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.currentMeals.insertEditorDraft({
    id: 'draft-1', userId: 'u1', mealType: 'LUNCH', eatenAt: now,
    vision: { foods: [], photoQuality: 'unusable', globalUncertainties: [] }, editor: editorDraft(), now,
  });
  let transactionSaved!: () => void;
  let releaseTransaction!: () => void;
  const saved = new Promise<void>((resolve) => { transactionSaved = resolve; });
  const release = new Promise<void>((resolve) => { releaseTransaction = resolve; });

  const transaction = store.withTransaction(async (tx) => {
    if (!tx.currentMeals) throw new Error('memory store must expose current meals');
    await tx.currentMeals.saveEditorDraft({ userId: 'u1', draftId: 'draft-1', now });
    transactionSaved();
    await release;
    throw new Error('force rollback');
  });
  await saved;
  await store.currentMeals.insertEditorDraft({
    id: 'draft-2', userId: 'u1', mealType: 'LUNCH', eatenAt: now,
    vision: { foods: [], photoQuality: 'unusable', globalUncertainties: [] }, editor: editorDraft('draft-2'), now,
  });
  releaseTransaction();

  await assert.rejects(transaction, /force rollback/);
  assert.deepEqual(await store.currentMeals.findEditorDraft('u1', 'draft-1'), editorDraft());
  assert.deepEqual(await store.currentMeals.findEditorDraft('u1', 'draft-2'), editorDraft('draft-2'));
  assert.equal(await store.currentMeals.findCurrentMeal('u1', 'draft-1'), undefined);
});

test('overlapping successful root transactions serialize commits without losing either saved meal', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  for (const id of ['draft-1', 'draft-2']) {
    await store.currentMeals.insertEditorDraft({
      id, userId: 'u1', mealType: 'LUNCH', eatenAt: now,
      vision: { foods: [], photoQuality: 'unusable', globalUncertainties: [] }, editor: editorDraft(id), now,
    });
  }
  let firstSaved!: () => void;
  let releaseFirst!: () => void;
  const saved = new Promise<void>((resolve) => { firstSaved = resolve; });
  const release = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = store.withTransaction(async (tx) => {
    if (!tx.currentMeals) throw new Error('memory store must expose current meals');
    await tx.currentMeals.saveEditorDraft({ userId: 'u1', draftId: 'draft-1', now });
    firstSaved();
    await release;
  });
  await saved;
  const second = store.withTransaction(async (tx) => {
    if (!tx.currentMeals) throw new Error('memory store must expose current meals');
    await tx.currentMeals.saveEditorDraft({ userId: 'u1', draftId: 'draft-2', now });
  });
  releaseFirst();

  await Promise.all([first, second]);
  assert.deepEqual(store.currentMealSnapshots().map((meal) => meal.id).sort(), ['draft-1', 'draft-2']);
});

test('current ingredient rows retain explicit matched and unmatched resolver provenance', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  const editor = editorDraft();
  editor.dishes[0]!.ingredients = [
    {
      nameZh: '雞肉', grams: 50, foodSource: 'tw_fda', foodSourceId: 'CHICKEN', foodSourceVersion: 'source-sha',
    },
    {
      nameZh: '未知食材', grams: 100, foodSource: 'unmatched', foodSourceId: undefined, foodSourceVersion: undefined,
    },
  ];
  await store.currentMeals.insertEditorDraft({
    id: 'draft-1', userId: 'u1', mealType: 'LUNCH', eatenAt: now,
    vision: { foods: [], photoQuality: 'unusable', globalUncertainties: [] }, editor, now,
  });
  await store.currentMeals.saveEditorDraft({ userId: 'u1', draftId: 'draft-1', now });

  assert.deepEqual(store.currentMealIngredients('draft-1'), [
    {
      mealId: 'draft-1', userId: 'u1', dishKey: 'dish-1', nameZh: '雞肉', grams: 50,
      foodSource: 'tw_fda', foodSourceId: 'CHICKEN', foodSourceVersion: 'source-sha',
    },
    {
      mealId: 'draft-1', userId: 'u1', dishKey: 'dish-1', nameZh: '未知食材', grams: 100,
      foodSource: 'unmatched', foodSourceId: undefined, foodSourceVersion: undefined,
    },
  ]);
  assert.equal(store.currentMealNutrients('draft-1').find((row) => row.nutrientCode === 'ENERGY')?.source, 'user_edit');
});
