import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { EditableMealDraft, EditableMealSaved } from '../../src/domain/meal-editor';
import {
  MobileMealEditor,
  actionableMealAiSuggestions,
  canSubmitMealAiQuestion,
  convertEditableNutrientUnitValue,
  mealEditorEndpoint,
  mealAiApplyDisabled,
  mealSuggestionPatch,
  nextPendingSuggestionState,
  openAccessibleDialog,
  parseEditableNutrientValue,
  savedMealUrl,
  startPendingSuggestionState,
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

  assert.match(html, /<h1>餐食记录<\/h1>/);
  assert.match(html, /拍照，读懂这一餐/);
  assert.match(html, /aria-label="选择或拍摄餐食照片"/);
  assert.match(html, /type="file"/);
  assert.match(html, /<span>我同意将这张照片发送给 AI 识别<\/span>/);
  assert.match(html, /<span>进食时间<\/span>/);
  assert.match(html, /<label><span>餐次<\/span><select/);
  assert.match(html, /<label><span>进食时间<\/span><input[^>]*type="datetime-local"/);
  assert.match(html, /mealEditor__actionBar/);
  assert.match(html, /<button[^>]*type="submit"[^>]*form="meal-upload-form"[^>]*disabled=""[^>]*>开始识别<\/button>/);
  assert.equal((html.match(/<main\b/g) ?? []).length, 1);
  assert.equal((html.match(/mealEditor__actionBar/g) ?? []).length, 1);
  assert.doesNotMatch(html, /aria-label="主要导航"/);
  assert.doesNotMatch(html, /搜索/);
  assert.doesNotMatch(html, /营养搜索|搜索营养/);
});

test('draft editor keeps complete nutrition review local, editable, and explicitly AI-assisted', () => {
  const html = renderToStaticMarkup(React.createElement(MobileMealEditor, { initialDraft: draft }));

  assert.match(html, /保存到本地/);
  assert.doesNotMatch(html, /同步这一餐/);
  assert.match(html, /编辑此菜/);
  assert.match(html, /完整营养/);
  assert.match(html, /能量与宏量/);
  assert.match(html, /维生素/);
  assert.match(html, /编辑营养/);
  assert.match(html, /只覆盖这一项，其他营养不会改变/);
  assert.match(html, /询问 AI 修改这一餐/);
  assert.equal((html.match(/<main\b/g) ?? []).length, 1);
  assert.equal((html.match(/mealEditor__actionBar/g) ?? []).length, 1);
  assert.doesNotMatch(html, /自动应用/);
  assert.doesNotMatch(html, /aria-label="主要导航"/);
});

test('saved editor exposes explicit sync while recovery only checks existing remote state and locks edits', () => {
  const unsyncedHtml = renderToStaticMarkup(
    React.createElement(MobileMealEditor, {
      initialMeal: saved,
      initialSyncState: 'unsynced',
      initialCanSync: false,
      initialSyncReason: 'nutrition_writeback_disabled',
    }),
  );
  assert.match(unsyncedHtml, /已保存 · 未同步/);
  assert.match(unsyncedHtml, /账户尚未开启 Google 营养数据写回/);
  assert.match(unsyncedHtml, /<button[^>]*disabled=""[^>]*>[\s\S]*?同步这一餐/);
  assert.match(unsyncedHtml, /同步这一餐/);

  const recoveryHtml = renderToStaticMarkup(
    React.createElement(MobileMealEditor, { initialMeal: saved, initialSyncState: 'recovery', initialCanSync: true }),
  );
  assert.match(recoveryHtml, /同步恢复中/);
  assert.match(recoveryHtml, /检查同步状态/);
  assert.doesNotMatch(recoveryHtml, /重试这一餐/);
  assert.match(recoveryHtml, /编辑已暂停/);
  assert.match(recoveryHtml, /<button[^>]*class="mealEditor__secondaryButton"[^>]*disabled=""/);
  assert.match(recoveryHtml, /<button[^>]*aria-label="编辑营养 能量"[^>]*disabled=""/);
  assert.match(recoveryHtml, /<button[^>]*class="mealEditor__aiLauncher"[^>]*disabled=""/);
  assert.equal((recoveryHtml.match(/<main\b/g) ?? []).length, 1);
  assert.equal((recoveryHtml.match(/mealEditor__actionBar/g) ?? []).length, 1);
  assert.doesNotMatch(recoveryHtml, /aria-label="主要导航"/);

  const syncingHtml = renderToStaticMarkup(
    React.createElement(MobileMealEditor, { initialMeal: saved, initialSyncState: 'syncing' }),
  );
  assert.match(syncingHtml, /同步中/);
  assert.match(syncingHtml, /编辑已暂停/);
  assert.match(syncingHtml, /<button[^>]*class="mealEditor__secondaryButton"[^>]*disabled=""/);
});

test('places a blocked sync explanation above the mobile action bar instead of inside it', () => {
  const html = renderToStaticMarkup(
    React.createElement(MobileMealEditor, {
      initialMeal: saved,
      initialSyncState: 'unsynced',
      initialCanSync: false,
      initialSyncReason: 'nutrition_writeback_disabled',
    }),
  );
  const noticeIndex = html.indexOf('mealEditor__syncNotice');
  const actionBarIndex = html.indexOf('mealEditor__actionBar');
  assert.ok(noticeIndex >= 0);
  assert.ok(actionBarIndex >= 0);
  assert.ok(noticeIndex < actionBarIndex);
});

