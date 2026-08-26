import { randomUUID } from 'node:crypto';

import type { ResolvedDish } from './ingredient-nutrition';
import type { MealIngredientRow, MealNutrientRow, MealNutritionProvenanceRow } from './types';

const GOOGLE_FOOD_SOURCE_VERSION = 'google-health-v4';
const RESOLVER_VERSION = 'google-health-food-v1';

export function factsFromResolvedDish(input: {
  dishId: string;
  userId: string;
  source: string;
  visionConfidence: number;
  resolved: ResolvedDish;
}): { ingredients: MealIngredientRow[]; nutrients: MealNutrientRow[]; provenance: MealNutritionProvenanceRow } {
  const ingredients: MealIngredientRow[] = input.resolved.ingredients.map((item) => ({
    id: randomUUID(),
    dishId: input.dishId,
    userId: input.userId,
    foodName: item.nameZh,
    foodSource: item.foodName ? 'google_health_food' : 'unmatched',
    foodSourceId: item.foodName,
    foodSourceVersion: item.foodName ? GOOGLE_FOOD_SOURCE_VERSION : undefined,
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
      confidence: input.visionConfidence,
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
  const totalIngredientGrams = ingredients.reduce((total, item) => total + item.grams, 0);
  const matchedIngredientGrams = ingredients
    .filter((item) => item.foodSource === 'google_health_food')
    .reduce((total, item) => total + item.grams, 0);
  return {
    ingredients,
    nutrients,
    provenance: {
      dishId: input.dishId,
      userId: input.userId,
      resolverVersion: RESOLVER_VERSION,
      foodSource: matchedIngredientGrams > 0 ? 'google_health_food' : 'unmatched',
      foodSourceVersion: matchedIngredientGrams > 0 ? GOOGLE_FOOD_SOURCE_VERSION : undefined,
      visionConfidence: input.visionConfidence,
      totalIngredientGrams,
      matchedIngredientGrams,
    },
  };
}
