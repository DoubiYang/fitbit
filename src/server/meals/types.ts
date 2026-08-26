import type { VisionMeal } from '../../domain/meal-vision';
import type { EditableDish, EditableMealDraft, EditableNutrient } from '../../domain/meal-editor';
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

export type CurrentMealSyncState = 'unsynced' | 'syncing' | 'synced' | 'recovery';

/** The latest editable meal only. This intentionally contains neither vision nor remote payloads. */
export type CurrentMealSnapshot = {
  id: string;
  userId: string;
  mealType: MealType;
  eatenAt: Date;
  contentRevision: number;
  syncState: CurrentMealSyncState;
  lastSyncedGenerationId: string | undefined;
  dishes: EditableDish[];
  nutrients: EditableNutrient[];
  createdAt: Date;
  updatedAt: Date;
};

export type CurrentMealDishRow = {
  mealId: string;
  userId: string;
  dishKey: string;
  nameZh: string;
  portionGrams: number;
};

export type CurrentMealIngredientRow = {
  mealId: string;
  userId: string;
  dishKey: string;
  nameZh: string;
  grams: number;
  foodSource: 'google_health_food' | 'tw_fda' | 'unmatched';
  foodSourceId: string | undefined;
  foodSourceVersion: string | undefined;
};

export type CurrentMealNutrientRow = {
  mealId: string;
  userId: string;
  dishKey: string;
  nutrientCode: string;
  grams: number | undefined;
  kcal: number | undefined;
  source: string;
  sourceUnit: string;
  currentUnit: 'kcal' | 'g';
};

export type MealSyncGenerationPhase = 'pending_delete' | 'pending_create' | 'synced' | 'recovery';
export type MealSyncPointRole = 'delete_target' | 'create_target';
export type MealSyncPointStatus = 'pending' | 'leased' | 'operation_pending' | 'synced' | 'retrying' | 'unknown' | 'failed_action_required';

export type MealSyncGenerationRow = {
  id: string;
  mealId: string;
  userId: string;
  contentRevision: number;
  phase: MealSyncGenerationPhase;
  createdAt: Date;
  updatedAt: Date;
};

/** Internal remote-cleanup state; never a user-facing meal view. */
export type MealSyncPointRow = {
  id: string;
  generationId: string;
  userId: string;
  dishKey: string;
  role: MealSyncPointRole;
  dataPointName: string;
  payload: Record<string, unknown> | undefined;
  payloadHash: string | undefined;
  status: MealSyncPointStatus;
  attemptCount: number;
  nextAttemptAt: Date | undefined;
  leaseUntil: Date | undefined;
  lastAttemptAt: Date | undefined;
  lastErrorCode: string | undefined;
  googleOperationName: string | undefined;
  recoveryState: string | undefined;
};

export type InsertEditorDraftInput = {
  id: string;
  userId: string;
  mealType: MealType;
  eatenAt: Date;
  vision: VisionMeal;
  editor: EditableMealDraft;
  now: Date;
};

export type CurrentMealStore = {
  insertEditorDraft(input: InsertEditorDraftInput): Promise<EditableMealDraft>;
  findEditorDraft(userId: string, id: string): Promise<EditableMealDraft | undefined>;
  replaceEditorDraft(input: { userId: string; id: string; editor: EditableMealDraft; now: Date }): Promise<EditableMealDraft | undefined>;
  saveEditorDraft(input: { userId: string; draftId: string; now: Date }): Promise<CurrentMealSnapshot>;
  findCurrentMeal(userId: string, id: string): Promise<CurrentMealSnapshot | undefined>;
  replaceCurrentMealContent(input: { userId: string; mealId: string; editor: EditableMealDraft; now: Date }): Promise<CurrentMealSnapshot | undefined>;
  setCurrentMealNutrient(input: {
    userId: string; mealId: string; dishId: string; nutrientCode: string; value: number; unit: 'kcal' | 'g' | 'mg' | 'μg'; now: Date;
  }): Promise<CurrentMealSnapshot | undefined>;
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