test('rejects blank nutrient editor values instead of coercing them to zero', () => {
  assert.equal(parseEditableNutrientValue(''), undefined);
  assert.equal(parseEditableNutrientValue('   \t'), undefined);
  assert.equal(parseEditableNutrientValue('-1'), undefined);
  assert.equal(parseEditableNutrientValue('0'), 0);
  assert.equal(parseEditableNutrientValue(' 12.5 '), 12.5);
});

test('keeps a cleared nutrient value empty when the editor changes units', () => {
  assert.equal(convertEditableNutrientUnitValue('', 'PROTEIN', 'g', 'mg'), '');
  assert.equal(convertEditableNutrientUnitValue('  ', 'PROTEIN', 'g', 'mg'), '  ');
  assert.equal(convertEditableNutrientUnitValue('1.5', 'PROTEIN', 'g', 'mg'), '1500');
});

test('strips response-only AI display fields before applying a suggestion as a strict PATCH', () => {
  assert.deepEqual(mealSuggestionPatch({
    id: 's-3',
    summary: '只修改蛋白质这一项为 20 g。',
    kind: 'set_nutrient',
    dishId: 'dish-1',
    nutrientCode: 'PROTEIN',
    value: 20,
    unit: 'g',
  }), {
    kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 20, unit: 'g',
  });
});

test('keeps compatible current AI suggestions actionable after one apply, but clears them after a manual patch or new response', () => {
  const first = {
    id: 's-1', summary: '只修改蛋白质这一项为 20 g。', kind: 'set_nutrient' as const,
    dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 20, unit: 'g' as const,
  };
  const second = {
    id: 's-2', summary: '只修改维生素 C 这一项为 30 mg。', kind: 'set_nutrient' as const,
    dishId: 'dish-1', nutrientCode: 'VITAMIN_C', value: 30, unit: 'mg' as const,
  };
  const afterFirst = nextPendingSuggestionState(startPendingSuggestionState([first, second]), {
    kind: 'ai_suggestion', suggestionId: first.id,
  });

  assert.deepEqual(afterFirst.suggestions.map((suggestion) => suggestion.id), ['s-1', 's-2']);
  assert.deepEqual(actionableMealAiSuggestions(afterFirst).map((suggestion) => suggestion.id), ['s-2']);

  const afterManual = nextPendingSuggestionState(afterFirst, { kind: 'manual' });
  assert.equal(afterManual.suggestions.length, 0);
  assert.equal(afterManual.resolvedIds.size, 0);

  const replacement = startPendingSuggestionState([second]);
  assert.deepEqual(actionableMealAiSuggestions(replacement).map((suggestion) => suggestion.id), ['s-2']);
});

test('locks every AI suggestion application while a meal is syncing or recovering', () => {
  assert.equal(mealAiApplyDisabled({ editingLocked: true, busy: false }), true);
  assert.equal(mealAiApplyDisabled({ editingLocked: false, busy: true }), true);
  assert.equal(mealAiApplyDisabled({ editingLocked: false, busy: false }), false);
});

test('does not submit a new AI question while a meal is syncing or recovering', () => {
  assert.equal(canSubmitMealAiQuestion({ editingLocked: true, busy: false, question: '把鸡胸肉改成 150g' }), false);
  assert.equal(canSubmitMealAiQuestion({ editingLocked: false, busy: true, question: '把鸡胸肉改成 150g' }), false);
  assert.equal(canSubmitMealAiQuestion({ editingLocked: false, busy: false, question: '   ' }), false);
  assert.equal(canSubmitMealAiQuestion({ editingLocked: false, busy: false, question: '把鸡胸肉改成 150g' }), true);
});

test('opens native dialogs modally, focuses inside, handles Escape, and restores launcher focus', () => {
  let cancelListener: ((event: Event) => void) | undefined;
  let modalOpened = 0;
  let dialogClosed = 0;
  let dialogFocused = 0;
  let fieldFocused = 0;
  let launcherFocused = 0;
  let closeRequested = 0;
  const dialog = {
    open: false,
    showModal: () => { modalOpened += 1; dialog.open = true; },
    close: () => { dialogClosed += 1; dialog.open = false; },
    focus: () => { dialogFocused += 1; },
    querySelector: () => ({ focus: () => { fieldFocused += 1; } }),
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => { cancelListener = listener as (event: Event) => void; },
    removeEventListener: () => { cancelListener = undefined; },
  };

  const cleanup = openAccessibleDialog(
    dialog as unknown as HTMLDialogElement,
    'textarea',
    () => { closeRequested += 1; },
    { focus: () => { launcherFocused += 1; } },
  );

  assert.equal(modalOpened, 1);
  assert.equal(fieldFocused, 1);
  assert.equal(dialogFocused, 0);
  let prevented = false;
  cancelListener?.({ preventDefault: () => { prevented = true; } } as Event);
  assert.equal(prevented, true);
  assert.equal(closeRequested, 1);
  cleanup();
  assert.equal(dialogClosed, 1);
  assert.equal(launcherFocused, 1);
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
