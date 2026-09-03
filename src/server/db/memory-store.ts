import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { editableMealDraftSchema, toInternalNutrientAmount, type EditableMealDraft } from '../../domain/meal-editor';
import { WHOOP_STYLE_METRIC_VERSION } from '../../domain/metric-types';
import type { AuthStore, ConnectionRow, MealSyncStore, OauthTransactionRow, ScheduledSyncLease, SessionRow } from '../auth/types';
import {
  HealthMetricsConnectionMismatchError,
  mergeHeartRateMinuteUpsert,
  normalizeDailyVo2Writes,
  parseActivityLevelInterval,
  parseAuthoritativeDailyVo2Replace,
  parseBodyAgeProfileUpdate,
  parseBodyAgeProfileRead,
  parseBodyAgeResultRead,
  parseBodyAgeResultWrite,
  parseDailyCardio,
  parseDailyVo2ListInput,
  parseDailyHeartRateZones,
  parseDailyTimeInZone,
  parseExerciseInterval,
  parseHealthSyncCursor,
  parseHealthTimeZoneHistory,
  parseHeartRateMinuteAggregate,
  parseMetricResult,
  parseObservedHrPeakWrite,
  parseSleepGoal,
  parseStoredBodyAgeProfile,
  parseStoredDailyVo2,
  selectNewestDailyVo2,
  SleepGoalConflictError,
  TimeZoneHistoryConflictError,
  type BodyAgeResultWrite,
  type HealthMetricsStore,
  type HealthMetricsWindowWrite,
  type HealthSyncCursor,
  type HealthTimeZoneHistory,
  type HeartRateMinuteAggregate,
  type StoredBodyAgeProfile,
  type StoredBodyAgeResult,
  type StoredDailyVo2,
} from '../health/cardio-store';
import { confirmDraftRows, resolveDraftNutrition } from '../meals/confirm-draft';
import { buildCurrentMealGooglePayloads } from '../meals/current-meal';
import { CurrentMealEditLockedError, type CurrentMealDishRow, type CurrentMealIngredientRow, type CurrentMealNutrientRow, type CurrentMealSnapshot, type CurrentMealStore, type MealDishRow, type MealDraftRow, type MealIngredientRow, type MealNutrientRow, type MealNutritionProvenanceRow, type MealSyncGenerationRow, type MealSyncPointRow, type MealSyncPointStatus, type MealType, type MealVersionRow, type OutboxRow } from '../meals/types';
import { resolveExactTwFdaFood, type LocalTwFdaFood } from '../nutrition/tw-fda';

export type MemoryStore = Omit<AuthStore, 'currentMeals' | 'mealSync'> & {
  currentMeals: CurrentMealStore;
  mealSync: MealSyncStore;
  deletedHealthSnapshotUserIds: string[];
  seedFoodComposition(foods: LocalTwFdaFood[]): void;
  outboxRows(): OutboxRow[];
  currentMealSnapshots(): CurrentMealSnapshot[];
  currentMealIngredients(mealId: string): CurrentMealIngredientRow[];
  currentMealNutrients(mealId: string): CurrentMealNutrientRow[];
  mealSyncPoints(): MealSyncPointRow[];
};

export class MemoryStoreTransactionConflictError extends Error {
  constructor() {
    super('MemoryStore transaction conflict: root state changed before commit');
    this.name = 'MemoryStoreTransactionConflictError';
  }
}

type MemoryStoreInternals = {
  snapshotState(): unknown;
  restoreState(state: unknown): void;
};

const memoryStoreInternals = new WeakMap<MemoryStore, MemoryStoreInternals>();

function envelopesEqual(left: Buffer | undefined, right: Buffer | undefined): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.equals(right);
}

function cloneConnection(row: ConnectionRow): ConnectionRow {
  return {
    ...row,
    grantedScopes: [...row.grantedScopes],
    tokenEnvelopeCiphertext: row.tokenEnvelopeCiphertext ? Buffer.from(row.tokenEnvelopeCiphertext) : undefined,
    tokenEnvelopeIv: row.tokenEnvelopeIv ? Buffer.from(row.tokenEnvelopeIv) : undefined,
    tokenEnvelopeAuthTag: row.tokenEnvelopeAuthTag ? Buffer.from(row.tokenEnvelopeAuthTag) : undefined,
    accessTokenExpiresAt: row.accessTokenExpiresAt ? new Date(row.accessTokenExpiresAt) : undefined,
    refreshTokenExpiresAt: row.refreshTokenExpiresAt ? new Date(row.refreshTokenExpiresAt) : undefined,
    connectedAt: new Date(row.connectedAt),
    updatedAt: new Date(row.updatedAt),
    lastSuccessfulSyncAt: row.lastSuccessfulSyncAt ? new Date(row.lastSuccessfulSyncAt) : undefined,
    nextSyncAt: row.nextSyncAt ? new Date(row.nextSyncAt) : undefined,
    syncLeaseUntil: row.syncLeaseUntil ? new Date(row.syncLeaseUntil) : undefined,
    syncLeaseToken: row.syncLeaseToken,
    lastSyncAttemptAt: row.lastSyncAttemptAt ? new Date(row.lastSyncAttemptAt) : undefined,
  };
}

function cloneOutbox(row: OutboxRow): OutboxRow {
  return {
    ...row,
    payload: row.payload ? structuredClone(row.payload) : undefined,
    nextAttemptAt: row.nextAttemptAt ? new Date(row.nextAttemptAt) : undefined,
    leaseUntil: row.leaseUntil ? new Date(row.leaseUntil) : undefined,
    lastAttemptAt: row.lastAttemptAt ? new Date(row.lastAttemptAt) : undefined,
  };
}

function cloneMealSyncGeneration(row: MealSyncGenerationRow): MealSyncGenerationRow {
  return { ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) };
}

function cloneMealSyncPoint(row: MealSyncPointRow): MealSyncPointRow {
  return {
    ...row,
    payload: row.payload ? structuredClone(row.payload) : undefined,
    nextAttemptAt: row.nextAttemptAt ? new Date(row.nextAttemptAt) : undefined,
    leaseUntil: row.leaseUntil ? new Date(row.leaseUntil) : undefined,
    lastAttemptAt: row.lastAttemptAt ? new Date(row.lastAttemptAt) : undefined,
    recoveryRequestedAt: row.recoveryRequestedAt ? new Date(row.recoveryRequestedAt) : undefined,
  };
}

