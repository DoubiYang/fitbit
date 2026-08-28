import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mapTwFdaNutrient,
  resolveEditableTwFdaDishIngredients,
  resolveTwFdaDishIngredients,
  resolveExactTwFdaFood,
  type LocalTwFdaFood,
} from '../../src/server/nutrition/tw-fda';

const broccoli: LocalTwFdaFood = {
  sourceRevision: 'source-sha',
  officialFoodId: 'E5800402',
  nameZh: '青花菜(2021年取樣)',
  aliases: ['青花苔'],
  nutrients: [
    { officialName: '熱量', rawUnit: 'kcal', per100gValue: 34 },
    { officialName: '粗蛋白', rawUnit: 'g', per100gValue: 2.82 },
    { officialName: '維生素C', rawUnit: 'mg', per100gValue: 89.4 },
    { officialName: '維生素K1', rawUnit: 'ug', per100gValue: 102 },
  ],
};

test('resolves a simplified-Chinese exact alias to its Taiwan FDA food', () => {
  const resolved = resolveExactTwFdaFood('西兰花', [broccoli]);
  assert.equal(resolved?.officialFoodId, 'E5800402');
  assert.equal(resolved?.nameZh, '青花菜(2021年取樣)');
});

test('returns no food for an ambiguous exact alias', () => {
  const ambiguous = resolveExactTwFdaFood('西兰花', [
    broccoli,
    { ...broccoli, officialFoodId: 'V0100102', nameZh: '綠花椰菜', aliases: ['西蘭花'] },
  ]);
  assert.equal(ambiguous, undefined);
});

test('does not treat duplicate rows for one official food as an ambiguity', () => {
  const resolved = resolveExactTwFdaFood('西兰花', [broccoli, structuredClone(broccoli)]);
  assert.equal(resolved?.officialFoodId, 'E5800402');
});

test('converts only unambiguous mass units to canonical grams', () => {
  const vitaminC = mapTwFdaNutrient({ officialName: '維生素C', rawUnit: 'mg', per100gValue: 89.4 });
  assert.equal(vitaminC?.nutrientCode, 'VITAMIN_C');
  assert.ok(Math.abs((vitaminC && 'gramsPer100g' in vitaminC ? vitaminC.gramsPer100g : 0) - 0.0894) < 1e-12);
  const vitaminK = mapTwFdaNutrient({ officialName: '維生素K1', rawUnit: 'ug', per100gValue: 102 });
  assert.equal(vitaminK?.nutrientCode, 'VITAMIN_K');
  assert.ok(Math.abs((vitaminK && 'gramsPer100g' in vitaminK ? vitaminK.gramsPer100g : 0) - 0.000102) < 1e-12);
  assert.equal(mapTwFdaNutrient({ officialName: '維生素A總量(IU)', rawUnit: 'I.U.', per100gValue: 100 }), undefined);
});

test('leaves an absent nutrient undefined instead of inventing a zero', () => {
  const mapped = broccoli.nutrients.map(mapTwFdaNutrient).filter((fact) => fact !== undefined);
  assert.equal(mapped.find((fact) => fact.nutrientCode === 'ZINC'), undefined);
});

test('scales a locally resolved food and carries Taiwan FDA provenance', async () => {
  const resolved = await resolveTwFdaDishIngredients(
    {
      nameZh: '西兰花',
      ingredients: ['西兰花'],
      portionGrams: 50,
      visibleFraction: 'full',
      confidence: 0.9,
      needsConfirmation: [],
    },
    { async findExact() { return broccoli; } },
  );

  assert.equal(resolved.ingredients[0]?.foodName, 'E5800402');
  assert.equal(resolved.ingredients[0]?.foodSource, 'tw_fda');
  assert.equal(resolved.ingredients[0]?.foodSourceVersion, 'source-sha');
  assert.equal(resolved.totals.energyKcal, 17);
  assert.ok(Math.abs((resolved.totals.nutrients.VITAMIN_C ?? 0) - 0.0447) < 1e-12);
});

test('uses FDA vitamin totals or equivalents without double-counting component fields', async () => {
  const resolved = await resolveTwFdaDishIngredients(
    {
      nameZh: '維生素測試食物',
      ingredients: ['維生素測試食物'],
      portionGrams: 100,
      visibleFraction: 'full',
      confidence: 0.9,
      needsConfirmation: [],
    },
    {
      async findExact() {
        return {
          sourceRevision: 'source-sha',
          officialFoodId: 'VITAMIN-FOOD',
          nameZh: '維生素測試食物',
          aliases: [],
          nutrients: [
            { officialName: '視網醇', rawUnit: 'ug', per100gValue: 100 },
            { officialName: '視網醇當量(RE)', rawUnit: 'ug', per100gValue: 200 },
            { officialName: '維生素D2', rawUnit: 'ug', per100gValue: 1 },
            { officialName: '維生素D3', rawUnit: 'ug', per100gValue: 2 },
            { officialName: '維生素D總量(ug)', rawUnit: 'ug', per100gValue: 10 },
            { officialName: 'α-生育酚', rawUnit: 'mg', per100gValue: 1 },
            { officialName: '維生素E總量', rawUnit: 'mg', per100gValue: 2 },
            { officialName: 'α-維生素E當量(α-TE)', rawUnit: 'mg', per100gValue: 3 },
            { officialName: '維生素K1', rawUnit: 'ug', per100gValue: 2 },
            { officialName: '維生素K2(MK-4)', rawUnit: 'ug', per100gValue: 3 },
            { officialName: '維生素K2(MK-7)', rawUnit: 'ug', per100gValue: 4 },
          ],
        };
      },
    },
  );

  assert.equal(resolved.totals.nutrients.VITAMIN_A, 0.0002);
  assert.equal(resolved.totals.nutrients.VITAMIN_D, 0.00001);
  assert.equal(resolved.totals.nutrients.VITAMIN_E, 0.003);
  assert.ok(Math.abs((resolved.totals.nutrients.VITAMIN_K ?? 0) - 0.000009) < 1e-12);
});

