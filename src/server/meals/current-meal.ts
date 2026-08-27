import { randomUUID } from 'node:crypto';

import {
  editableMealDraftSchema,
  replaceIngredientsPatchSchema,
  setNutrientPatchSchema,
  toInternalNutrientAmount,
  type EditableDish,
  type EditableMealDraft,
  type EditableNutrient,
  type ReplaceIngredientsPatch,
  type SetNutrientPatch,
} from '../../domain/meal-editor';
import { isPortionRange, type VisionMeal } from '../../domain/meal-vision';
import { allocateIngredientGrams } from './ingredient-grams';
import { buildGoogleNutritionDataPoint, isGoogleSupportedNutrient, type GoogleNutritionDataPoint } from './google-nutrition';
import { resolveEditableTwFdaDishIngredients, type EditableTwFdaDish, type TwFdaFoodCatalog } from '../nutrition/tw-fda';
import type { ResolvedDish } from './ingredient-nutrition';
import type { CurrentMealSnapshot, MealDishRow, MealNutrientRow, MealVersionRow } from './types';

export type DraftFromVisionInput = {
  mealId: string;
  mealType: string;
  eatenAt: string;
  vision: VisionMeal;
};

export type GooglePayloadProjection = {
  dishes: EditableDish[];
  nutrients: EditableNutrient[];
};

/** A generation freezes this payload before any Google request can be made. */
export type CurrentMealGooglePayload = {
  dishKey: string;
  dataPoint: GoogleNutritionDataPoint;
  payloadHash: string;
};

function initialDishGrams(dish: VisionMeal['foods'][number]): number {
  if (isPortionRange(dish.portionGrams)) {
    return (dish.portionGrams.min + dish.portionGrams.max) / 2;
  }
  return dish.portionGrams * (dish.eatFraction ?? 1);
}

function nutrientsFromResolvedDish(dishId: string, resolved: ResolvedDish): EditableNutrient[] {
  const nutrients: EditableNutrient[] = [];
  if (resolved.totals.energyKcal !== undefined) {
    nutrients.push({ dishId, nutrientCode: 'ENERGY', value: resolved.totals.energyKcal, unit: 'kcal', source: 'tw_fda' });
  }
  for (const [nutrientCode, value] of Object.entries(resolved.totals.nutrients)) {
    nutrients.push({ dishId, nutrientCode, value, unit: 'g', source: 'tw_fda' });
  }
  return nutrients;
}

type EditableDishForResolution = Pick<EditableDish, 'id' | 'nameZh' | 'portionGrams'> & EditableTwFdaDish;

async function resolveEditableDish(
  dish: EditableDishForResolution,
  catalog: TwFdaFoodCatalog,
): Promise<{ dish: EditableDish; nutrients: EditableNutrient[] }> {
  const resolved = await resolveEditableTwFdaDishIngredients(dish, catalog);
  const ingredients = resolved.ingredients.map((ingredient) => {
    if (!ingredient.foodSource) throw new Error(`resolver did not provide provenance for ${ingredient.nameZh}`);
    return {
      nameZh: ingredient.nameZh,
      grams: ingredient.grams,
      foodSource: ingredient.foodSource,
      foodSourceId: ingredient.foodName,
      foodSourceVersion: ingredient.foodSourceVersion,
    };
  });
  return {
    dish: { ...dish, ingredients },
    nutrients: nutrientsFromResolvedDish(dish.id, resolved),
  };
}

function assertDishExists(draft: EditableMealDraft, dishId: string): void {
  if (!draft.dishes.some((dish) => dish.id === dishId)) {
    throw new Error(`unknown dish: ${dishId}`);
  }
}

export async function draftFromVision(input: DraftFromVisionInput, catalog: TwFdaFoodCatalog): Promise<EditableMealDraft> {
  const initialDishes = input.vision.foods.map((visionDish): EditableDishForResolution => {
    const portionGrams = initialDishGrams(visionDish);
    return {
      id: randomUUID(),
      nameZh: visionDish.nameZh,
      ingredients: allocateIngredientGrams(visionDish.ingredients, portionGrams),
      portionGrams,
    };
  });
  const resolvedDishes = await Promise.all(initialDishes.map((dish) => resolveEditableDish(dish, catalog)));
  const dishes = resolvedDishes.map((resolved) => resolved.dish);
  const nutrients = resolvedDishes.flatMap((resolved) => resolved.nutrients);
  return editableMealDraftSchema.parse({
    view: 'draft',
    mealId: input.mealId,
    mealType: input.mealType,
    eatenAt: input.eatenAt,
    dishes,
    nutrients,
  });
}

