import { isPortionRange, type VisionDish } from '../../domain/meal-vision';
import { allocateIngredientGrams } from '../meals/ingredient-grams';
import type { ResolvedDish } from '../meals/ingredient-nutrition';

export type TwFdaNutrientFact = {
  officialName: string;
  rawUnit: string;
  per100gValue: number;
};

export type LocalTwFdaFood = {
  sourceRevision: string;
  officialFoodId: string;
  nameZh: string;
  aliases: string[];
  nutrients: TwFdaNutrientFact[];
};

export type TwFdaFoodCatalog = {
  findExact(nameZh: string): Promise<LocalTwFdaFood | undefined>;
};

export type MappedTwFdaNutrient =
  | { nutrientCode: 'ENERGY'; kcalPer100g: number }
  | {
      nutrientCode: string;
      gramsPer100g: number;
      /**
       * Several Taiwan FDA fields describe one Google nutrient. Keep every
       * source fact locally, but only sum the highest-priority representation
       * into a Google-compatible total so that totals and components are never
       * double-counted.
       */
      selectionPriority?: number;
    };

const SIMPLIFIED_TO_TRADITIONAL: Record<string, string> = {
  兰: '蘭',
  鸡: '雞',
  鸭: '鴨',
  鱼: '魚',
  虾: '蝦',
  贝: '貝',
  猪: '豬',
  牛: '牛',
  麦: '麥',
  面: '麵',
  叶: '葉',
  菜: '菜',
  萝: '蘿',
  卜: '蔔',
  姜: '薑',
  葱: '蔥',
  蒜: '蒜',
  干: '乾',
  豆: '豆',
  米: '米',
  蛋: '蛋',
  肉: '肉',
  酱: '醬',
  盐: '鹽',
  糖: '糖',
  油: '油',
  绿: '綠',
  红: '紅',
  黄: '黃',
  西: '西',
  南: '南',
  东: '東',
  北: '北',
  台: '臺',
};

type GoogleNutrientMapping = {
  nutrientCode: string;
  selectionPriority?: number;
};

const GOOGLE_NUTRIENT_CODES: Record<string, GoogleNutrientMapping> = {
  '粗蛋白': { nutrientCode: 'PROTEIN' },
  '總碳水化合物': { nutrientCode: 'CARBOHYDRATES' },
  '粗脂肪': { nutrientCode: 'FAT' },
  '飽和脂肪': { nutrientCode: 'SATURATED_FAT' },
  '反式脂肪': { nutrientCode: 'TRANS_FAT' },
  '脂肪酸M總量': { nutrientCode: 'MONOUNSATURATED_FAT' },
  '脂肪酸P總量': { nutrientCode: 'POLYUNSATURATED_FAT' },
  '膽固醇': { nutrientCode: 'CHOLESTEROL' },
  '膳食纖維': { nutrientCode: 'DIETARY_FIBER' },
  '維生素B1': { nutrientCode: 'THIAMIN' },
  '維生素B2': { nutrientCode: 'RIBOFLAVIN' },
  '維生素B6': { nutrientCode: 'VITAMIN_B6' },
  '維生素B12': { nutrientCode: 'VITAMIN_B12' },
  '維生素C': { nutrientCode: 'VITAMIN_C' },
  // Prefer FDA equivalents/totals over their constituent fields. Equal-priority
  // components (D2 + D3) and K forms intentionally sum when no total exists.
  '視網醇': { nutrientCode: 'VITAMIN_A', selectionPriority: 1 },
  '視網醇當量(RE)': { nutrientCode: 'VITAMIN_A', selectionPriority: 2 },
  '維生素D2': { nutrientCode: 'VITAMIN_D', selectionPriority: 1 },
  '維生素D3': { nutrientCode: 'VITAMIN_D', selectionPriority: 1 },
  '維生素D總量(ug)': { nutrientCode: 'VITAMIN_D', selectionPriority: 2 },
  'α-生育酚': { nutrientCode: 'VITAMIN_E', selectionPriority: 1 },
  '維生素E總量': { nutrientCode: 'VITAMIN_E', selectionPriority: 2 },
  'α-維生素E當量(α-TE)': { nutrientCode: 'VITAMIN_E', selectionPriority: 3 },
  '維生素K1': { nutrientCode: 'VITAMIN_K', selectionPriority: 1 },
  '維生素K2(MK-4)': { nutrientCode: 'VITAMIN_K', selectionPriority: 1 },
  '維生素K2(MK-7)': { nutrientCode: 'VITAMIN_K', selectionPriority: 1 },
  '葉酸': { nutrientCode: 'FOLATE' },
  '菸鹼素': { nutrientCode: 'NIACIN' },
  '鈉': { nutrientCode: 'SODIUM' },
  '鉀': { nutrientCode: 'POTASSIUM' },
  '鈣': { nutrientCode: 'CALCIUM' },
  '鎂': { nutrientCode: 'MAGNESIUM' },
  '磷': { nutrientCode: 'PHOSPHORUS' },
  '鐵': { nutrientCode: 'IRON' },
  '鋅': { nutrientCode: 'ZINC' },
  '銅': { nutrientCode: 'COPPER' },
  '錳': { nutrientCode: 'MANGANESE' },
};

const CURATED_EXACT_ALIAS_TARGETS: Record<string, string[]> = {
  西蘭花: ['青花菜(2021年取樣)'],
};

