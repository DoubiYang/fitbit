import { randomUUID } from 'node:crypto';

import { dishesReadyToConfirm } from '../../domain/meal-confirm';
import { isPortionRange } from '../../domain/meal-vision';
import type { ConfirmMealInput, ConfirmMealResult, MealDishRow, MealDraftRow, OutboxRow } from './types';

export function nutritionDataPointName(shortId: string): string {
  return `users/me/dataTypes/nutrition-log/dataPoints/${shortId}`;
}

export function confirmDraftRows(
  draft: MealDraftRow,
  input: ConfirmMealInput,
  writebackEnabled: boolean,
): ConfirmMealResult {
  const ready = dishesReadyToConfirm(draft.vision.foods);
  if (!ready.ok) {
    return ready;
  }
  const writePending =
    writebackEnabled && input.writebackThisMeal && input.canWriteNutrition && input.connectionSyncable;
  const versionId = randomUUID();
  const dishes: MealDishRow[] = [];
  const outbox: OutboxRow[] = [];
  for (const food of draft.vision.foods) {
    if (isPortionRange(food.portionGrams)) {
      return { ok: false, reason: '每道留下的菜都需要确认点值克数' };
    }
    const dishId = randomUUID();
    const shortId = `d-${randomUUID()}`;
    dishes.push({
      id: dishId,
      versionId,
      userId: draft.userId,
      clientShortId: shortId,
      nameZh: food.nameZh,
      portionGrams: food.portionGrams,
      source: food.labelText ? 'label_confirmed' : 'user_confirmed',
    });
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
    outbox,
  };
}