test('adds vitamin D components only when the FDA total is unavailable', async () => {
  const resolved = await resolveTwFdaDishIngredients(
    {
      nameZh: '維生素 D 測試食物',
      ingredients: ['維生素 D 測試食物'],
      portionGrams: 100,
      visibleFraction: 'full',
      confidence: 0.9,
      needsConfirmation: [],
    },
    {
      async findExact() {
        return {
          sourceRevision: 'source-sha',
          officialFoodId: 'VITAMIN-D-FOOD',
          nameZh: '維生素 D 測試食物',
          aliases: [],
          nutrients: [
            { officialName: '維生素D2', rawUnit: 'ug', per100gValue: 1 },
            { officialName: '維生素D3', rawUnit: 'ug', per100gValue: 2 },
          ],
        };
      },
    },
  );

  assert.ok(Math.abs((resolved.totals.nutrients.VITAMIN_D ?? 0) - 0.000003) < 1e-12);
});

test('recalculates editable ingredient grams directly and retains local FDA-only facts', async () => {
  const catalog = {
    async findExact(nameZh: string) {
      if (nameZh === '雞肉') {
        return {
          sourceRevision: 'source-sha',
          officialFoodId: 'CHICKEN',
          nameZh: '雞肉',
          aliases: [],
          nutrients: [
            { officialName: '熱量', rawUnit: 'kcal', per100gValue: 200 },
            { officialName: '粗蛋白', rawUnit: 'g', per100gValue: 20 },
            { officialName: '膽鹼', rawUnit: 'mg', per100gValue: 80 },
          ],
        };
      }
      if (nameZh === '白飯') {
        return {
          sourceRevision: 'source-sha',
          officialFoodId: 'RICE',
          nameZh: '白飯',
          aliases: [],
          nutrients: [
            { officialName: '熱量', rawUnit: 'kcal', per100gValue: 100 },
            { officialName: '總碳水化合物', rawUnit: 'g', per100gValue: 25 },
          ],
        };
      }
      return undefined;
    },
  };

  const mostlyChicken = await resolveEditableTwFdaDishIngredients(
    { nameZh: '雞肉飯', ingredients: [{ nameZh: '雞肉', grams: 75 }, { nameZh: '白飯', grams: 25 }] },
    catalog,
  );
  const mostlyRice = await resolveEditableTwFdaDishIngredients(
    { nameZh: '雞肉飯', ingredients: [{ nameZh: '雞肉', grams: 25 }, { nameZh: '白飯', grams: 75 }] },
    catalog,
  );

  assert.equal(mostlyChicken.dishGrams, 100);
  assert.equal(mostlyChicken.totals.energyKcal, 175);
  assert.equal(mostlyChicken.totals.nutrients.PROTEIN, 15);
  assert.equal(mostlyChicken.totals.nutrients.CARBOHYDRATES, 6.25);
  assert.equal(mostlyChicken.totals.nutrients['TW_FDA:膽鹼'], 0.06);
  assert.equal(mostlyRice.totals.energyKcal, 125);
  assert.equal(mostlyRice.totals.nutrients.PROTEIN, 5);
  assert.equal(mostlyRice.totals.nutrients.CARBOHYDRATES, 18.75);
});

test('keeps unmatched editable ingredients unknown without inventing nutrients', async () => {
  const resolved = await resolveEditableTwFdaDishIngredients(
    { nameZh: '未知料理', ingredients: [{ nameZh: '未知食材', grams: 42 }] },
    { async findExact() { return undefined; } },
  );

  assert.deepEqual(resolved.ingredients[0], {
    nameZh: '未知食材',
    grams: 42,
    matchedDisplayName: undefined,
    foodName: undefined,
    foodSource: 'unmatched',
    foodSourceVersion: undefined,
    energyKcal: undefined,
    proteinGrams: undefined,
    carbGrams: undefined,
    fatGrams: undefined,
    nutrients: {},
  });
  assert.equal(resolved.totals.energyKcal, undefined);
  assert.deepEqual(resolved.totals.nutrients, {});
});
