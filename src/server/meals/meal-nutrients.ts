import { randomUUID } from 'node:crypto';

import type { ResolvedDish } from './ingredient-nutrition';
import type { MealIngredientRow, MealNutrientRow } from './types';

export function factsFromResolvedDish(input: {
  dishId: string;
  userId: string;
  source: string;
  resolved: ResolvedDish;
}): { ingredients: MealIngredientRow[]; nutrients: MealNutrientRow[] } {
  const ingredients = input.resolved.ingredients.map((item) => ({
    id: randomUUID(),
    dishId: input.dishId,
    userId: input.userId,
    foodName: item.nameZh,
    grams: item.grams,
  }));
  const nutrients: MealNutrientRow[] = [];
  const seen = new Set<string>();
  const push = (nutrientCode: string, values: { grams?: number; kcal?: number }) => {
    if (seen.has(nutrientCode)) {
      return;
    }
    if (values.grams === undefined && values.kcal === undefined) {
      return;
    }
    seen.add(nutrientCode);
    nutrients.push({
      dishId: input.dishId,
      userId: input.userId,
      nutrientCode,
      grams: values.grams,
      kcal: values.kcal,
      source: input.source,
      confidence: 1,
    });
  };
  push('ENERGY', { kcal: input.resolved.totals.energyKcal });
  push('FAT', { grams: input.resolved.totals.fatGrams });
  push('CARBOHYDRATES', { grams: input.resolved.totals.carbGrams });
  for (const [code, grams] of Object.entries(input.resolved.totals.nutrients)) {
    if (code === 'CARBOHYDRATES') {
      continue;
    }
    push(code, { grams });
  }
  push('PROTEIN', { grams: input.resolved.totals.proteinGrams });
  return { ingredients, nutrients };
}
