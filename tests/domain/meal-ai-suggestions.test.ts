import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasMealAiSuggestionConflict,
  mealAiSuggestionsSchema,
} from '../../src/domain/meal-ai-suggestions';

test('accepts only the two strict AI suggestion wire shapes', () => {
  const parsed = mealAiSuggestionsSchema.parse({
    suggestions: [
      {
        kind: 'replace_ingredients',
        dishId: 'dish-1',
        nameZh: '番茄炒蛋',
        ingredients: [{ nameZh: '番茄', grams: 120 }, { nameZh: '雞蛋', grams: 80 }],
      },
      { kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'VITAMIN_C', value: 50, unit: 'mg' },
    ],
  });

  assert.equal(parsed.suggestions.length, 2);
  assert.equal(parsed.suggestions[0]?.kind, 'replace_ingredients');
});

test('rejects unknown suggestion fields, kinds, invalid units, and non-finite values', () => {
  const invalid = [
    {
      suggestions: [{ kind: 'delete_dish', dishId: 'dish-1' }],
    },
    {
      suggestions: [{
        kind: 'replace_ingredients', dishId: 'dish-1', nameZh: '菜',
        ingredients: [{ nameZh: '鹽', grams: 0 }],
      }],
    },
    {
      suggestions: [{ kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'ENERGY', value: 200, unit: 'g' }],
    },
    {
      suggestions: [{ kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: Number.NaN, unit: 'g' }],
    },
    {
      suggestions: [{ kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 20, unit: 'g', extra: true }],
    },
  ];

  for (const response of invalid) {
    assert.throws(() => mealAiSuggestionsSchema.parse(response));
  }
});

test('marks same-dish replacement combinations as apply-all conflicts only', () => {
  const replacement = {
    kind: 'replace_ingredients' as const,
    dishId: 'dish-1',
    nameZh: '番茄炒蛋',
    ingredients: [{ nameZh: '番茄', grams: 120 }],
  };
  const energy = {
    kind: 'set_nutrient' as const,
    dishId: 'dish-1',
    nutrientCode: 'ENERGY',
    value: 200,
    unit: 'kcal' as const,
  };
  const protein = {
    kind: 'set_nutrient' as const,
    dishId: 'dish-1',
    nutrientCode: 'PROTEIN',
    value: 20,
    unit: 'g' as const,
  };

  assert.equal(hasMealAiSuggestionConflict([replacement, { ...replacement, nameZh: '另一版' }]), true);
  assert.equal(hasMealAiSuggestionConflict([replacement, energy]), true);
  assert.equal(hasMealAiSuggestionConflict([energy, protein]), false);
  assert.equal(hasMealAiSuggestionConflict([protein, { ...protein, value: 22 }]), true);
  assert.equal(hasMealAiSuggestionConflict([replacement, { ...energy, dishId: 'dish-2' }]), false);
});
