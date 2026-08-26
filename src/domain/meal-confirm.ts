import { isPortionRange, parseVisionMeal, type VisionDish } from './meal-vision';

export { parseVisionMeal } from './meal-vision';
export type { VisionDish, VisionMeal } from './meal-vision';

export type ConfirmReady = { ok: true } | { ok: false; reason: string };

export function dishesReadyToConfirm(dishes: VisionDish[]): ConfirmReady {
  if (dishes.length === 0) {
    return { ok: false, reason: '至少保留一道菜再确认' };
  }
  for (const dish of dishes) {
    if (isPortionRange(dish.portionGrams)) {
      return { ok: false, reason: '每道留下的菜都需要确认点值克数' };
    }
    if (dish.needsConfirmation.length > 0) {
      return { ok: false, reason: '还有未确认项，不能保存' };
    }
    if (dish.eatFraction === undefined) {
      return { ok: false, reason: '每道留下的菜都需要确认食用比例' };
    }
  }
  return { ok: true };
}
