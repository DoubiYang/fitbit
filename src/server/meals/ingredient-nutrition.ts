import { isPortionRange, type VisionDish } from '../../domain/meal-vision';
import { pickBestHit, type GoogleFoodCatalog, type GoogleFoodHit } from './google-food';
import { allocateIngredientGrams } from './ingredient-grams';

const ALIASES: Record<string, string[]> = {
  牛肉: ['beef', 'beef cooked'],
  酱油: ['soy sauce'],
  芝麻: ['sesame seeds'],
  香草: ['欧芹', 'parsley'],
  大蒜: ['蒜头', 'garlic'],
  香菜: ['cilantro', 'coriander'],
  青菜: ['bok choy', 'chinese cabbage'],
  油: ['食用油', 'vegetable oil', 'cooking oil'],
  食用油: ['vegetable oil', 'cooking oil'],
  蒜: ['蒜头', 'garlic'],
  西兰花: ['broccoli'],
  南瓜: ['pumpkin cooked', 'squash'],
  胡萝卜: ['carrot'],
  土豆: ['potato cooked'],
  红椒: ['red bell pepper'],
  彩椒: ['bell pepper'],
  稻米: ['rice cooked'],
  鸡蛋: ['egg'],
  番茄: ['tomato'],
  豆腐: ['tofu'],
  盐: ['salt'],
  姜: ['ginger'],
  葱: ['green onion', 'scallion'],
  醋: ['vinegar'],
  糖: ['sugar'],
};

export type ResolvedIngredient = {
  nameZh: string;
  grams: number;
  matchedDisplayName: string | undefined;
  foodName: string | undefined;
  energyKcal: number | undefined;
  proteinGrams: number | undefined;
  carbGrams: number | undefined;
  fatGrams: number | undefined;
  nutrients: Record<string, number>;
};

export type ResolvedDish = {
  dishNameZh: string;
  dishGrams: number;
  needsConfirmation: string[];
  ingredients: ResolvedIngredient[];
  totals: {
    energyKcal: number | undefined;
    proteinGrams: number | undefined;
    carbGrams: number | undefined;
    fatGrams: number | undefined;
    nutrients: Record<string, number>;
  };
};

function dishGrams(dish: VisionDish): number {
  if (isPortionRange(dish.portionGrams)) {
    return (dish.portionGrams.min + dish.portionGrams.max) / 2;
  }
  return dish.portionGrams * (dish.eatFraction ?? 1);
}

function scale(value: number | undefined, grams: number, servingGrams: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const serving = servingGrams && servingGrams > 0 ? servingGrams : 100;
  return (value * grams) / serving;
}

function add(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  return (left ?? 0) + (right ?? 0);
}

function scaleNutrients(nutrients: Record<string, number> | undefined, grams: number, servingGrams: number | undefined): Record<string, number> {
  const scaled: Record<string, number> = {};
  for (const [code, value] of Object.entries(nutrients ?? {})) {
    const next = scale(value, grams, servingGrams);
    if (next !== undefined) {
      scaled[code] = next;
    }
  }
  return scaled;
}

function mergeNutrients(into: Record<string, number>, addend: Record<string, number>): Record<string, number> {
  const merged = { ...into };
  for (const [code, value] of Object.entries(addend)) {
    merged[code] = (merged[code] ?? 0) + value;
  }
  return merged;
}

function queriesFor(nameZh: string): string[] {
  const aliases = ALIASES[nameZh] ?? [];
  if (nameZh.length <= 1) {
    return [...aliases, nameZh];
  }
  return [nameZh, ...aliases];
}

async function matchFood(catalog: GoogleFoodCatalog, nameZh: string): Promise<GoogleFoodHit | undefined> {
  const queries = queriesFor(nameZh);
  for (const query of queries) {
    const hits = await catalog.search(query);
    const best = pickBestHit(query, hits);
    if (best) {
      return best;
    }
  }
  return undefined;
}

export async function resolveDishIngredients(dish: VisionDish, catalog: GoogleFoodCatalog): Promise<ResolvedDish> {
  const grams = dishGrams(dish);
  const allocated = allocateIngredientGrams(dish.ingredients, grams);
  const ingredients: ResolvedIngredient[] = [];
  for (const part of allocated) {
    const hit = await matchFood(catalog, part.nameZh);
    ingredients.push({
      nameZh: part.nameZh,
      grams: part.grams,
      matchedDisplayName: hit?.displayName,
      foodName: hit?.name,
      energyKcal: scale(hit?.energyKcal, part.grams, hit?.servingGrams),
      proteinGrams: scale(hit?.proteinGrams, part.grams, hit?.servingGrams),
      carbGrams: scale(hit?.carbGrams, part.grams, hit?.servingGrams),
      fatGrams: scale(hit?.fatGrams, part.grams, hit?.servingGrams),
      nutrients: scaleNutrients(hit?.nutrients, part.grams, hit?.servingGrams),
    });
  }
  return {
    dishNameZh: dish.nameZh,
    dishGrams: grams,
    needsConfirmation: dish.needsConfirmation,
    ingredients,
    totals: {
      energyKcal: ingredients.reduce((sum, item) => add(sum, item.energyKcal), undefined as number | undefined),
      proteinGrams: ingredients.reduce((sum, item) => add(sum, item.proteinGrams), undefined as number | undefined),
      carbGrams: ingredients.reduce((sum, item) => add(sum, item.carbGrams), undefined as number | undefined),
      fatGrams: ingredients.reduce((sum, item) => add(sum, item.fatGrams), undefined as number | undefined),
      nutrients: ingredients.reduce((sum, item) => mergeNutrients(sum, item.nutrients), {} as Record<string, number>),
    },
  };
}
