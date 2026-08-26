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
      ingredients: [{ nameZh: '雞肉', grams: 50 }, { nameZh: '白飯', grams: 100 }],
    }],
    nutrients: [
      { dishId: 'dish-1', nutrientCode: 'ENERGY', value: 300, unit: 'kcal' },
      { dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 25, unit: 'g' },
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

test('replacing saved content retains only the current dish nutrients and increments the revision', async () => {
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
    ingredients: [{ nameZh: '白飯', grams: 30 }],
  };
  replacement.nutrients = [
    { dishId: 'dish-1', nutrientCode: 'ENERGY', value: 30, unit: 'kcal' },
    { dishId: 'dish-1', nutrientCode: 'CARBOHYDRATES', value: 7.5, unit: 'g' },
  ];

  const updated = await store.currentMeals.replaceCurrentMealContent({ userId: 'u1', mealId: 'draft-1', editor: replacement, now });

  assert.equal(updated?.contentRevision, 2);
  assert.equal(updated?.syncState, 'unsynced');
  assert.deepEqual(updated?.nutrients, replacement.nutrients);
  assert.deepEqual(store.currentMealSnapshots()[0]?.nutrients, replacement.nutrients);
  assert.equal(store.currentMealSnapshots()[0]?.nutrients.some((row) => row.nutrientCode === 'PROTEIN'), false);
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
    { dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 12.5, unit: 'g' },
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