function cloneCurrentMeal(row: CurrentMealSnapshot): CurrentMealSnapshot {
  return {
    ...structuredClone(row),
    eatenAt: new Date(row.eatenAt),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function compositeKey(...parts: string[]): string {
  return parts.join('\0');
}

function cloneCursor(row: HealthSyncCursor): HealthSyncCursor {
  return {
    ...row,
    successfulWatermark: row.successfulWatermark ? new Date(row.successfulWatermark) : undefined,
    nextAttemptAt: row.nextAttemptAt ? new Date(row.nextAttemptAt) : undefined,
  };
}

function intervalOverlaps(start: string, end: string, fromUtc: string, toUtcExclusive?: string): boolean {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const fromMs = Date.parse(fromUtc);
  const toMs = toUtcExclusive === undefined ? Number.POSITIVE_INFINITY : Date.parse(toUtcExclusive);
  return endMs > fromMs && startMs < toMs;
}

function inUtcRange(instant: string, fromUtc: string, toUtcExclusive?: string): boolean {
  const value = Date.parse(instant);
  const fromMs = Date.parse(fromUtc);
  const toMs = toUtcExclusive === undefined ? Number.POSITIVE_INFINITY : Date.parse(toUtcExclusive);
  return value >= fromMs && value < toMs;
}

const mealTypes = new Set<MealType>(['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK']);

function parseEditorForCurrentMeal(editor: EditableMealDraft, mealId: string): EditableMealDraft & { mealType: MealType } {
  const parsed = editableMealDraftSchema.parse(editor);
  if (parsed.mealId !== mealId) throw new Error('editor meal id must match current meal id');
  if (!mealTypes.has(parsed.mealType as MealType)) throw new Error('editor meal type is invalid');
  return parsed as EditableMealDraft & { mealType: MealType };
}

function hasMeaningfulCurrentContentChange(current: CurrentMealSnapshot, editor: EditableMealDraft): boolean {
  return JSON.stringify({
    mealType: current.mealType,
    eatenAt: current.eatenAt.toISOString(),
    dishes: current.dishes,
    nutrients: current.nutrients,
  }) !== JSON.stringify({
    mealType: editor.mealType,
    eatenAt: editor.eatenAt,
    dishes: editor.dishes,
    nutrients: editor.nutrients,
  });
}

function ownsOutboxLease(row: OutboxRow | undefined, input: { userId: string; leaseUntil: Date }): row is OutboxRow {
  return Boolean(row && row.userId === input.userId && row.leaseUntil?.getTime() === input.leaseUntil.getTime());
}

function isSyncBlockedStatus(status: MealSyncPointStatus): boolean {
  return status === 'unknown' || status === 'failed_action_required';
}

function resumeStatus(point: MealSyncPointRow): 'pending' | 'operation_pending' {
  return point.googleOperationName || point.recoveryState === 'operation_pending' ? 'operation_pending' : 'pending';
}

export function createMemoryStore(options: { transactionChild?: boolean } = {}): MemoryStore {
  const users = new Set<string>();
  const writebackEnabled = new Map<string, boolean>();
  const drafts = new Map<string, MealDraftRow>();
  const editorDrafts = new Map<string, EditableMealDraft>();
  const currentMeals = new Map<string, CurrentMealSnapshot>();
  const currentDishes = new Map<string, CurrentMealDishRow[]>();
  const currentIngredients = new Map<string, CurrentMealIngredientRow[]>();
  const currentNutrients = new Map<string, CurrentMealNutrientRow[]>();
  const syncGenerations = new Map<string, MealSyncGenerationRow>();
  const syncPoints = new Map<string, MealSyncPointRow>();
  const versions: MealVersionRow[] = [];
  const dishes: MealDishRow[] = [];
  const ingredients: MealIngredientRow[] = [];
  const nutrients: MealNutrientRow[] = [];
  const provenance: MealNutritionProvenanceRow[] = [];
  const outbox: OutboxRow[] = [];
  const connections = new Map<string, ConnectionRow>();
  const sessions = new Map<string, SessionRow>();
  const transactions = new Map<string, OauthTransactionRow>();
  const deletedHealthSnapshotUserIds: string[] = [];
  const heartRateMinutes = new Map<string, HeartRateMinuteAggregate>();
  const activityLevelIntervals = new Map<string, ReturnType<typeof parseActivityLevelInterval>>();
  const heartRateZones = new Map<string, ReturnType<typeof parseDailyHeartRateZones>>();
  const timeInZone = new Map<string, ReturnType<typeof parseDailyTimeInZone>>();
  const exerciseIntervals = new Map<string, ReturnType<typeof parseExerciseInterval>>();
  const dailyCardio = new Map<string, ReturnType<typeof parseDailyCardio>>();
  const metricResults = new Map<string, ReturnType<typeof parseMetricResult>>();
  const healthCursors = new Map<string, HealthSyncCursor>();
  const sleepGoals = new Map<string, ReturnType<typeof parseSleepGoal>>();
  const timeZoneHistory = new Map<string, HealthTimeZoneHistory>();
  const bodyAgeProfiles = new Map<string, StoredBodyAgeProfile>();
  const dailyVo2 = new Map<string, StoredDailyVo2>();
  const bodyAgeResults = new Map<string, StoredBodyAgeResult>();
  let foodComposition: LocalTwFdaFood[] = [];
  let rootTransactionTail = Promise.resolve();

  async function serializeRootTransaction<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = rootTransactionTail;
    rootTransactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  function replaceCurrentChildren(snapshot: CurrentMealSnapshot): void {
    currentDishes.set(snapshot.id, snapshot.dishes.map((dish) => ({
      mealId: snapshot.id,
      userId: snapshot.userId,
      dishKey: dish.id,
      nameZh: dish.nameZh,
      portionGrams: dish.portionGrams,
    })));
    currentIngredients.set(snapshot.id, snapshot.dishes.flatMap((dish) => dish.ingredients.map((ingredient) => ({
      mealId: snapshot.id,
      userId: snapshot.userId,
      dishKey: dish.id,
      nameZh: ingredient.nameZh,
      grams: ingredient.grams,
      foodSource: ingredient.foodSource,
      foodSourceId: ingredient.foodSourceId,
      foodSourceVersion: ingredient.foodSourceVersion,
    }))));
    currentNutrients.set(snapshot.id, snapshot.nutrients.map((nutrient) => {
      const internal = toInternalNutrientAmount(nutrient.nutrientCode, nutrient.value, nutrient.unit);
      return {
        mealId: snapshot.id,
        userId: snapshot.userId,
        dishKey: nutrient.dishId,
        nutrientCode: nutrient.nutrientCode,
        grams: internal.unit === 'g' ? internal.value : undefined,
        kcal: internal.unit === 'kcal' ? internal.value : undefined,
        source: nutrient.source,
        sourceUnit: nutrient.unit,
        currentUnit: internal.unit,
      };
    }));
  }

  function snapshotState() {
    return {
      users: new Set(users),
      writebackEnabled: new Map(writebackEnabled),
      drafts: new Map([...drafts].map(([id, row]) => [id, structuredClone(row)])),
      editorDrafts: new Map([...editorDrafts].map(([id, row]) => [id, structuredClone(row)])),
      currentMeals: new Map([...currentMeals].map(([id, row]) => [id, cloneCurrentMeal(row)])),
      currentDishes: new Map([...currentDishes].map(([id, rows]) => [id, structuredClone(rows)])),
      currentIngredients: new Map([...currentIngredients].map(([id, rows]) => [id, structuredClone(rows)])),
      currentNutrients: new Map([...currentNutrients].map(([id, rows]) => [id, structuredClone(rows)])),
      syncGenerations: new Map([...syncGenerations].map(([id, row]) => [id, cloneMealSyncGeneration(row)])),
      syncPoints: new Map([...syncPoints].map(([id, row]) => [id, cloneMealSyncPoint(row)])),
      versions: structuredClone(versions),
      dishes: structuredClone(dishes),
      ingredients: structuredClone(ingredients),
      nutrients: structuredClone(nutrients),
      provenance: structuredClone(provenance),
      outbox: structuredClone(outbox),
      connections: new Map([...connections].map(([id, row]) => [id, cloneConnection(row)])),
      sessions: new Map([...sessions].map(([id, row]) => [id, structuredClone(row)])),
      transactions: new Map([...transactions].map(([id, row]) => [id, structuredClone(row)])),
      deletedHealthSnapshotUserIds: [...deletedHealthSnapshotUserIds],
      heartRateMinutes: new Map([...heartRateMinutes].map(([id, row]) => [id, structuredClone(row)])),
      activityLevelIntervals: new Map([...activityLevelIntervals].map(([id, row]) => [id, structuredClone(row)])),
      heartRateZones: new Map([...heartRateZones].map(([id, row]) => [id, structuredClone(row)])),
      timeInZone: new Map([...timeInZone].map(([id, row]) => [id, structuredClone(row)])),
      exerciseIntervals: new Map([...exerciseIntervals].map(([id, row]) => [id, structuredClone(row)])),
      dailyCardio: new Map([...dailyCardio].map(([id, row]) => [id, structuredClone(row)])),
      metricResults: new Map([...metricResults].map(([id, row]) => [id, structuredClone(row)])),
      healthCursors: new Map([...healthCursors].map(([id, row]) => [id, cloneCursor(row)])),
      sleepGoals: new Map([...sleepGoals].map(([id, row]) => [id, structuredClone(row)])),
      timeZoneHistory: new Map([...timeZoneHistory].map(([id, row]) => [id, structuredClone(row)])),
      bodyAgeProfiles: new Map([...bodyAgeProfiles].map(([id, row]) => [id, structuredClone(row)])),
      dailyVo2: new Map([...dailyVo2].map(([id, row]) => [id, structuredClone(row)])),
      bodyAgeResults: new Map([...bodyAgeResults].map(([id, row]) => [id, structuredClone(row)])),
      foodComposition: structuredClone(foodComposition),
    };
  }

  function restoreMap<T>(target: Map<string, T>, source: Map<string, T>, clone: (row: T) => T): void {
    target.clear();
    for (const [id, row] of source) target.set(id, clone(row));
  }

  function restoreState(state: ReturnType<typeof snapshotState>): void {
    users.clear();
    for (const user of state.users) users.add(user);
    restoreMap(writebackEnabled, state.writebackEnabled, (value) => value);
    restoreMap(drafts, state.drafts, (row) => structuredClone(row));
    restoreMap(editorDrafts, state.editorDrafts, (row) => structuredClone(row));
    restoreMap(currentMeals, state.currentMeals, cloneCurrentMeal);
    restoreMap(currentDishes, state.currentDishes, (rows) => structuredClone(rows));
    restoreMap(currentIngredients, state.currentIngredients, (rows) => structuredClone(rows));
    restoreMap(currentNutrients, state.currentNutrients, (rows) => structuredClone(rows));
    restoreMap(syncGenerations, state.syncGenerations, cloneMealSyncGeneration);
    restoreMap(syncPoints, state.syncPoints, cloneMealSyncPoint);
    versions.splice(0, versions.length, ...structuredClone(state.versions));
    dishes.splice(0, dishes.length, ...structuredClone(state.dishes));
    ingredients.splice(0, ingredients.length, ...structuredClone(state.ingredients));
    nutrients.splice(0, nutrients.length, ...structuredClone(state.nutrients));
    provenance.splice(0, provenance.length, ...structuredClone(state.provenance));
    outbox.splice(0, outbox.length, ...state.outbox.map(cloneOutbox));
    restoreMap(connections, state.connections, cloneConnection);
    restoreMap(sessions, state.sessions, (row) => structuredClone(row));
    restoreMap(transactions, state.transactions, (row) => structuredClone(row));
    deletedHealthSnapshotUserIds.splice(0, deletedHealthSnapshotUserIds.length, ...state.deletedHealthSnapshotUserIds);
    restoreMap(heartRateMinutes, state.heartRateMinutes, (row) => structuredClone(row));
    restoreMap(activityLevelIntervals, state.activityLevelIntervals, (row) => structuredClone(row));
    restoreMap(heartRateZones, state.heartRateZones, (row) => structuredClone(row));
    restoreMap(timeInZone, state.timeInZone, (row) => structuredClone(row));
    restoreMap(exerciseIntervals, state.exerciseIntervals, (row) => structuredClone(row));
    restoreMap(dailyCardio, state.dailyCardio, (row) => structuredClone(row));
    restoreMap(metricResults, state.metricResults, (row) => structuredClone(row));
    restoreMap(healthCursors, state.healthCursors, cloneCursor);
    restoreMap(sleepGoals, state.sleepGoals, (row) => structuredClone(row));
    restoreMap(timeZoneHistory, state.timeZoneHistory, (row) => structuredClone(row));
    restoreMap(bodyAgeProfiles, state.bodyAgeProfiles, (row) => structuredClone(row));
    restoreMap(dailyVo2, state.dailyVo2, (row) => structuredClone(row));
    restoreMap(bodyAgeResults, state.bodyAgeResults, (row) => structuredClone(row));
    foodComposition = structuredClone(state.foodComposition);
  }

  let store!: AuthStore;

  function activeGeneration(mealId: string, userId: string): MealSyncGenerationRow | undefined {
    return [...syncGenerations.values()]
      .filter((generation) => generation.mealId === mealId && generation.userId === userId && generation.phase !== 'synced')
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))[0];
  }

  function pointsForGeneration(generationId: string): MealSyncPointRow[] {
    return [...syncPoints.values()].filter((point) => point.generationId === generationId);
  }

  function ownsSyncPointLease(
    point: MealSyncPointRow | undefined,
    input: { generationId: string; userId: string; leaseUntil: Date },
  ): point is MealSyncPointRow {
    return Boolean(
      point
      && point.generationId === input.generationId
      && point.userId === input.userId
      && point.leaseUntil?.getTime() === input.leaseUntil.getTime(),
    );
  }

  function updateCurrentMealSyncState(generation: MealSyncGenerationRow, state: CurrentMealSnapshot['syncState'], now: Date): void {
    const meal = currentMeals.get(generation.mealId);
    if (!meal || meal.userId !== generation.userId) return;
    currentMeals.set(meal.id, { ...meal, syncState: state, updatedAt: new Date(now) });
  }

  function finaliseGeneration(generation: MealSyncGenerationRow, now: Date): void {
    generation.phase = 'synced';
    generation.updatedAt = new Date(now);
    const meal = currentMeals.get(generation.mealId);
    if (!meal || meal.userId !== generation.userId) return;
    const priorGenerationId = meal.lastSyncedGenerationId;
    if (priorGenerationId && priorGenerationId !== generation.id) {
      syncGenerations.delete(priorGenerationId);
      for (const [pointId, point] of syncPoints) {
        if (point.generationId === priorGenerationId) syncPoints.delete(pointId);
      }
    }
    for (const [pointId, point] of syncPoints) {
      if (point.generationId === generation.id && point.role === 'delete_target') syncPoints.delete(pointId);
    }
    currentMeals.set(meal.id, {
      ...meal,
      syncState: 'synced',
      lastSyncedGenerationId: generation.id,
      updatedAt: new Date(now),
    });
  }

  function refreshGenerationState(generation: MealSyncGenerationRow, now: Date): void {
    const points = pointsForGeneration(generation.id);
    const createPoints = points.filter((point) => point.role === 'create_target');
    const deletePoints = points.filter((point) => point.role === 'delete_target');
    if (createPoints.length > 0 && createPoints.every((point) => point.status === 'synced')) {
      finaliseGeneration(generation, now);
      return;
    }
    if (points.some((point) => isSyncBlockedStatus(point.status))) {
      generation.phase = 'recovery';
      generation.updatedAt = new Date(now);
      updateCurrentMealSyncState(generation, 'recovery', now);
      return;
    }
    generation.phase = deletePoints.every((point) => point.status === 'synced') ? 'pending_create' : 'pending_delete';
    generation.updatedAt = new Date(now);
    updateCurrentMealSyncState(generation, 'syncing', now);
  }

  async function inSyncTransaction<T>(work: (sync: MealSyncStore) => Promise<T>): Promise<T> {
    if (options.transactionChild) return work(mealSync);
    return store.withTransaction((inner) => work(inner.mealSync!));
  }

  const mealSync: MealSyncStore = {
    async startGeneration(input) {
      return inSyncTransaction(async (sync) => {
        if (sync !== mealSync) return sync.startGeneration(input);
        const meal = currentMeals.get(input.mealId);
        if (!meal || meal.userId !== input.userId || meal.syncState !== 'unsynced') return undefined;
        if (activeGeneration(input.mealId, input.userId)) return undefined;
        const payloads = buildCurrentMealGooglePayloads({
          meal,
          dataPointIdForDish: () => `d-${randomUUID()}`,
        });
        if (payloads.length === 0) return undefined;
        const generation: MealSyncGenerationRow = {
          id: randomUUID(),
          mealId: input.mealId,
          userId: input.userId,
          contentRevision: meal.contentRevision,
          phase: meal.lastSyncedGenerationId ? 'pending_delete' : 'pending_create',
          createdAt: new Date(input.now),
          updatedAt: new Date(input.now),
        };
        const previousPoints = meal.lastSyncedGenerationId
          ? pointsForGeneration(meal.lastSyncedGenerationId).filter((point) => point.role === 'create_target')
          : [];
        syncGenerations.set(generation.id, generation);
        for (const previous of previousPoints) {
          const point: MealSyncPointRow = {
            id: randomUUID(), generationId: generation.id, userId: input.userId, dishKey: previous.dishKey,
            role: 'delete_target', dataPointName: previous.dataPointName, payload: undefined, payloadHash: undefined,
            status: 'pending', attemptCount: 0, nextAttemptAt: undefined, leaseUntil: undefined, lastAttemptAt: undefined,
            lastErrorCode: undefined, googleOperationName: undefined, recoveryState: undefined, recoveryRequestedAt: undefined,
          };
          syncPoints.set(point.id, point);
        }
        for (const payload of payloads) {
          const point: MealSyncPointRow = {
            id: randomUUID(), generationId: generation.id, userId: input.userId, dishKey: payload.dishKey,
            role: 'create_target', dataPointName: payload.dataPoint.name,
            payload: structuredClone(payload.dataPoint) as unknown as Record<string, unknown>, payloadHash: payload.payloadHash,
            status: 'pending', attemptCount: 0, nextAttemptAt: undefined, leaseUntil: undefined, lastAttemptAt: undefined,
            lastErrorCode: undefined, googleOperationName: undefined, recoveryState: undefined, recoveryRequestedAt: undefined,
          };
          syncPoints.set(point.id, point);
        }
        updateCurrentMealSyncState(generation, 'syncing', input.now);
        return cloneMealSyncGeneration(generation);
      });
    },
    async beginRecovery(input) {
      return inSyncTransaction(async (sync) => {
        if (sync !== mealSync) return sync.beginRecovery(input);
        void input.reason;
        const generation = activeGeneration(input.mealId, input.userId);
        if (!generation) return undefined;
        const points = pointsForGeneration(generation.id);
        const unknown = points.filter((point) => point.status === 'unknown');
        if (unknown.length > 0) {
          for (const point of unknown) point.recoveryRequestedAt = new Date(input.now);
          generation.phase = 'recovery';
          generation.updatedAt = new Date(input.now);
          updateCurrentMealSyncState(generation, 'recovery', input.now);
          return cloneMealSyncGeneration(generation);
        }
        for (const point of points.filter((item) => item.status === 'failed_action_required')) {
          point.status = resumeStatus(point);
          point.nextAttemptAt = new Date(input.now);
          point.lastErrorCode = undefined;
          point.recoveryState = undefined;
        }
        refreshGenerationState(generation, input.now);
        return cloneMealSyncGeneration(generation);
      });
    },
    async claimDuePoints(input) {
      return inSyncTransaction(async (sync) => {
        if (sync !== mealSync) return sync.claimDuePoints(input);
        const claimed: MealSyncPointRow[] = [];
        const active = [...syncGenerations.values()]
          .filter((generation) => generation.phase !== 'synced')
          .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id));
        for (const generation of active) {
          if (claimed.length >= input.limit) break;
          const points = pointsForGeneration(generation.id);
          const unknown = points.some((point) => point.status === 'unknown');
          const hasActionRequired = points.some((point) => point.status === 'failed_action_required');
          const deletesComplete = points.filter((point) => point.role === 'delete_target').every((point) => point.status === 'synced');
          const candidate = (point: MealSyncPointRow): boolean => {
            if (point.leaseUntil && point.leaseUntil.getTime() > input.now.getTime()) return false;
            if (input.mode === 'batch_delete') {
              return !unknown
                && !hasActionRequired
                && point.role === 'delete_target'
                && (point.status === 'pending' || point.status === 'retrying')
                && !point.googleOperationName
                && (!point.nextAttemptAt || point.nextAttemptAt.getTime() <= input.now.getTime());
            }
            if (unknown) {
              return point.status === 'unknown'
                && Boolean(point.recoveryRequestedAt)
                && point.recoveryRequestedAt!.getTime() <= input.now.getTime();
            }
            if (hasActionRequired) return false;
            if (point.role !== (deletesComplete ? 'create_target' : 'delete_target')) return false;
            if (point.status !== 'pending' && point.status !== 'retrying' && point.status !== 'operation_pending') return false;
            if (input.mode === 'single'
              && point.role === 'delete_target'
              && (point.status === 'pending' || point.status === 'retrying')
              && !point.googleOperationName) return false;
            return !point.nextAttemptAt || point.nextAttemptAt.getTime() <= input.now.getTime();
          };
          for (const point of points.filter(candidate).sort((left, right) => left.id.localeCompare(right.id))) {
            if (claimed.length >= input.limit) break;
            point.leaseUntil = new Date(input.leaseUntil);
            point.lastAttemptAt = new Date(input.now);
            point.attemptCount += 1;
            point.nextAttemptAt = undefined;
            claimed.push(cloneMealSyncPoint(point));
          }
          if (input.mode === 'batch_delete' && claimed.length > 0) break;
        }
        return claimed;
      });
    },
    async renewPointLease(input) {
      return inSyncTransaction(async (sync) => {
        if (sync !== mealSync) return sync.renewPointLease(input);
        const point = syncPoints.get(input.id);
        const leaseUntil = point?.leaseUntil;
        if (!ownsSyncPointLease(point, input)
          || !leaseUntil
          || leaseUntil.getTime() <= input.now.getTime()
          || input.renewedLeaseUntil.getTime() <= leaseUntil.getTime()) return false;
        point.leaseUntil = new Date(input.renewedLeaseUntil);
        return true;
      });
    },
    async finishPoint(input) {
      return inSyncTransaction(async (sync) => {
        if (sync !== mealSync) return sync.finishPoint(input);
        const point = syncPoints.get(input.id);
        if (!ownsSyncPointLease(point, input)) return false;
        const generation = syncGenerations.get(point.generationId);
        if (!generation || generation.userId !== input.userId) return false;
        point.status = 'synced';
        point.leaseUntil = undefined;
        point.nextAttemptAt = undefined;
        point.lastErrorCode = undefined;
        point.recoveryState = undefined;
        point.recoveryRequestedAt = undefined;
        refreshGenerationState(generation, input.now);
        return true;
      });
    },
    async retryPoint(input) {
      return inSyncTransaction(async (sync) => {
        if (sync !== mealSync) return sync.retryPoint(input);
        const point = syncPoints.get(input.id);
        if (!ownsSyncPointLease(point, input)) return false;
        const generation = syncGenerations.get(point.generationId);
        if (!generation || generation.userId !== input.userId) return false;
        point.recoveryState = resumeStatus(point);
        point.status = 'retrying';
        point.leaseUntil = undefined;
        point.nextAttemptAt = new Date(input.nextAttemptAt);
        point.lastErrorCode = input.errorCode;
        refreshGenerationState(generation, input.now);
        return true;
      });
    },
    async markPointUnknown(input) {
      return inSyncTransaction(async (sync) => {
        if (sync !== mealSync) return sync.markPointUnknown(input);
        const point = syncPoints.get(input.id);
        if (!ownsSyncPointLease(point, input)) return false;
        const generation = syncGenerations.get(point.generationId);
        if (!generation || generation.userId !== input.userId) return false;
        point.recoveryState = resumeStatus(point);
        point.status = 'unknown';
        point.leaseUntil = undefined;
        point.nextAttemptAt = undefined;
        point.lastErrorCode = input.errorCode;
        point.recoveryRequestedAt = undefined;
        refreshGenerationState(generation, input.now);
        return true;
      });
    },
    async markPointFailedActionRequired(input) {
      return inSyncTransaction(async (sync) => {
        if (sync !== mealSync) return sync.markPointFailedActionRequired(input);
        const point = syncPoints.get(input.id);
        if (!ownsSyncPointLease(point, input)) return false;
        const generation = syncGenerations.get(point.generationId);
        if (!generation || generation.userId !== input.userId) return false;
        point.recoveryState = resumeStatus(point);
        point.status = 'failed_action_required';
        point.leaseUntil = undefined;
        point.nextAttemptAt = undefined;
        point.lastErrorCode = input.errorCode;
        refreshGenerationState(generation, input.now);
        return true;
      });
    },
    async markPointOperationPending(input) {
      return inSyncTransaction(async (sync) => {
        if (sync !== mealSync) return sync.markPointOperationPending(input);
        const point = syncPoints.get(input.id);
        if (!ownsSyncPointLease(point, input)) return false;
        const generation = syncGenerations.get(point.generationId);
        if (!generation || generation.userId !== input.userId) return false;
        point.status = 'operation_pending';
        point.leaseUntil = undefined;
        point.googleOperationName = input.operationName;
        point.nextAttemptAt = new Date(input.nextAttemptAt);
        point.lastErrorCode = undefined;
        point.recoveryState = 'operation_pending';
        return true;
      });
    },
    async requestUnknownRecovery(input) {
      return inSyncTransaction(async (sync) => {
        if (sync !== mealSync) return sync.requestUnknownRecovery(input);
        const generation = syncGenerations.get(input.generationId);
        const point = syncPoints.get(input.pointId);
        if (!generation || generation.userId !== input.userId || point?.generationId !== generation.id || point.status !== 'unknown') return false;
        point.recoveryRequestedAt = new Date(input.now);
        generation.phase = 'recovery';
        generation.updatedAt = new Date(input.now);
        updateCurrentMealSyncState(generation, 'recovery', input.now);
        return true;
      });
    },
    async readGenerationState(input) {
      const generation = activeGeneration(input.mealId, input.userId);
      if (!generation) return undefined;
      const points = pointsForGeneration(generation.id);
      const pointStatusCounts: Partial<Record<MealSyncPointStatus, number>> = {};
      for (const point of points) pointStatusCounts[point.status] = (pointStatusCounts[point.status] ?? 0) + 1;
      const recoveryRequestedAt = points
        .filter((point) => point.status === 'unknown' && point.recoveryRequestedAt)
        .map((point) => point.recoveryRequestedAt!)
        .sort((left, right) => right.getTime() - left.getTime())[0];
      return {
        generation: cloneMealSyncGeneration(generation),
        pointStatusCounts,
        hasUnknownPoint: points.some((point) => point.status === 'unknown'),
        recoveryRequestedAt: recoveryRequestedAt ? new Date(recoveryRequestedAt) : undefined,
      };
    },
  };

  function assertWindowUser<T extends { userId: string }>(userId: string, rows: T[] | undefined): T[] {
    const list = rows ?? [];
    for (const row of list) {
      if (row.userId !== userId) {
        throw new Error('health metrics write user mismatch');
      }
    }
    return list;
  }

  async function applyHealthWindow(input: HealthMetricsWindowWrite): Promise<void> {
    if (connections.get(input.connectionId)?.userId !== input.userId) {
      throw new HealthMetricsConnectionMismatchError();
    }
    await healthMetrics.upsertMinutes(assertWindowUser(input.userId, input.minutes));
    await healthMetrics.upsertActivityLevelIntervals(assertWindowUser(input.userId, input.activityLevelIntervals));
    for (const row of assertWindowUser(input.userId, input.heartRateZones)) {
      await healthMetrics.replaceHeartRateZones(row);
    }
    for (const row of assertWindowUser(input.userId, input.timeInZone)) {
      await healthMetrics.replaceTimeInZone(row);
    }
    await healthMetrics.upsertExerciseIntervals(assertWindowUser(input.userId, input.exerciseIntervals));
    for (const row of assertWindowUser(input.userId, input.dailyCardio)) {
      await healthMetrics.upsertDailyCardio(row);
    }
    for (const row of assertWindowUser(input.userId, input.metricResults)) {
      await healthMetrics.upsertMetricResult(row);
    }
    await healthMetrics.updateCursor({
      connectionId: input.connectionId,
      dataType: input.dataType,
      ...input.cursor,
    });
  }

  const healthMetrics: HealthMetricsStore = {
    async ingestWindow(input) {
      if (!options.transactionChild) {
        return store.withTransaction((inner) => inner.healthMetrics.ingestWindow(input));
      }
      await applyHealthWindow(input);
    },
    async upsertMinutes(minutes) {
      for (const row of minutes) {
        const incoming = parseHeartRateMinuteAggregate(row);
        const key = compositeKey(incoming.userId, incoming.sourceFamily, incoming.minuteStartUtc);
        const existing = heartRateMinutes.get(key);
        const merged = existing ? mergeHeartRateMinuteUpsert(existing, incoming) : incoming;
        heartRateMinutes.set(key, structuredClone(merged));
      }
    },
    async listMinutesByCivilDate(input) {
      return [...heartRateMinutes.values()]
        .filter((row) => row.userId === input.userId && row.civilDate === input.civilDate)
        .sort((left, right) => left.minuteStartUtc.localeCompare(right.minuteStartUtc))
        .map((row) => structuredClone(row));
    },
    async listMinutesInRange(input) {
      return [...heartRateMinutes.values()]
        .filter((row) => row.userId === input.userId && inUtcRange(row.minuteStartUtc, input.fromUtc, input.toUtcExclusive))
        .sort((left, right) => left.minuteStartUtc.localeCompare(right.minuteStartUtc))
        .map((row) => structuredClone(row));
    },
    async updateMinuteLocalAssociation(input) {
      const key = compositeKey(input.userId, input.sourceFamily, input.minuteStartUtc);
      const current = heartRateMinutes.get(key);
      if (!current) return false;
      heartRateMinutes.set(key, parseHeartRateMinuteAggregate({
        ...current,
        civilDate: input.civilDate,
        ianaTimeZone: input.ianaTimeZone,
        localMinuteOfDay: input.localMinuteOfDay,
      }));
      return true;
    },
    async upsertActivityLevelIntervals(intervals) {
      for (const row of intervals) {
        const parsed = parseActivityLevelInterval(row);
        activityLevelIntervals.set(compositeKey(parsed.userId, parsed.sourceFamily, parsed.startTime), structuredClone(parsed));
      }
    },
    async listActivityLevelIntervalsInRange(input) {
      return [...activityLevelIntervals.values()]
        .filter((row) => row.userId === input.userId && intervalOverlaps(row.startTime, row.endTime, input.fromUtc, input.toUtcExclusive))
        .sort((left, right) => left.startTime.localeCompare(right.startTime))
        .map((row) => structuredClone(row));
    },
    async replaceHeartRateZones(zones) {
      const parsed = parseDailyHeartRateZones(zones);
      heartRateZones.set(compositeKey(parsed.userId, parsed.sourceFamily, parsed.date), structuredClone(parsed));
    },
    async getHeartRateZones(input) {
      const row = [...heartRateZones.values()].find((item) => item.userId === input.userId && item.date === input.civilDate);
      return row ? structuredClone(row) : undefined;
    },
    async replaceTimeInZone(row) {
      const parsed = parseDailyTimeInZone(row);
      timeInZone.set(compositeKey(parsed.userId, parsed.sourceFamily, parsed.date), structuredClone(parsed));
    },
    async getTimeInZone(input) {
      const row = [...timeInZone.values()].find((item) => item.userId === input.userId && item.date === input.civilDate);
      return row ? structuredClone(row) : undefined;
    },
    async upsertExerciseIntervals(intervals) {
      for (const row of intervals) {
        const parsed = parseExerciseInterval(row);
        exerciseIntervals.set(compositeKey(parsed.userId, parsed.sourceFamily, parsed.sourceRecordId), structuredClone(parsed));
      }
    },
    async listExerciseIntervalsInRange(input) {
      return [...exerciseIntervals.values()]
        .filter((row) => row.userId === input.userId && intervalOverlaps(row.startTime, row.endTime, input.fromUtc, input.toUtcExclusive))
        .sort((left, right) => left.startTime.localeCompare(right.startTime))
        .map((row) => structuredClone(row));
    },
    async upsertDailyCardio(row) {
      const parsed = parseDailyCardio(row);
      dailyCardio.set(compositeKey(parsed.userId, parsed.date), structuredClone(parsed));
    },
    async getDailyCardio(input) {
      const row = dailyCardio.get(compositeKey(input.userId, input.civilDate));
      return row ? structuredClone(row) : undefined;
    },
    async listDailyCardio(input) {
      return [...dailyCardio.values()]
        .filter((row) => row.userId === input.userId && row.date >= input.fromCivilDate && row.date <= input.toCivilDate)
        .sort((left, right) => left.date.localeCompare(right.date))
        .map((row) => structuredClone(row));
    },
    async upsertMetricResult(row) {
      const parsed = parseMetricResult(row);
      metricResults.set(compositeKey(parsed.userId, parsed.civilDate, parsed.metricName, parsed.metricVersion), structuredClone(parsed));
    },
    async getMetricResult(input) {
      const row = metricResults.get(compositeKey(
        input.userId,
        input.civilDate,
        input.metricName,
        input.metricVersion ?? WHOOP_STYLE_METRIC_VERSION,
      ));
      return row ? structuredClone(row) : undefined;
    },
    async listMetricResults(input) {
      return [...metricResults.values()]
        .filter((row) => row.userId === input.userId && row.civilDate === input.civilDate)
        .sort((left, right) => left.metricName.localeCompare(right.metricName))
        .map((row) => structuredClone(row));
    },
    async readCursor(input) {
      const row = healthCursors.get(compositeKey(input.connectionId, input.dataType));
      return row ? cloneCursor(row) : undefined;
    },
    async listCursors(input) {
      return [...healthCursors.values()]
        .filter((row) => row.connectionId === input.connectionId)
        .sort((left, right) => left.dataType.localeCompare(right.dataType))
        .map(cloneCursor);
    },
    async updateCursor(cursor) {
      const parsed = parseHealthSyncCursor(cursor);
      healthCursors.set(compositeKey(parsed.connectionId, parsed.dataType), cloneCursor(parsed));
    },
    async scheduleCursor(input) {
      const parsed = parseHealthSyncCursor({
        connectionId: input.connectionId,
        dataType: input.dataType,
        lastErrorCode: input.lastErrorCode,
        retryCount: input.retryCount,
        nextAttemptAt: input.nextAttemptAt,
      });
      const key = compositeKey(parsed.connectionId, parsed.dataType);
      const current = healthCursors.get(key);
      healthCursors.set(key, cloneCursor({
        ...parsed,
        successfulWatermark: current?.successfulWatermark,
      }));
    },
    async listDueCursors(input) {
      return [...healthCursors.values()]
        .filter((row) => (
          row.nextAttemptAt
          && row.nextAttemptAt.getTime() <= input.now.getTime()
          && (!input.connectionId || row.connectionId === input.connectionId)
        ))
        .sort((left, right) => {
          const byDue = left.nextAttemptAt!.getTime() - right.nextAttemptAt!.getTime();
          return byDue || left.connectionId.localeCompare(right.connectionId) || left.dataType.localeCompare(right.dataType);
        })
        .map(cloneCursor);
    },
    async insertSleepGoal(goal) {
      const parsed = parseSleepGoal(goal);
      const key = compositeKey(parsed.userId, parsed.effectiveCivilDate);
      if (sleepGoals.has(key)) throw new SleepGoalConflictError();
      sleepGoals.set(key, structuredClone(parsed));
    },
    async lookupSleepGoal(input) {
      const match = [...sleepGoals.values()]
        .filter((row) => row.userId === input.userId && row.effectiveCivilDate <= input.civilDate)
        .sort((left, right) => right.effectiveCivilDate.localeCompare(left.effectiveCivilDate))[0];
      return match ? structuredClone(match) : undefined;
    },
    async insertTimeZoneHistory(row) {
      const parsed = parseHealthTimeZoneHistory(row);
      const key = compositeKey(parsed.userId, parsed.effectiveAt);
      if (timeZoneHistory.has(key)) throw new TimeZoneHistoryConflictError();
      if (parsed.isBackfillAnchor) {
        for (const existing of timeZoneHistory.values()) {
          if (existing.userId === parsed.userId && existing.isBackfillAnchor) {
            throw new TimeZoneHistoryConflictError();
          }
        }
      }
      timeZoneHistory.set(key, structuredClone(parsed));
    },
    async lookupTimeZoneHistory(input) {
      const at = Date.parse(input.at);
      const match = [...timeZoneHistory.values()]
        .filter((row) => row.userId === input.userId && Date.parse(row.effectiveAt) <= at)
        .sort((left, right) => Date.parse(right.effectiveAt) - Date.parse(left.effectiveAt))[0];
      return match ? structuredClone(match) : undefined;
    },
    async listTimeZoneHistory(userId) {
      return [...timeZoneHistory.values()]
        .filter((row) => row.userId === userId)
        .sort((left, right) => Date.parse(left.effectiveAt) - Date.parse(right.effectiveAt))
        .map((row) => structuredClone(row));
    },
    async getBodyAgeProfile(input) {
      const parsed = parseBodyAgeProfileRead(input);
      const row = bodyAgeProfiles.get(parsed.userId);
      return row ? structuredClone(row) : undefined;
    },
    async updateBodyAgeProfile(input) {
      const parsed = parseBodyAgeProfileUpdate(input);
      const current = bodyAgeProfiles.get(parsed.userId);
      const changed = !current
        ? parsed.birthDate !== null || parsed.referenceSex !== null
        : current.birthDate !== (parsed.birthDate ?? undefined)
          || current.referenceSex !== (parsed.referenceSex ?? undefined);
      const next = parseStoredBodyAgeProfile({
        userId: parsed.userId,
        birthDate: parsed.birthDate ?? undefined,
        referenceSex: parsed.referenceSex ?? undefined,
        profileRevision: (current?.profileRevision ?? 0) + (changed ? 1 : 0),
        observedHrPeakBpm: current?.observedHrPeakBpm,
        firstObservedHrPeakAt: current?.firstObservedHrPeakAt,
        latestObservedHrPeakAt: current?.latestObservedHrPeakAt,
      });
      bodyAgeProfiles.set(parsed.userId, structuredClone(next));
      return structuredClone(next);
    },
    async recordObservedHrPeak(input) {
      const parsed = parseObservedHrPeakWrite(input);
      const current = bodyAgeProfiles.get(parsed.userId);
      const next = parseStoredBodyAgeProfile({
        userId: parsed.userId,
        birthDate: current?.birthDate,
        referenceSex: current?.referenceSex,
        profileRevision: current?.profileRevision ?? 0,
        observedHrPeakBpm: Math.max(current?.observedHrPeakBpm ?? parsed.observedHrPeakBpm, parsed.observedHrPeakBpm),
        firstObservedHrPeakAt: current?.firstObservedHrPeakAt
          ? (current.firstObservedHrPeakAt < parsed.observedAt ? current.firstObservedHrPeakAt : parsed.observedAt)
          : parsed.observedAt,
        latestObservedHrPeakAt: current?.latestObservedHrPeakAt
          ? (current.latestObservedHrPeakAt > parsed.observedAt ? current.latestObservedHrPeakAt : parsed.observedAt)
          : parsed.observedAt,
      });
      bodyAgeProfiles.set(parsed.userId, structuredClone(next));
      return structuredClone(next);
    },
    async upsertDailyVo2(rows) {
      for (const parsed of normalizeDailyVo2Writes(rows)) {
        const key = compositeKey(parsed.userId, parsed.civilDate);
        const current = dailyVo2.get(key);
        dailyVo2.set(key, structuredClone(current ? selectNewestDailyVo2(current, parsed) : parsed));
      }
    },
    async authoritativelyReplaceDailyVo2(input) {
      if (!options.transactionChild) {
        return store.withTransaction((inner) => inner.healthMetrics.authoritativelyReplaceDailyVo2(input));
      }
      const parsed = parseAuthoritativeDailyVo2Replace(input);
      await healthMetrics.upsertDailyVo2(parsed.rows);
      const retainedDates = new Set(parsed.rows.map((row) => row.civilDate));
      for (const [key, row] of dailyVo2) {
        if (
          row.userId === parsed.userId
          && row.civilDate >= parsed.fromCivilDate
          && row.civilDate <= parsed.toCivilDate
          && !retainedDates.has(row.civilDate)
        ) {
          dailyVo2.delete(key);
        }
      }
    },
    async listDailyVo2(input) {
      const parsed = parseDailyVo2ListInput(input);
      return [...dailyVo2.values()]
        .filter((row) => (
          row.userId === parsed.userId
          && row.civilDate >= parsed.fromCivilDate
          && row.civilDate <= parsed.toCivilDate
        ))
        .sort((left, right) => left.civilDate.localeCompare(right.civilDate))
        .map((row) => structuredClone(row));
    },
    async writeBodyAgeResult(input) {
      const parsed = parseBodyAgeResultWrite(input);
      bodyAgeResults.set(compositeKey(parsed.userId, parsed.algorithmVersion), structuredClone(parsed));
    },
    async readLatestBodyAgeResult(input) {
      const parsed = parseBodyAgeResultRead(input);
      const row = bodyAgeResults.get(compositeKey(parsed.userId, parsed.algorithmVersion));
      return row ? structuredClone(row) : undefined;
    },
    async deleteForUser(userId) {
      const removeUser = <T extends { userId: string }>(map: Map<string, T>) => {
        for (const [key, row] of map) {
          if (row.userId === userId) map.delete(key);
        }
      };
      removeUser(heartRateMinutes);
      removeUser(activityLevelIntervals);
      removeUser(heartRateZones);
      removeUser(timeInZone);
      removeUser(exerciseIntervals);
      removeUser(dailyCardio);
      removeUser(metricResults);
      removeUser(sleepGoals);
      removeUser(timeZoneHistory);
      removeUser(bodyAgeProfiles);
      removeUser(dailyVo2);
      removeUser(bodyAgeResults);
      const connectionIds = new Set(
        [...connections.values()].filter((row) => row.userId === userId).map((row) => row.id),
      );
      for (const [key, row] of healthCursors) {
        if (connectionIds.has(row.connectionId)) healthCursors.delete(key);
      }
    },
  };

  store = {
    async withTransaction<T>(fn: (inner: AuthStore) => Promise<T>): Promise<T> {
      return serializeRootTransaction(async () => {
        const parentSnapshot = snapshotState();
        const child = createMemoryStore({ transactionChild: true });
        const childInternals = memoryStoreInternals.get(child);
        if (!childInternals) throw new Error('memory transaction child is unavailable');
        childInternals.restoreState(parentSnapshot);
        const result = await fn(child);
        if (!isDeepStrictEqual(snapshotState(), parentSnapshot)) {
          throw new MemoryStoreTransactionConflictError();
        }
        restoreState(childInternals.snapshotState() as ReturnType<typeof snapshotState>);
        return result;
      });
    },
    async withScheduledSyncLease<T>(lease: ScheduledSyncLease, fn: (inner: AuthStore) => Promise<T>, leaseOptions?: { allowPastDeadline?: boolean }): Promise<T> {
      if (!options.transactionChild) {
        return store.withTransaction((inner) => inner.withScheduledSyncLease(lease, fn, leaseOptions));
      }
      const current = connections.get(lease.connectionId);
      if (
        !current ||
        current.userId !== lease.userId ||
        current.syncLeaseToken !== lease.leaseToken ||
        !current.syncLeaseUntil ||
        current.syncLeaseUntil.getTime() <= lease.now.getTime() ||
        (!leaseOptions?.allowPastDeadline && lease.deadlineAt.getTime() <= lease.now.getTime())
      ) {
        throw new Error('sync lease no longer held');
      }
      return fn(store);
    },
    users: {
      async insert(id: string): Promise<void> {
        users.add(id);
      },
      async setNutritionWritebackEnabled(id: string, enabled: boolean): Promise<void> {
        writebackEnabled.set(id, enabled);
      },
      async nutritionWritebackEnabled(id: string): Promise<boolean> {
        return writebackEnabled.get(id) === true;
      },
    },
    meals: {
      async insertDraft(input): Promise<MealDraftRow> {
        const row: MealDraftRow = {
          id: randomUUID(),
          userId: input.userId,
          mealType: input.mealType,
          eatenAt: new Date(input.eatenAt),
          vision: structuredClone(input.vision),
          createdAt: input.now,
          updatedAt: input.now,
        };
        drafts.set(row.id, row);
        return structuredClone(row);
      },
      async findDraft(userId, id): Promise<MealDraftRow | undefined> {
        const row = drafts.get(id);
        if (!row || row.userId !== userId) {
          return undefined;
        }
        return structuredClone(row);
      },
      async confirmDraft(input) {
        const draft = drafts.get(input.draftId);
        if (!draft || draft.userId !== input.userId) {
          return { ok: false as const, reason: '草稿不存在' };
        }
        const enabled = writebackEnabled.get(input.userId) === true;
        const resolved = await resolveDraftNutrition(draft, input.catalog);
        const result = confirmDraftRows(draft, input, enabled, resolved);
        if (!result.ok) {
          return result;
        }
        versions.push(result.version);
        dishes.push(...result.dishes);
        ingredients.push(...result.ingredients);
        nutrients.push(...result.nutrients);
        provenance.push(...result.provenance);
        outbox.push(...result.outbox);
        drafts.delete(draft.id);
        return result;
      },
      async listVersions(userId): Promise<MealVersionRow[]> {
        return versions.filter((row) => row.userId === userId).map((row) => ({ ...row }));
      },
      async listIngredients(userId, versionId) {
        const dishIds = new Set(dishes.filter((row) => row.userId === userId && row.versionId === versionId).map((row) => row.id));
        return ingredients.filter((row) => row.userId === userId && dishIds.has(row.dishId)).map((row) => ({ ...row }));
      },
      async listNutrients(userId, versionId) {
        const dishIds = new Set(dishes.filter((row) => row.userId === userId && row.versionId === versionId).map((row) => row.id));
        return nutrients.filter((row) => row.userId === userId && dishIds.has(row.dishId)).map((row) => ({ ...row }));
      },
    },
    currentMeals: {
      async insertEditorDraft(input) {
        const editor = parseEditorForCurrentMeal(input.editor, input.id);
        if (editor.mealType !== input.mealType) throw new Error('editor meal type must match draft meal type');
        if (new Date(editor.eatenAt).getTime() !== input.eatenAt.getTime()) {
          throw new Error('editor eaten at must match draft eaten at');
        }
        const row: MealDraftRow = {
          id: input.id,
          userId: input.userId,
          mealType: input.mealType,
          eatenAt: new Date(input.eatenAt),
          vision: structuredClone(input.vision),
          createdAt: new Date(input.now),
          updatedAt: new Date(input.now),
        };
        drafts.set(row.id, row);
        editorDrafts.set(row.id, structuredClone(editor));
        return structuredClone(editor);
      },
      async findEditorDraft(userId, id) {
        const draft = drafts.get(id);
        const editor = editorDrafts.get(id);
        if (!draft || draft.userId !== userId || !editor) return undefined;
        return structuredClone(editor);
      },
      async replaceEditorDraft(input) {
        const draft = drafts.get(input.id);
        if (!draft || draft.userId !== input.userId || !editorDrafts.has(input.id)) return undefined;
        const editor = parseEditorForCurrentMeal(input.editor, input.id);
        drafts.set(input.id, { ...draft, updatedAt: new Date(input.now) });
        editorDrafts.set(input.id, structuredClone(editor));
        return structuredClone(editor);
      },
      async saveEditorDraft(input) {
        const draft = drafts.get(input.draftId);
        const editor = editorDrafts.get(input.draftId);
        if (!draft || draft.userId !== input.userId || !editor) throw new Error('editor draft not found');
        const snapshot: CurrentMealSnapshot = {
          id: draft.id,
          userId: draft.userId,
          mealType: parseEditorForCurrentMeal(editor, draft.id).mealType,
          eatenAt: new Date(editor.eatenAt),
          contentRevision: 1,
          syncState: 'unsynced',
          lastSyncedGenerationId: undefined,
          dishes: structuredClone(editor.dishes),
          nutrients: structuredClone(editor.nutrients),
          createdAt: new Date(input.now),
          updatedAt: new Date(input.now),
        };
        currentMeals.set(snapshot.id, snapshot);
        replaceCurrentChildren(snapshot);
        editorDrafts.delete(draft.id);
        drafts.delete(draft.id);
        return cloneCurrentMeal(snapshot);
      },
      async findCurrentMeal(userId, id) {
        const snapshot = currentMeals.get(id);
        return snapshot && snapshot.userId === userId ? cloneCurrentMeal(snapshot) : undefined;
      },
      async lockCurrentMealForEdit(userId, id) {
        const snapshot = currentMeals.get(id);
        return snapshot && snapshot.userId === userId ? cloneCurrentMeal(snapshot) : undefined;
      },
      async replaceCurrentMealContent(input) {
        const current = currentMeals.get(input.mealId);
        if (!current || current.userId !== input.userId) return undefined;
        if (current.syncState === 'syncing' || current.syncState === 'recovery') throw new CurrentMealEditLockedError();
        const editor = parseEditorForCurrentMeal(input.editor, input.mealId);
        if (!hasMeaningfulCurrentContentChange(current, editor)) return cloneCurrentMeal(current);
        const next: CurrentMealSnapshot = {
          ...current,
          mealType: editor.mealType,
          eatenAt: new Date(editor.eatenAt),
          dishes: structuredClone(editor.dishes),
          nutrients: structuredClone(editor.nutrients),
          contentRevision: current.contentRevision + 1,
          syncState: 'unsynced',
          updatedAt: new Date(input.now),
        };
        currentMeals.set(next.id, next);
        replaceCurrentChildren(next);
        return cloneCurrentMeal(next);
      },
      async setCurrentMealNutrient(input) {
        const current = currentMeals.get(input.mealId);
        if (!current || current.userId !== input.userId) return undefined;
        if (current.syncState === 'syncing' || current.syncState === 'recovery') throw new CurrentMealEditLockedError();
        const existing = current.nutrients.find((nutrient) => nutrient.dishId === input.dishId && nutrient.nutrientCode === input.nutrientCode);
        if (!existing) throw new Error(`unknown nutrient: ${input.nutrientCode}`);
        const internal = toInternalNutrientAmount(input.nutrientCode, input.value, input.unit);
        return store.currentMeals!.replaceCurrentMealContent({
          userId: input.userId,
          mealId: input.mealId,
          editor: {
            view: 'draft',
            mealId: input.mealId,
            mealType: current.mealType,
            eatenAt: current.eatenAt.toISOString(),
            dishes: structuredClone(current.dishes),
            nutrients: current.nutrients.map((nutrient) => nutrient === existing ? {
              ...nutrient, value: internal.value, unit: internal.unit, source: 'user_edit',
            } : structuredClone(nutrient)),
          },
          now: input.now,
        });
      },
    },
    mealSync,
    connections: {
      async findByHealthUserId(healthUserId: string): Promise<ConnectionRow | undefined> {
        const row = [...connections.values()].find((item) => item.healthUserId === healthUserId);
        return row ? cloneConnection(row) : undefined;
      },
      async findByUserId(userId: string): Promise<ConnectionRow | undefined> {
        const row = [...connections.values()].find((item) => item.userId === userId);
        return row ? cloneConnection(row) : undefined;
      },
      async findByHealthUserIdForUpdate(healthUserId: string): Promise<ConnectionRow | undefined> {
        const row = [...connections.values()].find((item) => item.healthUserId === healthUserId);
        return row ? cloneConnection(row) : undefined;
      },
      async findByUserIdForUpdate(userId: string): Promise<ConnectionRow | undefined> {
        const row = [...connections.values()].find((item) => item.userId === userId);
        return row ? cloneConnection(row) : undefined;
      },
      async insert(row: ConnectionRow): Promise<void> {
        connections.set(row.id, cloneConnection(row));
      },
      async update(row: ConnectionRow): Promise<void> {
        connections.set(row.id, cloneConnection(row));
      },
      async updateAccessTokenIfSyncable(input): Promise<boolean> {
        const current = connections.get(input.id);
        if (
          !current || current.userId !== input.userId || (current.status !== 'active' && current.status !== 'partial') ||
          (input.lease && (
            current.syncLeaseToken !== input.lease.leaseToken ||
            !current.syncLeaseUntil ||
            current.syncLeaseUntil.getTime() <= input.lease.now.getTime() ||
            input.lease.deadlineAt.getTime() <= input.lease.now.getTime()
          ))
        ) {
          return false;
        }
        connections.set(
          current.id,
          cloneConnection({
            ...current,
            tokenEnvelopeCiphertext: input.tokenEnvelopeCiphertext,
            tokenEnvelopeIv: input.tokenEnvelopeIv,
            tokenEnvelopeAuthTag: input.tokenEnvelopeAuthTag,
            encryptionKeyVersion: input.encryptionKeyVersion,
            accessTokenExpiresAt: input.accessTokenExpiresAt,
            refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? current.refreshTokenExpiresAt,
            updatedAt: input.updatedAt,
          }),
        );
        return true;
      },
      async markLastSuccessfulSyncIfSyncable(input): Promise<boolean> {
        const current = connections.get(input.id);
        if (
          !current || current.userId !== input.userId || (current.status !== 'active' && current.status !== 'partial') ||
          (input.lease && (
            current.syncLeaseToken !== input.lease.leaseToken ||
            !current.syncLeaseUntil ||
            current.syncLeaseUntil.getTime() <= input.lease.now.getTime() ||
            input.lease.deadlineAt.getTime() <= input.lease.now.getTime()
          ))
        ) {
          return false;
        }
        connections.set(
          current.id,
          cloneConnection({
            ...current,
            lastSuccessfulSyncAt: input.syncedAt,
            updatedAt: input.syncedAt,
          }),
        );
        return true;
      },
      async claimDueSyncs(input) {
        const due = [...connections.values()]
          .filter(
            (row) =>
              (row.status === 'active' || row.status === 'partial') &&
              (!input.userId || row.userId === input.userId) &&
              Boolean(row.tokenEnvelopeCiphertext) &&
              (!row.refreshTokenExpiresAt || row.refreshTokenExpiresAt.getTime() > input.now.getTime()) &&
              Boolean(
                (row.nextSyncAt &&
                  row.nextSyncAt.getTime() <= input.now.getTime() &&
                  (!row.syncLeaseUntil || row.syncLeaseUntil.getTime() <= input.now.getTime())) ||
                (!row.nextSyncAt && row.syncLeaseUntil && row.syncLeaseUntil.getTime() <= input.now.getTime()),
              ),
          )
          .sort((left, right) => {
            const byDue = (left.nextSyncAt ?? left.syncLeaseUntil)!.getTime() - (right.nextSyncAt ?? right.syncLeaseUntil)!.getTime();
            return byDue || left.id.localeCompare(right.id);
          })
          .slice(0, input.limit);
        const claimed = due.map((row) => ({ row, leaseToken: randomUUID() }));
        for (const { row, leaseToken } of claimed) {
          connections.set(
            row.id,
            cloneConnection({
              ...row,
              syncLeaseUntil: input.leaseUntil,
              syncLeaseToken: leaseToken,
              lastSyncAttemptAt: input.now,
              updatedAt: input.now,
              nextSyncAt: undefined,
            }),
          );
        }
        return claimed.map(({ row, leaseToken }) =>
          cloneConnection({
            ...row,
            syncLeaseUntil: input.leaseUntil,
            syncLeaseToken: leaseToken,
            lastSyncAttemptAt: input.now,
            updatedAt: input.now,
            nextSyncAt: undefined,
          }),
        );
      },
      async finishScheduledSync(input): Promise<boolean> {
        const current = connections.get(input.id);
        if (
          !current ||
          current.userId !== input.userId ||
          (current.status !== 'active' && current.status !== 'partial') ||
          !current.syncLeaseUntil ||
          current.syncLeaseUntil.getTime() !== input.leaseUntil.getTime() ||
          current.syncLeaseToken !== input.leaseToken ||
          current.syncLeaseUntil.getTime() <= input.now.getTime() ||
          (input.lastErrorCode === undefined && input.deadlineAt.getTime() <= input.now.getTime())
        ) {
          return false;
        }
        const keepExternalSchedule = current.nextSyncAt !== undefined;
        connections.set(
          current.id,
          cloneConnection({
            ...current,
            nextSyncAt: keepExternalSchedule ? current.nextSyncAt : input.nextSyncAt,
            syncRetryCount: keepExternalSchedule ? current.syncRetryCount : input.syncRetryCount,
            syncLeaseUntil: undefined,
            syncLeaseToken: undefined,
            lastErrorCode: keepExternalSchedule ? current.lastErrorCode : input.lastErrorCode,
            updatedAt: input.now,
          }),
        );
        return true;
      },
      async expireIfSyncable(input): Promise<boolean> {
        const current = connections.get(input.id);
        if (
          !current ||
          current.userId !== input.userId ||
          (current.status !== 'active' && current.status !== 'partial') ||
          !current.syncLeaseUntil ||
          current.syncLeaseUntil.getTime() !== input.leaseUntil.getTime() ||
          current.syncLeaseToken !== input.leaseToken ||
          current.syncLeaseUntil.getTime() <= input.now.getTime() ||
          !envelopesEqual(current.tokenEnvelopeCiphertext, input.tokenEnvelopeCiphertext)
        ) {
          return false;
        }
        connections.set(
          current.id,
          cloneConnection({
            ...current,
            status: 'expired',
            nextSyncAt: undefined,
            syncRetryCount: 0,
            syncLeaseUntil: undefined,
            syncLeaseToken: undefined,
            lastErrorCode: input.lastErrorCode,
            updatedAt: input.now,
          }),
        );
        return true;
      },
      async clearSyncLeaseIfHeld(input): Promise<boolean> {
        const current = connections.get(input.id);
        if (
          !current ||
          current.userId !== input.userId ||
          !current.syncLeaseUntil ||
          current.syncLeaseUntil.getTime() !== input.leaseUntil.getTime() ||
          current.syncLeaseToken !== input.leaseToken ||
          current.syncLeaseUntil.getTime() <= input.now.getTime()
        ) {
          return false;
        }
        connections.set(current.id, cloneConnection({ ...current, syncLeaseUntil: undefined, syncLeaseToken: undefined, updatedAt: input.now }));
        return true;
      },
    },
    sessions: {
      async insert(row: SessionRow): Promise<void> {
        sessions.set(row.tokenHash.toString('hex'), { ...row, tokenHash: Buffer.from(row.tokenHash) });
      },
      async findByTokenHash(tokenHash: Buffer): Promise<SessionRow | undefined> {
        const row = sessions.get(tokenHash.toString('hex'));
        return row ? { ...row, tokenHash: Buffer.from(row.tokenHash) } : undefined;
      },
      async deleteByTokenHash(tokenHash: Buffer): Promise<void> {
        sessions.delete(tokenHash.toString('hex'));
      },
      async deleteAllForUser(userId: string): Promise<void> {
        for (const [key, row] of sessions) {
          if (row.userId === userId) {
            sessions.delete(key);
          }
        }
      },
    },
    healthSnapshots: {
      async deleteForUser(userId: string): Promise<void> {
        deletedHealthSnapshotUserIds.push(userId);
      },
    },
    healthMetrics,
    foodComposition: {
      async findExactFood(nameZh: string): Promise<LocalTwFdaFood | undefined> {
        return resolveExactTwFdaFood(nameZh, foodComposition);
      },
    },
    nutritionOutbox: {
      async claimDue(input) {
        const due = outbox
          .filter(
            (row) =>
              (row.status === 'write_pending' || row.status === 'retrying' || row.status === 'operation_pending') &&
              (!row.nextAttemptAt || row.nextAttemptAt.getTime() <= input.now.getTime()) &&
              (!row.leaseUntil || row.leaseUntil.getTime() <= input.now.getTime()),
          )
          .sort((left, right) => (left.nextAttemptAt?.getTime() ?? 0) - (right.nextAttemptAt?.getTime() ?? 0) || left.id.localeCompare(right.id))
          .slice(0, input.limit);
        for (const row of due) {
          row.leaseUntil = new Date(input.leaseUntil);
          row.lastAttemptAt = new Date(input.now);
          row.attemptCount = (row.attemptCount ?? 0) + 1;
          row.nextAttemptAt = undefined;
        }
        return due.map(cloneOutbox);
      },
      async markSynced(input) {
        const row = outbox.find((item) => item.id === input.id);
        if (!ownsOutboxLease(row, input)) {
          return false;
        }
        row.status = 'synced';
        row.leaseUntil = undefined;
        row.nextAttemptAt = undefined;
        row.lastErrorCode = undefined;
        return true;
      },
      async markRetrying(input) {
        const row = outbox.find((item) => item.id === input.id);
        if (!ownsOutboxLease(row, input)) {
          return false;
        }
        row.status = 'retrying';
        row.leaseUntil = undefined;
        row.nextAttemptAt = new Date(input.nextAttemptAt);
        row.lastErrorCode = input.errorCode;
        return true;
      },
      async markFailedActionRequired(input) {
        const row = outbox.find((item) => item.id === input.id);
        if (!ownsOutboxLease(row, input)) {
          return false;
        }
        row.status = 'failed_action_required';
        row.leaseUntil = undefined;
        row.nextAttemptAt = undefined;
        row.lastErrorCode = input.errorCode;
        return true;
      },
      async markUnknown(input) {
        const row = outbox.find((item) => item.id === input.id);
        if (!ownsOutboxLease(row, input)) {
          return false;
        }
        row.status = 'unknown';
        row.leaseUntil = undefined;
        row.nextAttemptAt = undefined;
        row.lastErrorCode = input.errorCode;
        return true;
      },
      async markOperationPending(input) {
        const row = outbox.find((item) => item.id === input.id);
        if (!ownsOutboxLease(row, input)) {
          return false;
        }
        row.status = 'operation_pending';
        row.leaseUntil = undefined;
        row.googleOperationName = input.operationName;
        row.nextAttemptAt = new Date(input.nextAttemptAt);
        row.lastErrorCode = undefined;
        return true;
      },
    },
    transactions: {
      async insert(row: OauthTransactionRow): Promise<void> {
        transactions.set(row.id, { ...row });
      },
      async findById(id: string): Promise<OauthTransactionRow | undefined> {
        const row = transactions.get(id);
        return row ? { ...row } : undefined;
      },
      async deleteById(id: string): Promise<void> {
        transactions.delete(id);
      },
      async deleteExpired(now: Date): Promise<void> {
        for (const [id, row] of transactions) {
          if (row.expiresAt.getTime() <= now.getTime()) {
            transactions.delete(id);
          }
        }
      },
    },
  };

  const memoryStore = Object.assign(store, {
    deletedHealthSnapshotUserIds,
    seedFoodComposition(foods: LocalTwFdaFood[]) {
      foodComposition = structuredClone(foods);
    },
    outboxRows() {
      return outbox.map(cloneOutbox);
    },
    currentMealSnapshots() {
      return [...currentMeals.values()].map(cloneCurrentMeal);
    },
    currentMealIngredients(mealId: string) {
      return structuredClone(currentIngredients.get(mealId) ?? []);
    },
    currentMealNutrients(mealId: string) {
      return structuredClone(currentNutrients.get(mealId) ?? []);
    },
    mealSyncPoints() {
      return [...syncPoints.values()].map(cloneMealSyncPoint);
    },
  }) as MemoryStore;
  memoryStoreInternals.set(memoryStore, {
    snapshotState,
    restoreState(state) {
      restoreState(state as ReturnType<typeof snapshotState>);
    },
  });
  return memoryStore;
}
