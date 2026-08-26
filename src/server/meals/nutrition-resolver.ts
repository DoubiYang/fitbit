import { isPortionRange, type VisionDish } from '../../domain/meal-vision';
import { lookupFood } from './food-database';

export type NutrientAmount = { code: string; grams?: number; kcal?: number };

export type DishNutrition = {
  energyKcal: number | undefined;
  nutrients: NutrientAmount[];
  reason?: 'needs_confirmation' | 'unmatched' | 'wide_range';
};

function scale(per100g: number, grams: number): number {
  return (per100g * grams) / 100;
}

function compose(dish: VisionDish, grams: number): DishNutrition {
  const unmatched = dish.ingredients.filter((name) => !lookupFood(name));
  if (unmatched.length === dish.ingredients.length) {
    return { energyKcal: undefined, nutrients: [], reason: 'unmatched' };
  }
  const share = grams / dish.ingredients.length;
  let energyKcal = 0;
  let protein = 0;
  let carbs = 0;
  let fat = 0;
  for (const name of dish.ingredients) {
    const food = lookupFood(name);
    if (!food) {
      continue;
    }
    energyKcal += scale(food.per100g.energyKcal, share);
    protein += scale(food.per100g.proteinGrams, share);
    carbs += scale(food.per100g.carbGrams, share);
    fat += scale(food.per100g.fatGrams, share);
  }
  return {
    energyKcal,
    nutrients: [
      { code: 'PROTEIN', grams: protein },
      { code: 'CARBOHYDRATES', grams: carbs },
      { code: 'FAT', grams: fat },
    ],
  };
}

export function estimateDish(dish: VisionDish): DishNutrition {
  if (dish.needsConfirmation.length > 0) {
    return { energyKcal: undefined, nutrients: [], reason: 'needs_confirmation' };
  }
  if (isPortionRange(dish.portionGrams)) {
    const width = dish.portionGrams.max - dish.portionGrams.min;
    const mid = (dish.portionGrams.min + dish.portionGrams.max) / 2;
    if (mid > 0 && width / mid > 1) {
      return { energyKcal: undefined, nutrients: [], reason: 'wide_range' };
    }
    return compose(dish, mid);
  }
  return compose(dish, dish.portionGrams * (dish.eatFraction ?? 1));
}

export function finalizeDish(dish: VisionDish, _ignored?: { claimedEnergyKcal?: number }): DishNutrition {
  if (dish.needsConfirmation.length > 0 || isPortionRange(dish.portionGrams) || dish.eatFraction === undefined) {
    return { energyKcal: undefined, nutrients: [], reason: 'needs_confirmation' };
  }
  return compose(dish, dish.portionGrams * dish.eatFraction);
}
