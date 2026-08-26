import type { VisionMeal } from '../../domain/meal-vision';
import type { GoogleNutritionDataPoint } from './google-nutrition';
import type { TwFdaFoodCatalog } from '../nutrition/tw-fda';

export type MealType = 'BREAKFAST' | 'LUNCH' | 'DINNER' | 'SNACK';

export type OutboxStatus =
  | 'local_only'
  | 'write_pending'
  | 'operation_pending'
  | 'synced'
  | 'retrying'
  | 'unknown'
  | 'failed_action_required';

export type MealDraftRow = {
  id: string;
  userId: string;
  mealType: MealType;
  eatenAt: Date;
  vision: VisionMeal;
  createdAt: Date;
  updatedAt: Date;
};

export type MealVersionRow = {
  id: string;
  userId: string;
  previousVersionId: string | undefined;
  mealType: MealType;
  eatenAt: Date;
  writebackThisMeal: boolean;
  confirmedAt: Date;
};

export type MealDishRow = {
  id: string;
  versionId: string;
  userId: string;
  clientShortId: string;
  nameZh: string;
  portionGrams: number;
  source: string;
};

export type MealIngredientRow = {
  id: string;
  dishId: string;
  userId: string;
  foodName: string;
  foodSource: 'google_health_food' | 'tw_fda' | 'unmatched';
  foodSourceId: string | undefined;
  foodSourceVersion: string | undefined;
  grams: number;
};

export type MealNutrientRow = {
  dishId: string;
  userId: string;
  nutrientCode: string;
  grams: number | undefined;
  kcal: number | undefined;
  source: string;
  confidence: number | undefined;
};

export type MealNutritionProvenanceRow = {
  dishId: string;
  userId: string;
  resolverVersion: string;
  foodSource: 'google_health_food' | 'tw_fda' | 'unmatched';
  foodSourceVersion: string | undefined;
  visionConfidence: number;
  totalIngredientGrams: number;
  matchedIngredientGrams: number;
};

export type OutboxRow = {
  id: string;
  userId: string;
  dishId: string;
  operation: 'create' | 'delete';
  dataPointName: string;
  payload: GoogleNutritionDataPoint | undefined;
  payloadHash: string | undefined;
  status: OutboxStatus;
  attemptCount?: number;
  nextAttemptAt?: Date;
  leaseUntil?: Date;
  lastAttemptAt?: Date;
  lastErrorCode?: string;
  googleOperationName?: string;
};

export type ConfirmMealInput = {
  userId: string;
  draftId: string;
  writebackThisMeal: boolean;
  canWriteNutrition: boolean;
  connectionSyncable: boolean;
  now: Date;
  catalog?: TwFdaFoodCatalog;
};

export type ConfirmMealResult =
  | {
      ok: true;
      version: MealVersionRow;
      dishes: MealDishRow[];
      ingredients: MealIngredientRow[];
      nutrients: MealNutrientRow[];
      provenance: MealNutritionProvenanceRow[];
      outbox: OutboxRow[];
    }
  | { ok: false; reason: string };
