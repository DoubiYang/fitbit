import { z } from 'zod';

export const nutritionUnitSchema = z.enum(['kcal', 'g', 'mg', 'μg']);
export type NutritionUnit = z.infer<typeof nutritionUnitSchema>;

const positiveFiniteNumber = z.number().finite().gt(0);
const nonNegativeFiniteNumber = z.number().finite().gte(0);

export const editableIngredientSchema = z.object({
  nameZh: z.string().trim().min(1).max(80),
  grams: positiveFiniteNumber,
});

export const editableDishSchema = z.object({
  id: z.string().trim().min(1).max(120),
  nameZh: z.string().trim().min(1).max(120),
  ingredients: z.array(editableIngredientSchema).min(1).max(40),
  portionGrams: positiveFiniteNumber,
});

export const editableNutrientSchema = z
  .object({
    dishId: z.string().trim().min(1).max(120),
    nutrientCode: z.string().trim().min(1).max(120),
    value: nonNegativeFiniteNumber,
    unit: nutritionUnitSchema,
  })
  .superRefine((nutrient, context) => {
    const isEnergy = nutrient.nutrientCode === 'ENERGY';
    if (isEnergy && nutrient.unit !== 'kcal') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'ENERGY must use kcal' });
    }
    if (!isEnergy && nutrient.unit === 'kcal') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'non-ENERGY nutrients must use a mass unit' });
    }
  });

export type EditableIngredient = z.infer<typeof editableIngredientSchema>;
export type EditableDish = z.infer<typeof editableDishSchema>;
export type EditableNutrient = z.infer<typeof editableNutrientSchema>;

export const replaceIngredientsPatchSchema = z.object({
  kind: z.literal('replace_ingredients'),
  dishId: z.string().trim().min(1).max(120),
  nameZh: z.string().trim().min(1).max(120),
  ingredients: z.array(editableIngredientSchema).min(1).max(40),
}).strict();

export const setNutrientPatchSchema = z
  .object({
    kind: z.literal('set_nutrient'),
    dishId: z.string().trim().min(1).max(120),
    nutrientCode: z.string().trim().min(1).max(120),
    value: nonNegativeFiniteNumber,
    unit: nutritionUnitSchema,
  })
  .strict()
  .superRefine((patch, context) => {
    const isEnergy = patch.nutrientCode === 'ENERGY';
    if (isEnergy && patch.unit !== 'kcal') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'ENERGY must use kcal' });
    }
    if (!isEnergy && patch.unit === 'kcal') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'non-ENERGY nutrients must use a mass unit' });
    }
  });

export const mealPatchSchema = z.discriminatedUnion('kind', [replaceIngredientsPatchSchema, setNutrientPatchSchema]);
export type ReplaceIngredientsPatch = z.infer<typeof replaceIngredientsPatchSchema>;
export type SetNutrientPatch = z.infer<typeof setNutrientPatchSchema>;
export type MealPatch = z.infer<typeof mealPatchSchema>;

const editableMealViewFields = {
  mealId: z.string().trim().min(1).max(120),
  mealType: z.string().trim().min(1).max(40),
  eatenAt: z.string().datetime({ offset: true }),
  dishes: z.array(editableDishSchema).max(20),
  nutrients: z.array(editableNutrientSchema).max(200),
};

export const editableMealDraftSchema = z.object({
  ...editableMealViewFields,
  view: z.literal('draft'),
}).strict();

export const editableMealSavedSchema = z.object({
  ...editableMealViewFields,
  view: z.literal('saved'),
  savedAt: z.string().datetime({ offset: true }),
}).strict();

export type EditableMealDraft = z.infer<typeof editableMealDraftSchema>;
export type EditableMealSaved = z.infer<typeof editableMealSavedSchema>;

const MASS_FACTORS: Record<'g' | 'mg' | 'μg', number> = { g: 1, mg: 1_000, 'μg': 1_000_000 };

function assertNutrientUnit(nutrientCode: string, unit: NutritionUnit): void {
  if (nutrientCode === 'ENERGY' ? unit !== 'kcal' : unit === 'kcal') {
    throw new Error(nutrientCode === 'ENERGY' ? 'ENERGY must use kcal' : 'non-ENERGY nutrients must use a mass unit');
  }
}

export type NutrientAmount = { nutrientCode: string; value: number; unit: NutritionUnit };
export type InternalNutrientAmount = { nutrientCode: string; value: number; unit: 'kcal' | 'g' };

export function toInternalNutrientAmount(nutrientCode: string, value: number, unit: NutritionUnit): InternalNutrientAmount {
  if (!Number.isFinite(value) || value < 0) throw new Error('nutrient value must be finite and non-negative');
  assertNutrientUnit(nutrientCode, unit);
  return { nutrientCode, value: unit === 'kcal' ? value : value / MASS_FACTORS[unit], unit: unit === 'kcal' ? 'kcal' : 'g' };
}

export function fromInternalNutrientAmount(
  nutrientCode: string,
  value: number,
  displayUnit: NutritionUnit,
): NutrientAmount {
  if (!Number.isFinite(value) || value < 0) throw new Error('nutrient value must be finite and non-negative');
  assertNutrientUnit(nutrientCode, displayUnit === 'kcal' ? 'kcal' : displayUnit);
  if (nutrientCode === 'ENERGY') return { nutrientCode, value, unit: 'kcal' };
  if (displayUnit === 'kcal') throw new Error('non-ENERGY nutrients must use a mass unit');
  return { nutrientCode, value: value * MASS_FACTORS[displayUnit], unit: displayUnit };
}

export const mealDraftSchema = editableMealDraftSchema;
export const mealSavedSchema = editableMealSavedSchema;