export async function replaceDishIngredients(
  draft: EditableMealDraft,
  patch: ReplaceIngredientsPatch,
  catalog: TwFdaFoodCatalog,
): Promise<EditableMealDraft> {
  const validatedPatch = replaceIngredientsPatchSchema.parse(patch);
  assertDishExists(draft, validatedPatch.dishId);
  const portionGrams = validatedPatch.ingredients.reduce((total, ingredient) => total + ingredient.grams, 0);
  const replacement: EditableDishForResolution = {
    id: validatedPatch.dishId,
    nameZh: validatedPatch.nameZh,
    ingredients: validatedPatch.ingredients,
    portionGrams,
  };
  const resolved = await resolveEditableDish(replacement, catalog);
  return editableMealDraftSchema.parse({
    ...draft,
    dishes: draft.dishes.map((dish) => dish.id === validatedPatch.dishId ? resolved.dish : dish),
    nutrients: [...draft.nutrients.filter((nutrient) => nutrient.dishId !== validatedPatch.dishId), ...resolved.nutrients],
  });
}

export function setDishNutrient(draft: EditableMealDraft, patch: SetNutrientPatch): EditableMealDraft {
  const validatedPatch = setNutrientPatchSchema.parse(patch);
  assertDishExists(draft, validatedPatch.dishId);
  const existing = draft.nutrients.find((nutrient) => (
    nutrient.dishId === validatedPatch.dishId && nutrient.nutrientCode === validatedPatch.nutrientCode
  ));
  if (!existing) {
    throw new Error(`unknown nutrient: ${validatedPatch.nutrientCode}`);
  }
  const internal = toInternalNutrientAmount(validatedPatch.nutrientCode, validatedPatch.value, validatedPatch.unit);
  return editableMealDraftSchema.parse({
    ...draft,
    nutrients: draft.nutrients.map((nutrient) => (
      nutrient === existing ? { ...nutrient, value: internal.value, unit: internal.unit, source: 'user_edit' } : nutrient
    )),
  });
}

export function googlePayloadProjection(draft: EditableMealDraft): GooglePayloadProjection {
  return {
    dishes: draft.dishes.map((dish) => ({ ...dish, ingredients: dish.ingredients.map((ingredient) => ({ ...ingredient })) })),
    nutrients: draft.nutrients
      .filter((nutrient) => isGoogleSupportedNutrient(nutrient.nutrientCode))
      .map((nutrient) => ({ ...nutrient })),
  };
}

/**
 * Builds one write-once Google data point per currently writable dish.  The
 * caller supplies a fresh data-point suffix so this function remains pure and
 * the generated payload can be persisted before a worker sees it.
 */
export function buildCurrentMealGooglePayloads(input: {
  meal: CurrentMealSnapshot;
  dataPointIdForDish(dishId: string): string;
}): CurrentMealGooglePayload[] {
  const version: MealVersionRow = {
    id: input.meal.id,
    userId: input.meal.userId,
    previousVersionId: undefined,
    mealType: input.meal.mealType,
    eatenAt: input.meal.eatenAt,
    writebackThisMeal: true,
    confirmedAt: input.meal.updatedAt,
  };
  return input.meal.dishes.flatMap((dish): CurrentMealGooglePayload[] => {
    const legacyDish: MealDishRow = {
      id: dish.id,
      versionId: input.meal.id,
      userId: input.meal.userId,
      clientShortId: input.dataPointIdForDish(dish.id),
      nameZh: dish.nameZh,
      portionGrams: dish.portionGrams,
      source: 'current_meal',
    };
    const nutrients: MealNutrientRow[] = input.meal.nutrients
      .filter((nutrient) => nutrient.dishId === dish.id)
      .map((nutrient) => {
        const amount = toInternalNutrientAmount(nutrient.nutrientCode, nutrient.value, nutrient.unit);
        return {
          dishId: dish.id,
          userId: input.meal.userId,
          nutrientCode: nutrient.nutrientCode,
          grams: amount.unit === 'g' ? amount.value : undefined,
          kcal: amount.unit === 'kcal' ? amount.value : undefined,
          source: nutrient.source,
          confidence: undefined,
        };
      });
    const built = buildGoogleNutritionDataPoint({ dish: legacyDish, version, nutrients });
    return built ? [{ dishKey: dish.id, dataPoint: built.dataPoint, payloadHash: built.payloadHash }] : [];
  });
}
