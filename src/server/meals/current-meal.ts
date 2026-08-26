import {
  editableMealDraftSchema,
  fromInternalNutrientAmount,
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
import { resolveEditableTwFdaDishIngredients, type TwFdaFoodCatalog } from '../nutrition/tw-fda';
import type { ResolvedDish } from './ingredient-nutrition';

const GOOGLE_SUPPORTED_NUTRIENTS = new Set([
  'ENERGY',
  'BIOTIN',
  'CAFFEINE',
  'CALCIUM',
  'CHLORIDE',
  'CARBOHYDRATES',
  'CHOLESTEROL',
  'CHROMIUM',
  'COPPER',
  'DIETARY_FIBER',
  'FOLIC_ACID',
  'FOLATE',
  'IODINE',
  'IRON',
  'MAGNESIUM',
  'MANGANESE',
  'MOLYBDENUM',
  'MONOUNSATURATED_FAT',
  'NIACIN',
  'PANTOTHENIC_ACID',
  'PHOSPHORUS',
  'POLYUNSATURATED_FAT',
  'POTASSIUM',
  'PROTEIN',
  'RIBOFLAVIN',
  'SATURATED_FAT',
  'SELENIUM',
  'SODIUM',
  'SUGAR',
  'THIAMIN',
  'TRANS_FAT',
  'UNSATURATED_FAT',
  'VITAMIN_A',
  'VITAMIN_B12',
  'VITAMIN_B6',
  'VITAMIN_C',
  'VITAMIN_D',
  'VITAMIN_E',
  'VITAMIN_K',
  'ZINC',
]);

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

function initialDishGrams(dish: VisionMeal['foods'][number]): number {
  if (isPortionRange(dish.portionGrams)) {
    return (dish.portionGrams.min + dish.portionGrams.max) / 2;
  }
  return dish.portionGrams * (dish.eatFraction ?? 1);
}

function nutrientsFromResolvedDish(dishId: string, resolved: ResolvedDish): EditableNutrient[] {
  const nutrients: EditableNutrient[] = [];
  if (resolved.totals.energyKcal !== undefined) {
    nutrients.push({ dishId, nutrientCode: 'ENERGY', value: resolved.totals.energyKcal, unit: 'kcal' });
  }
  for (const [nutrientCode, value] of Object.entries(resolved.totals.nutrients)) {
    nutrients.push({ dishId, nutrientCode, value, unit: 'g' });
  }
  return nutrients;
}

async function resolveEditableDish(dish: EditableDish, catalog: TwFdaFoodCatalog): Promise<EditableNutrient[]> {
  const resolved = await resolveEditableTwFdaDishIngredients(dish, catalog);
  return nutrientsFromResolvedDish(dish.id, resolved);
}

function assertDishExists(draft: EditableMealDraft, dishId: string): void {
  if (!draft.dishes.some((dish) => dish.id === dishId)) {
    throw new Error(`unknown dish: ${dishId}`);
  }
}

export async function draftFromVision(input: DraftFromVisionInput, catalog: TwFdaFoodCatalog): Promise<EditableMealDraft> {
  const dishes = input.vision.foods.map((visionDish, index): EditableDish => {
    const portionGrams = initialDishGrams(visionDish);
    return {
      id: `dish:${index}`,
      nameZh: visionDish.nameZh,
      ingredients: allocateIngredientGrams(visionDish.ingredients, portionGrams),
      portionGrams,
    };
  });
  const nutrients = (await Promise.all(dishes.map((dish) => resolveEditableDish(dish, catalog)))).flat();
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
  assertDishExists(draft, patch.dishId);
  const portionGrams = patch.ingredients.reduce((total, ingredient) => total + ingredient.grams, 0);
  const replacement: EditableDish = {
    id: patch.dishId,
    nameZh: patch.nameZh,
    ingredients: patch.ingredients,
    portionGrams,
  };
  const nutrients = await resolveEditableDish(replacement, catalog);
  return editableMealDraftSchema.parse({
    ...draft,
    dishes: draft.dishes.map((dish) => dish.id === patch.dishId ? replacement : dish),
    nutrients: [...draft.nutrients.filter((nutrient) => nutrient.dishId !== patch.dishId), ...nutrients],
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
  const replacement = fromInternalNutrientAmount(validatedPatch.nutrientCode, internal.value, validatedPatch.unit);
  return editableMealDraftSchema.parse({
    ...draft,
    nutrients: draft.nutrients.map((nutrient) => (
      nutrient === existing ? { ...nutrient, value: replacement.value, unit: replacement.unit } : nutrient
    )),
  });
}

export function googlePayloadProjection(draft: EditableMealDraft): GooglePayloadProjection {
  return {
    dishes: draft.dishes.map((dish) => ({ ...dish, ingredients: dish.ingredients.map((ingredient) => ({ ...ingredient })) })),
    nutrients: draft.nutrients
      .filter((nutrient) => GOOGLE_SUPPORTED_NUTRIENTS.has(nutrient.nutrientCode))
      .map((nutrient) => ({ ...nutrient })),
  };
}
