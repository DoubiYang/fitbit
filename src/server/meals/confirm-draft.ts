import { randomUUID } from 'node:crypto';

import { dishesReadyToConfirm } from '../../domain/meal-confirm';
import { isPortionRange } from '../../domain/meal-vision';
import type { GoogleFoodCatalog } from './google-food';
import { resolveDishIngredients, type ResolvedDish } from './ingredient-nutrition';
import { factsFromResolvedDish } from './meal-nutrients';
import type { ConfirmMealInput, ConfirmMealResult, MealDishRow, MealDraftRow, MealIngredientRow, MealNutrientRow, OutboxRow } from './types';

export function nutritionDataPointName(shortId: string): string {
  return `users/me/dataTypes/nutrition-log/dataPoints/${shortId}`;
}

export async function resolveDraftNutrition(
  draft: MealDraftRow,
  catalog: GoogleFoodCatalog | undefined,
): Promise<ResolvedDish[]> {
  if (!catalog) {
    return [];
  }
  return Promise.all(draft.vision.foods.map((food) => resolveDishIngredients(food, catalog)));
}

export function confirmDraftRows(
  draft: MealDraftRow,
  input: ConfirmMealInput,
  writebackEnabled: boolean,
  resolvedDishes: ResolvedDish[] = [],
): ConfirmMealResult {
  const ready = dishesReadyToConfirm(draft.vision.foods);
  if (!ready.ok) {
    return ready;
  }
  if (resolvedDishes.length > 0 && resolvedDishes.length !== draft.vision.foods.length) {
    return { ok: false, reason: '营养解析与菜数量不一致' };
  }
  const writePending =
    writebackEnabled && input.writebackThisMeal && input.canWriteNutrition && input.connectionSyncable;
  const versionId = randomUUID();
  const dishes: MealDishRow[] = [];
  const ingredients: MealIngredientRow[] = [];
  const nutrients: MealNutrientRow[] = [];
  const outbox: OutboxRow[] = [];
  for (const [index, food] of draft.vision.foods.entries()) {
    if (isPortionRange(food.portionGrams)) {
      return { ok: false, reason: '每道留下的菜都需要确认点值克数' };
    }
    const dishId = randomUUID();
    const shortId = `d-${randomUUID()}`;
    const source = food.labelText ? 'label_confirmed' : 'user_confirmed';
    dishes.push({
      id: dishId,
      versionId,
      userId: draft.userId,
      clientShortId: shortId,
      nameZh: food.nameZh,
      portionGrams: food.portionGrams,
      source,
    });
    const resolved = resolvedDishes[index];
    if (resolved) {
      const facts = factsFromResolvedDish({
        dishId,
        userId: draft.userId,
        source,
        resolved,
      });
      ingredients.push(...facts.ingredients);
      nutrients.push(...facts.nutrients);
    }
    outbox.push({
      id: randomUUID(),
      userId: draft.userId,
      dishId,
      operation: 'create',
      dataPointName: nutritionDataPointName(shortId),
      payloadHash: undefined,
      status: writePending ? 'write_pending' : 'local_only',
    });
  }
  return {
    ok: true,
    version: {
      id: versionId,
      userId: draft.userId,
      previousVersionId: undefined,
      mealType: draft.mealType,
      eatenAt: draft.eatenAt,
      writebackThisMeal: input.writebackThisMeal,
      confirmedAt: input.now,
    },
    dishes,
    ingredients,
    nutrients,
    outbox,
  };
}
