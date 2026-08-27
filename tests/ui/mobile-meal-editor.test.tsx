import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { EditableMealDraft, EditableMealSaved } from '../../src/domain/meal-editor';
import {
  MobileMealEditor,
  mealEditorEndpoint,
  savedMealUrl,
} from '../../src/ui/meals/mobile-meal-editor';

const draft: EditableMealDraft = {
  view: 'draft',
  mealId: 'draft-1',
  mealType: 'LUNCH',
  eatenAt: '2026-08-27T04:00:00.000Z',
  dishes: [{
    id: 'dish-1',
    nameZh: '番茄鸡胸肉',
    portionGrams: 180,
    ingredients: [{
      nameZh: '鸡胸肉',
      grams: 120,
      foodSource: 'tw_fda',
      foodSourceId: 'A001',
      foodSourceVersion: '2026-08',
    }],
  }],
  nutrients: [
    { dishId: 'dish-1', nutrientCode: 'ENERGY', value: 220, unit: 'kcal', source: 'tw_fda' },
    { dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 32, unit: 'g', source: 'tw_fda' },
    { dishId: 'dish-1', nutrientCode: 'VITAMIN_C', value: 0.02, unit: 'g', source: 'tw_fda' },
  ],
};

const saved: EditableMealSaved = {
  ...draft,
  view: 'saved',
  mealId: 'meal-1',
  savedAt: '2026-08-27T04:05:00.000Z',
};

test('new editor offers a consented photo upload and has no nutrient search', () => {
  const html = renderToStaticMarkup(React.createElement(MobileMealEditor));

  assert.match(html, /选择餐食照片/);
  assert.match(html, /type="file"/);
  assert.match(html, /我同意将这张照片发送给 AI 识别/);
  assert.match(html, /开始识别/);
  assert.doesNotMatch(html, /营养搜索|搜索营养/);
});

test('draft editor has a local save action, nutrient edit affordance, and no automatic AI apply', () => {
  const html = renderToStaticMarkup(React.createElement(MobileMealEditor, { initialDraft: draft }));

  assert.match(html, /保存修改/);
  assert.doesNotMatch(html, /同步这一餐/);
  assert.match(html, /编辑此菜/);
  assert.match(html, /能量与宏量/);
  assert.match(html, /编辑营养/);
  assert.match(html, /问 AI 修改这餐/);
  assert.doesNotMatch(html, /自动应用/);
});

test('saved editor exposes explicit sync and recovery retries lock edits', () => {
  const unsyncedHtml = renderToStaticMarkup(
    React.createElement(MobileMealEditor, { initialMeal: saved, initialSyncState: 'unsynced' }),
  );
  assert.match(unsyncedHtml, /已保存 · 未同步/);
  assert.match(unsyncedHtml, /同步这一餐/);

  const recoveryHtml = renderToStaticMarkup(
    React.createElement(MobileMealEditor, { initialMeal: saved, initialSyncState: 'recovery' }),
  );
  assert.match(recoveryHtml, /同步恢复中/);
  assert.match(recoveryHtml, /重试这一餐/);
  assert.match(recoveryHtml, /编辑已暂停/);
});

test('uses the rhythm base path for draft, saved, AI, and explicit-sync requests', () => {
  assert.equal(mealEditorEndpoint({ kind: 'photo' }), '/rhythm/api/meals/photo');
  assert.equal(mealEditorEndpoint({ kind: 'draft', draftId: 'draft-1' }), '/rhythm/api/meals/drafts/draft-1');
  assert.equal(mealEditorEndpoint({ kind: 'draft_ai', draftId: 'draft-1' }), '/rhythm/api/meals/drafts/draft-1/ai-suggestions');
  assert.equal(mealEditorEndpoint({ kind: 'save_draft', draftId: 'draft-1' }), '/rhythm/api/meals/drafts/draft-1/save');
  assert.equal(mealEditorEndpoint({ kind: 'meal', mealId: 'meal-1' }), '/rhythm/api/meals/meal-1');
  assert.equal(mealEditorEndpoint({ kind: 'meal_ai', mealId: 'meal-1' }), '/rhythm/api/meals/meal-1/ai-suggestions');
  assert.equal(mealEditorEndpoint({ kind: 'sync', mealId: 'meal-1' }), '/rhythm/api/meals/meal-1/sync');
  assert.equal(savedMealUrl('meal-1'), '/rhythm/meals/meal-1');
});
