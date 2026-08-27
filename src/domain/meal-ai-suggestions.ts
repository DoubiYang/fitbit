import { z } from 'zod';

import {
  replaceIngredientsPatchSchema,
  setNutrientPatchSchema,
  type NutritionUnit,
} from './meal-editor';

/**
 * The only two patches an assistant may propose. They deliberately use the
 * same flat wire contract as a user PATCH, so a suggestion never carries an
 * opaque action, a persisted identifier, or arbitrary database fields.
 */
export const mealAiSuggestionSchema = z.discriminatedUnion('kind', [
  replaceIngredientsPatchSchema,
  setNutrientPatchSchema,
]);

export const mealAiSuggestionsSchema = z.object({
  suggestions: z.array(mealAiSuggestionSchema).max(20),
}).strict();

export type MealAiSuggestion = z.infer<typeof mealAiSuggestionSchema>;
export type MealAiSuggestions = z.infer<typeof mealAiSuggestionsSchema>;

const responseMetadataSchema = z.object({
  /** Stable only inside one AI response; it is never persisted. */
  id: z.string().regex(/^s-[1-9][0-9]*$/),
  /** Server-authored display text, never model-authored prose. */
  summary: z.string().trim().min(1).max(280),
});

export const mealAiSuggestionResponseItemSchema = z.discriminatedUnion('kind', [
  replaceIngredientsPatchSchema.extend(responseMetadataSchema.shape).strict(),
  setNutrientPatchSchema.extend(responseMetadataSchema.shape).strict(),
]);

export const mealAiSuggestionResponseSchema = z.object({
  suggestions: z.array(mealAiSuggestionResponseItemSchema).max(20),
}).strict();

export type MealAiSuggestionResponse = z.infer<typeof mealAiSuggestionResponseItemSchema>;
export type MealAiSuggestionResponseBody = z.infer<typeof mealAiSuggestionResponseSchema>;

/**
 * The model supplies only a patch. This response-only wrapper gives the UI
 * stable keys and text without ever trusting model prose as display content.
 */
export function presentMealAiSuggestion(suggestion: MealAiSuggestion, position: number): MealAiSuggestionResponse {
  const id = `s-${position + 1}`;
  if (suggestion.kind === 'replace_ingredients') {
    return {
      ...suggestion,
      id,
      summary: `将这道菜改为「${suggestion.nameZh}」，并按新食材克数重新计算整道菜的营养。`,
    };
  }
  return {
    ...suggestion,
    id,
    summary: `只修改 ${suggestion.nutrientCode} 这一项为 ${suggestion.value} ${suggestion.unit}。`,
  };
}

const MICROGRAM_NUTRIENTS = new Set([
  'BIOTIN',
  'CHROMIUM',
  'FOLATE',
  'FOLIC_ACID',
  'IODINE',
  'MOLYBDENUM',
  'SELENIUM',
  'VITAMIN_A',
  'VITAMIN_B12',
  'VITAMIN_D',
  'VITAMIN_K',
]);

const MILLIGRAM_NUTRIENTS = new Set([
  'CAFFEINE',
  'CALCIUM',
  'CHLORIDE',
  'CHOLESTEROL',
  'COPPER',
  'IRON',
  'MAGNESIUM',
  'MANGANESE',
  'NIACIN',
  'PANTOTHENIC_ACID',
  'PHOSPHORUS',
  'POTASSIUM',
  'SODIUM',
  'THIAMIN',
  'RIBOFLAVIN',
  'VITAMIN_B6',
  'VITAMIN_C',
  'VITAMIN_E',
  'ZINC',
]);

/** The one UI/AI display unit permitted for a current nutrient code. */
export function mealAiNutrientUnit(nutrientCode: string): NutritionUnit {
  if (nutrientCode === 'ENERGY') return 'kcal';
  if (MICROGRAM_NUTRIENTS.has(nutrientCode)) return 'μg';
  if (MILLIGRAM_NUTRIENTS.has(nutrientCode)) return 'mg';
  return 'g';
}

/**
 * Applying a replacement recalculates all nutrients for that dish, so it
 * cannot be combined with another replacement or a nutrient override there.
 */
export function hasMealAiSuggestionConflict(suggestions: readonly MealAiSuggestion[]): boolean {
  const byDish = new Map<string, { hasReplacement: boolean; nutrientCodes: Set<string> }>();
  for (const suggestion of suggestions) {
    const state = byDish.get(suggestion.dishId) ?? { hasReplacement: false, nutrientCodes: new Set<string>() };
    if (suggestion.kind === 'replace_ingredients') {
      if (state.hasReplacement || state.nutrientCodes.size > 0) return true;
      state.hasReplacement = true;
    } else {
      if (state.hasReplacement || state.nutrientCodes.has(suggestion.nutrientCode)) return true;
      state.nutrientCodes.add(suggestion.nutrientCode);
    }
    byDish.set(suggestion.dishId, state);
  }
  return false;
}
