import { createHash } from 'node:crypto';

import type { MealDishRow, MealNutrientRow, MealVersionRow } from './types';

type WeightUnit = 'GRAM' | 'MILLIGRAM' | 'MICROGRAM';

type WeightQuantity = {
  grams: number;
  userProvidedUnit?: WeightUnit;
};

type NutritionLog = {
  interval: { startTime: string; endTime: string };
  mealType: MealVersionRow['mealType'];
  foodDisplayName: string;
  energy?: { kcal: number; userProvidedUnit?: 'KILOCALORIE' };
  energyFromFat?: { kcal: number; userProvidedUnit?: 'KILOCALORIE' };
  totalCarbohydrate?: WeightQuantity;
  totalFat?: WeightQuantity;
  nutrients?: Array<{ nutrient: string; quantity: WeightQuantity }>;
};

export type GoogleNutritionDataPoint = {
  name: string;
  nutritionLog: NutritionLog;
};

const GOOGLE_NUTRIENTS = new Set([
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

/** Whether a nutrient code has a representation in a Google nutrition log. */
export function isGoogleSupportedNutrient(nutrientCode: string): boolean {
  return nutrientCode === 'ENERGY' || nutrientCode === 'FAT' || GOOGLE_NUTRIENTS.has(nutrientCode);
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

function isKnownAmount(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function displayUnit(code: string): WeightUnit | undefined {
  if (MICROGRAM_NUTRIENTS.has(code)) {
    return 'MICROGRAM';
  }
  if (MILLIGRAM_NUTRIENTS.has(code)) {
    return 'MILLIGRAM';
  }
  return undefined;
}

function weight(code: string, grams: number): WeightQuantity {
  const unit = displayUnit(code);
  return unit ? { grams, userProvidedUnit: unit } : { grams };
}

function inShanghai(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

export function canonicalNutritionHash(nutritionLog: NutritionLog): string {
  return createHash('sha256').update(canonical(nutritionLog)).digest('hex');
}

function nutrientByCode(nutrients: MealNutrientRow[]): Map<string, MealNutrientRow> {
  const rows = new Map<string, MealNutrientRow>();
  for (const row of nutrients) {
    rows.set(row.nutrientCode, row);
  }
  return rows;
}

export function buildGoogleNutritionDataPoint(input: {
  dish: MealDishRow;
  version: MealVersionRow;
  nutrients: MealNutrientRow[];
}): { dataPoint: GoogleNutritionDataPoint; payloadHash: string } | undefined {
  const rows = nutrientByCode(input.nutrients);
  const energy = rows.get('ENERGY')?.kcal;
  const fat = rows.get('FAT')?.grams;
  const carbohydrates = rows.get('CARBOHYDRATES')?.grams;
  const microAndOther = [...rows.entries()]
    .filter(([code, row]) => (
      code !== 'ENERGY'
      && code !== 'FAT'
      && code !== 'CARBOHYDRATES'
      && isGoogleSupportedNutrient(code)
      && isKnownAmount(row.grams)
    ))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([nutrient, row]) => ({ nutrient, quantity: weight(nutrient, row.grams!) }));
  if (!isKnownAmount(energy) && !isKnownAmount(fat) && !isKnownAmount(carbohydrates) && microAndOther.length === 0) {
    return undefined;
  }
  const nutritionLog: NutritionLog = {
    interval: {
      startTime: inShanghai(input.version.eatenAt),
      endTime: inShanghai(new Date(input.version.eatenAt.getTime() + 1000)),
    },
    mealType: input.version.mealType,
    foodDisplayName: input.dish.nameZh,
  };
  if (isKnownAmount(energy)) {
    nutritionLog.energy = { kcal: energy, userProvidedUnit: 'KILOCALORIE' };
  }
  if (isKnownAmount(fat)) {
    nutritionLog.totalFat = weight('FAT', fat);
    nutritionLog.energyFromFat = { kcal: fat * 9, userProvidedUnit: 'KILOCALORIE' };
  }
  if (isKnownAmount(carbohydrates)) {
    nutritionLog.totalCarbohydrate = weight('CARBOHYDRATES', carbohydrates);
  }
  if (microAndOther.length > 0) {
    nutritionLog.nutrients = microAndOther;
  }
  return {
    dataPoint: {
      name: `users/me/dataTypes/nutrition-log/dataPoints/${input.dish.clientShortId}`,
      nutritionLog,
    },
    payloadHash: canonicalNutritionHash(nutritionLog),
  };
}
