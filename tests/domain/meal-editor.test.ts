import assert from 'node:assert/strict';
import test from 'node:test';

import {
  editableMealDraftSchema,
  editableMealSavedSchema,
  mealPatchSchema,
  toInternalNutrientAmount,
  fromInternalNutrientAmount,
} from '../../src/domain/meal-editor';

const ingredients = [{ nameZh: '鸡蛋', grams: 80 }, { nameZh: '番茄', grams: 120 }];

test('accepts replacing a dish ingredient list with positive finite grams', () => {
  const patch = mealPatchSchema.parse({
    kind: 'replace_ingredients',
    dishId: 'dish-1',
    nameZh: '番茄炒蛋',
    ingredients,
  });
  assert.equal(patch.kind, 'replace_ingredients');
  assert.equal(patch.ingredients[0]?.grams, 80);
});

test('rejects replacing ingredients when the list is empty or grams are invalid', () => {
  for (const invalid of [
    { kind: 'replace_ingredients', dishId: 'dish-1', nameZh: '菜', ingredients: [] },
    { kind: 'replace_ingredients', dishId: 'dish-1', nameZh: '菜', ingredients: [{ nameZh: '盐', grams: 0 }] },
    { kind: 'replace_ingredients', dishId: 'dish-1', nameZh: '菜', ingredients: [{ nameZh: '盐', grams: Number.NaN }] },
  ]) {
    assert.throws(() => mealPatchSchema.parse(invalid));
  }
});

test('accepts nutrient patches and rejects invalid energy and mass units', () => {
  assert.deepEqual(
    mealPatchSchema.parse({ kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'ENERGY', value: 420, unit: 'kcal' }),
    { kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'ENERGY', value: 420, unit: 'kcal' },
  );
  assert.throws(() => mealPatchSchema.parse({ kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'ENERGY', value: 420, unit: 'g' }));
  assert.throws(() => mealPatchSchema.parse({ kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 20, unit: 'kcal' }));
  assert.throws(() => mealPatchSchema.parse({ kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: -1, unit: 'g' }));
  assert.throws(() => mealPatchSchema.parse({ kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: Infinity, unit: 'g' }));
});

test('draft and saved views carry dish and nutrient identity without vision or photo payloads', () => {
  const draft = editableMealDraftSchema.parse({
    view: 'draft',
    mealId: 'meal-1',
    mealType: 'lunch',
    eatenAt: '2026-08-26T12:00:00.000Z',
    dishes: [{ id: 'dish-1', nameZh: '番茄炒蛋', ingredients, portionGrams: 200 }],
    nutrients: [{ dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 20, unit: 'g' }],
  });
  const saved = editableMealSavedSchema.parse({ ...draft, view: 'saved', savedAt: '2026-08-26T00:00:00.000Z' });
  assert.equal(draft.dishes[0]?.id, 'dish-1');
  assert.equal(saved.view, 'saved');
  assert.equal(saved.mealType, 'lunch');
  assert.equal(saved.eatenAt, '2026-08-26T12:00:00.000Z');
  assert.equal(saved.nutrients[0]?.dishId, 'dish-1');
  assert.throws(() => editableMealDraftSchema.parse({ ...draft, photoBytes: 'nope' }));
  assert.throws(() => mealPatchSchema.parse({ kind: 'replace_ingredients', dishId: 'dish-1', nameZh: '菜', portionGrams: 100, ingredients }));
});

test('converts mass units safely and keeps energy in kcal', () => {
  assert.deepEqual(toInternalNutrientAmount('PROTEIN', 1250, 'mg'), { nutrientCode: 'PROTEIN', value: 1.25, unit: 'g' });
  assert.deepEqual(fromInternalNutrientAmount('PROTEIN', 1.25, 'μg'), { nutrientCode: 'PROTEIN', value: 1_250_000, unit: 'μg' });
  assert.deepEqual(toInternalNutrientAmount('ENERGY', 500, 'kcal'), { nutrientCode: 'ENERGY', value: 500, unit: 'kcal' });
  assert.throws(() => toInternalNutrientAmount('ENERGY', 1, 'g'));
  assert.throws(() => fromInternalNutrientAmount('PROTEIN', 1, 'kcal'));
});
