import type { VisionMeal } from '../../domain/meal-vision';

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

export type OutboxRow = {
  id: string;
  userId: string;
  dishId: string;
  operation: 'create' | 'delete';
  dataPointName: string;
  payloadHash: string | undefined;
  status: OutboxStatus;
};

export type ConfirmMealInput = {
  userId: string;
  draftId: string;
  writebackThisMeal: boolean;
  canWriteNutrition: boolean;
  connectionSyncable: boolean;
  now: Date;
};

export type ConfirmMealResult =
  | { ok: true; version: MealVersionRow; dishes: MealDishRow[]; outbox: OutboxRow[] }
  | { ok: false; reason: string };