export function normalizeTwFdaFoodName(value: string): string {
  return [...value.trim().toLowerCase()]
    .map((character) => SIMPLIFIED_TO_TRADITIONAL[character] ?? character)
    .join('')
    .replace(/[\s\-_/()（）]/gu, '');
}

export function twFdaLookupKeys(value: string): string[] {
  const normalized = normalizeTwFdaFoodName(value);
  if (!normalized) {
    return [];
  }
  return [...new Set([normalized, ...(CURATED_EXACT_ALIAS_TARGETS[normalized] ?? []).map(normalizeTwFdaFoodName)])];
}

export function resolveExactTwFdaFood(query: string, foods: LocalTwFdaFood[]): LocalTwFdaFood | undefined {
  const lookupKeys = new Set(twFdaLookupKeys(query));
  if (lookupKeys.size === 0) {
    return undefined;
  }
  const matches = new Map<string, LocalTwFdaFood>();
  for (const food of foods) {
    if ([food.nameZh, ...food.aliases].some((name) => lookupKeys.has(normalizeTwFdaFoodName(name)))) {
      matches.set(`${food.sourceRevision}\u0000${food.officialFoodId}`, food);
    }
  }
  return matches.size === 1 ? [...matches.values()][0] : undefined;
}

function massGrams(rawUnit: string, value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }
  if (rawUnit === 'g') {
    return value;
  }
  if (rawUnit === 'mg') {
    return value / 1_000;
  }
  if (rawUnit === 'ug') {
    return value / 1_000_000;
  }
  return undefined;
}

export function mapTwFdaNutrient(fact: TwFdaNutrientFact): MappedTwFdaNutrient | undefined {
  if (fact.officialName === '熱量' && fact.rawUnit === 'kcal' && Number.isFinite(fact.per100gValue) && fact.per100gValue >= 0) {
    return { nutrientCode: 'ENERGY', kcalPer100g: fact.per100gValue };
  }
  const gramsPer100g = massGrams(fact.rawUnit, fact.per100gValue);
  if (gramsPer100g === undefined) {
    return undefined;
  }
  const mapping = GOOGLE_NUTRIENT_CODES[fact.officialName];
  return {
    nutrientCode: mapping?.nutrientCode ?? `TW_FDA:${fact.officialName}`,
    gramsPer100g,
    selectionPriority: mapping?.selectionPriority,
  };
}

function dishGrams(dish: VisionDish): number {
  if (isPortionRange(dish.portionGrams)) {
    return (dish.portionGrams.min + dish.portionGrams.max) / 2;
  }
  return dish.portionGrams * (dish.eatFraction ?? 1);
}

function scale(value: number | undefined, grams: number): number | undefined {
  return value === undefined ? undefined : (value * grams) / 100;
}

function add(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}

function scaleFoodNutrients(food: LocalTwFdaFood | undefined, grams: number): {
  energyKcal: number | undefined;
  nutrients: Record<string, number>;
} {
  let energyKcal: number | undefined;
  const nutrients: Record<string, number> = {};
  const selectedNutrients = new Map<string, { priority: number; amount: number }>();
  for (const fact of food?.nutrients ?? []) {
    const mapped = mapTwFdaNutrient(fact);
    if (!mapped) {
      continue;
    }
    if ('kcalPer100g' in mapped) {
      energyKcal = add(energyKcal, scale(mapped.kcalPer100g, grams));
      continue;
    }
    const amount = scale(mapped.gramsPer100g, grams);
    if (amount !== undefined) {
      if (mapped.selectionPriority === undefined) {
        nutrients[mapped.nutrientCode] = (nutrients[mapped.nutrientCode] ?? 0) + amount;
        continue;
      }
      const existing = selectedNutrients.get(mapped.nutrientCode);
      if (!existing || mapped.selectionPriority > existing.priority) {
        selectedNutrients.set(mapped.nutrientCode, { priority: mapped.selectionPriority, amount });
      } else if (mapped.selectionPriority === existing.priority) {
        existing.amount += amount;
      }
    }
  }
  for (const [nutrientCode, selected] of selectedNutrients) {
    nutrients[nutrientCode] = selected.amount;
  }
  return { energyKcal, nutrients };
}

export async function resolveTwFdaDishIngredients(dish: VisionDish, catalog: TwFdaFoodCatalog): Promise<ResolvedDish> {
  const grams = dishGrams(dish);
  const ingredients = await Promise.all(
    allocateIngredientGrams(dish.ingredients, grams).map(async (part) => {
      const food = await catalog.findExact(part.nameZh);
      const nutrition = scaleFoodNutrients(food, part.grams);
      return {
        nameZh: part.nameZh,
        grams: part.grams,
        matchedDisplayName: food?.nameZh,
        foodName: food?.officialFoodId,
        foodSource: food ? ('tw_fda' as const) : ('unmatched' as const),
        foodSourceVersion: food?.sourceRevision,
        energyKcal: nutrition.energyKcal,
        proteinGrams: nutrition.nutrients.PROTEIN,
        carbGrams: nutrition.nutrients.CARBOHYDRATES,
        fatGrams: nutrition.nutrients.FAT,
        nutrients: nutrition.nutrients,
      };
    }),
  );
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
      nutrients: ingredients.reduce<Record<string, number>>((totals, item) => {
        for (const [code, value] of Object.entries(item.nutrients)) {
          totals[code] = (totals[code] ?? 0) + value;
        }
        return totals;
      }, {}),
    },
  };
}
