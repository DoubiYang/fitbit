import assert from 'node:assert/strict';
import test from 'node:test';

import {
  editableNutrientUnits,
  groupMealNutrients,
  mealAiApplyAllState,
  presentNutrientReminder,
} from '../../src/ui/meals/nutrient-presentation';

test('groups only known current nutrients in the fixed Chinese order with readable local labels', () => {
  const groups = groupMealNutrients([
    { dishId: 'dish-1', nutrientCode: 'TW_FDA:膽鹼', value: 0.02, unit: 'g', source: 'tw_fda' },
    { dishId: 'dish-1', nutrientCode: 'CALCIUM', value: 0.12, unit: 'g', source: 'tw_fda' },
    { dishId: 'dish-1', nutrientCode: 'VITAMIN_C', value: 0.0894, unit: 'g', source: 'tw_fda' },
    { dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 12.5, unit: 'g', source: 'tw_fda' },
    { dishId: 'dish-1', nutrientCode: 'ENERGY', value: 320, unit: 'kcal', source: 'tw_fda' },
  ]);

  assert.deepEqual(groups.map(({ id, label, nutrients }) => ({
    id,
    label,
    nutrientCodes: nutrients.map((nutrient) => nutrient.nutrientCode),
  })), [
    { id: 'energy_and_macros', label: '能量与宏量', nutrientCodes: ['ENERGY', 'PROTEIN'] },
    { id: 'vitamins', label: '维生素', nutrientCodes: ['VITAMIN_C'] },
    { id: 'minerals', label: '矿物质', nutrientCodes: ['CALCIUM'] },
    { id: 'other_local', label: '其他本地已知成分', nutrientCodes: ['TW_FDA:膽鹼'] },
  ]);

  const vitaminC = groups[1]?.nutrients[0];
  assert.deepEqual(vitaminC && { value: vitaminC.displayValue, unit: vitaminC.displayUnit, formatted: vitaminC.formattedValue }, {
    value: 89.4,
    unit: 'mg',
    formatted: '89.4 mg',
  });
  assert.equal(groups[3]?.nutrients[0]?.label, '臺灣食藥署：膽鹼');
  assert.equal(groups[0]?.nutrients.some((nutrient) => nutrient.nutrientCode === 'CARBOHYDRATES'), false);
});

test('keeps unknown values unknown and exposes valid direct-edit units', () => {
  const groups = groupMealNutrients([
    { dishId: 'dish-1', nutrientCode: 'VITAMIN_A', value: undefined, unit: 'g', source: 'tw_fda' },
    { dishId: 'dish-1', nutrientCode: 'VITAMIN_D', value: 0.00001, unit: 'g', source: 'user_edit' },
  ]);

  assert.deepEqual(groups[1]?.nutrients.map((nutrient) => ({
    nutrientCode: nutrient.nutrientCode,
    displayValue: nutrient.displayValue,
    displayUnit: nutrient.displayUnit,
    formattedValue: nutrient.formattedValue,
  })), [
    { nutrientCode: 'VITAMIN_A', displayValue: undefined, displayUnit: 'μg', formattedValue: '未知' },
    { nutrientCode: 'VITAMIN_D', displayValue: 10, displayUnit: 'μg', formattedValue: '10 μg' },
  ]);
  assert.deepEqual(editableNutrientUnits('ENERGY'), ['kcal']);
  assert.deepEqual(editableNutrientUnits('VITAMIN_D'), ['g', 'mg', 'μg']);
});

test('uses a non-zero microgram display for a tiny local FDA-only nutrient', () => {
  const nutrient = groupMealNutrients([
    { dishId: 'dish-1', nutrientCode: 'TW_FDA:葉酸樣欄位', value: 0.00001, unit: 'g', source: 'tw_fda' },
  ])[3]?.nutrients[0];

  assert.deepEqual(nutrient && {
    displayValue: nutrient.displayValue,
    displayUnit: nutrient.displayUnit,
    formattedValue: nutrient.formattedValue,
  }, {
    displayValue: 10,
    displayUnit: 'μg',
    formattedValue: '10 μg',
  });
});

test('disables AI apply-all only when suggestion ordering would overwrite the same dish', () => {
  const replacement = {
    kind: 'replace_ingredients' as const,
    dishId: 'dish-1',
    nameZh: '番茄炒蛋',
    ingredients: [{ nameZh: '番茄', grams: 120 }],
  };
  const protein = {
    kind: 'set_nutrient' as const,
    dishId: 'dish-1',
    nutrientCode: 'PROTEIN',
    value: 20,
    unit: 'g' as const,
  };

  assert.deepEqual(mealAiApplyAllState([replacement, protein]), {
    disabled: true,
    reason: 'conflicting_suggestions',
    message: '这批建议会互相覆盖，请逐条应用。',
  });
  assert.deepEqual(mealAiApplyAllState([protein, { ...protein, value: 22 }]), {
    disabled: true,
    reason: 'conflicting_suggestions',
    message: '这批建议会互相覆盖，请逐条应用。',
  });
  assert.deepEqual(mealAiApplyAllState([protein, { ...protein, dishId: 'dish-2' }]), { disabled: false });
});

test('never presents low intake when local reminder coverage is insufficient', () => {
  const insufficientCoverage = presentNutrientReminder({ status: 'below_reference', coverage: 0.79 });
  assert.deepEqual(insufficientCoverage, {
    status: 'unknown',
    message: '数据不足，暂时无法判断',
  });
  assert.doesNotMatch(insufficientCoverage.message, /偏低/u);
  assert.deepEqual(presentNutrientReminder({ status: 'unknown', coverage: 0.8 }), {
    status: 'unknown',
    message: '数据不足，暂时无法判断',
  });
  assert.deepEqual(presentNutrientReminder({ status: 'below_reference', coverage: 0.8 }), {
    status: 'below_reference',
    message: '相对参考摄入量偏低',
  });
  for (const coverage of [undefined, Number.NaN, Infinity, -0.01, 1.01]) {
    assert.deepEqual(presentNutrientReminder({
      status: 'below_reference',
      coverage: coverage as number,
    }), {
      status: 'unknown',
      message: '数据不足，暂时无法判断',
    });
  }
});
