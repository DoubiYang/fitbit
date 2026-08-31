import pg from 'pg';

import { randomUUID } from 'node:crypto';

import { editableMealDraftSchema, fromInternalNutrientAmount, toInternalNutrientAmount, type EditableMealDraft } from '../../domain/meal-editor';
import { parseVisionMeal } from '../../domain/meal-vision';
import { WHOOP_STYLE_METRIC_VERSION } from '../../domain/metric-types';
import type { AccessTokenUpdate, AuthStore, ConnectionExpire, ConnectionRow, DueSyncClaim, LastSuccessfulSyncUpdate, MealSyncStore, NutritionOutboxLease, OauthTransactionRow, ScheduledSyncFinish, SessionRow, SyncLeaseRelease } from '../auth/types';
import {
  HealthMetricsConnectionMismatchError,
  isUniqueViolation,
  mapActivityLevelIntervalRow,
  mapDailyCardioRow,
  mapDailyHeartRateZonesRow,
  mapDailyTimeInZoneRow,
  mapExerciseIntervalRow,
  mapHealthSyncCursorRow,
  mapHealthTimeZoneHistoryRow,
  mapHeartRateMinuteAggregateRow,
  mapMetricResultRow,
  mapSleepGoalRow,
  mergeHeartRateMinuteUpsert,
  parseActivityLevelInterval,
  parseDailyCardio,
  parseDailyHeartRateZones,
  parseDailyTimeInZone,
  parseExerciseInterval,
  parseHealthSyncCursor,
  parseHealthTimeZoneHistory,
  parseHeartRateMinuteAggregate,
  parseMetricResult,
  parseSleepGoal,
  SleepGoalConflictError,
  TimeZoneHistoryConflictError,
  type HealthMetricsStore,
  type HealthMetricsWindowWrite,
} from '../health/cardio-store';
import { confirmDraftRows, resolveDraftNutrition } from '../meals/confirm-draft';
import { buildCurrentMealGooglePayloads } from '../meals/current-meal';
import { CurrentMealEditLockedError, type CurrentMealSnapshot, type CurrentMealStore, type CurrentMealSyncState, type MealDraftRow, type MealSyncGenerationPhase, type MealSyncGenerationRow, type MealSyncPointRow, type MealSyncPointStatus, type MealType, type MealVersionRow, type OutboxRow } from '../meals/types';
import type { ConnectionStatus } from '../auth/scopes';
import { twFdaLookupKeys, type LocalTwFdaFood } from '../nutrition/tw-fda';

const pools = new Map<string, pg.Pool>();

function poolFor(databaseUrl: string): pg.Pool {
  const existing = pools.get(databaseUrl);
  if (existing) {
    return existing;
  }
  const created = new pg.Pool({ connectionString: databaseUrl });
  pools.set(databaseUrl, created);
  return created;
}

export type PostgresQueryable = {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
};

type Queryable = PostgresQueryable;
type TransactionClient = PostgresQueryable & { release(): void };
type TransactionStarter = PostgresQueryable & { connect(): Promise<TransactionClient> };

function canStartTransaction(queryable: Queryable): queryable is TransactionStarter {
  return typeof (queryable as { connect?: unknown }).connect === 'function';
}

function asBuffer(value: unknown): Buffer | undefined {
  if (!value) {
    return undefined;
  }
  return Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
}

function mapDraft(row: pg.QueryResult['rows'][number]): MealDraftRow {
  return {
    id: row.id,
    userId: row.user_id,
    mealType: row.meal_type,
    eatenAt: row.eaten_at,
    vision: parseVisionMeal(row.vision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVersion(row: pg.QueryResult['rows'][number]): MealVersionRow {
  return {
    id: row.id,
    userId: row.user_id,
    previousVersionId: row.previous_version_id ?? undefined,
    mealType: row.meal_type,
    eatenAt: row.eaten_at,
    writebackThisMeal: row.writeback_this_meal,
    confirmedAt: row.confirmed_at,
  };
}

function mapOutbox(row: pg.QueryResult['rows'][number]): OutboxRow {
  return {
    id: row.id,
    userId: row.user_id,
    dishId: row.dish_id,
    operation: row.operation,
    dataPointName: row.data_point_name,
    payload: row.payload ?? undefined,
    payloadHash: row.payload_hash ?? undefined,
    status: row.status,
    attemptCount: row.attempt_count ?? 0,
    nextAttemptAt: row.next_attempt_at ?? undefined,
    leaseUntil: row.lease_until ?? undefined,
    lastAttemptAt: row.last_attempt_at ?? undefined,
    lastErrorCode: row.last_error_code ?? undefined,
    googleOperationName: row.google_operation_name ?? undefined,
  };
}

function mapConnection(row: pg.QueryResult['rows'][number]): ConnectionRow {
  return {
    id: row.id,
    userId: row.user_id,
    healthUserId: row.health_user_id,
    legacyUserId: row.legacy_user_id ?? undefined,
    tokenEnvelopeCiphertext: asBuffer(row.token_envelope_ciphertext),
    tokenEnvelopeIv: asBuffer(row.token_envelope_iv),
    tokenEnvelopeAuthTag: asBuffer(row.token_envelope_auth_tag),
    encryptionKeyVersion: row.encryption_key_version ?? undefined,
    accessTokenExpiresAt: row.access_token_expires_at ?? undefined,
    refreshTokenExpiresAt: row.refresh_token_expires_at ?? undefined,
    grantedScopes: row.granted_scopes ?? [],
    status: row.status as ConnectionStatus,
    lastErrorCode: row.last_error_code ?? undefined,
    connectedAt: row.connected_at,
    updatedAt: row.updated_at,
    lastSuccessfulSyncAt: row.last_successful_sync_at ?? undefined,
    nextSyncAt: row.next_sync_at ?? undefined,
    syncRetryCount: row.sync_retry_count ?? 0,
    syncLeaseUntil: row.sync_lease_until ?? undefined,
    lastSyncAttemptAt: row.last_sync_attempt_at ?? undefined,
  };
}

const mealTypes = new Set<MealType>(['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK']);
const currentMealSyncStates = new Set<CurrentMealSyncState>(['unsynced', 'syncing', 'synced', 'recovery']);
const mealSyncGenerationPhases = new Set<MealSyncGenerationPhase>(['pending_delete', 'pending_create', 'synced', 'recovery']);
const mealSyncPointStatuses = new Set<MealSyncPointStatus>(['pending', 'leased', 'operation_pending', 'synced', 'retrying', 'unknown', 'failed_action_required']);

function parsedEditorForMeal(editor: unknown, mealId: string): EditableMealDraft & { mealType: MealType } {
  const parsed = editableMealDraftSchema.parse(editor);
  if (parsed.mealId !== mealId) throw new Error('editor meal id must match current meal id');
  if (!mealTypes.has(parsed.mealType as MealType)) throw new Error('editor meal type is invalid');
  return parsed as EditableMealDraft & { mealType: MealType };
}

function currentMealSnapshotFromEditor(input: {
  id: string;
  userId: string;
  editor: EditableMealDraft;
  contentRevision: number;
  syncState: CurrentMealSyncState;
  lastSyncedGenerationId: string | undefined;
  createdAt: Date;
  updatedAt: Date;
}): CurrentMealSnapshot {
  const editor = parsedEditorForMeal(input.editor, input.id);
  return {
    id: input.id,
    userId: input.userId,
    mealType: editor.mealType,
    eatenAt: new Date(editor.eatenAt),
    contentRevision: input.contentRevision,
    syncState: input.syncState,
    lastSyncedGenerationId: input.lastSyncedGenerationId,
    dishes: structuredClone(editor.dishes),
    nutrients: structuredClone(editor.nutrients),
    createdAt: new Date(input.createdAt),
    updatedAt: new Date(input.updatedAt),
  };
}

function hasMeaningfulCurrentContentChange(current: CurrentMealSnapshot, editor: EditableMealDraft): boolean {
  const normalize = (meal: Pick<EditableMealDraft, 'mealType' | 'dishes' | 'nutrients'> & { eatenAt: Date | string }) => ({
    mealType: meal.mealType,
    eatenAtMs: new Date(meal.eatenAt).getTime(),
    dishes: meal.dishes
      .map((dish) => ({
        id: dish.id,
        nameZh: dish.nameZh,
        portionGrams: dish.portionGrams,
        ingredients: dish.ingredients
          .map((ingredient) => ({
            nameZh: ingredient.nameZh,
            grams: ingredient.grams,
            foodSource: ingredient.foodSource,
            foodSourceId: ingredient.foodSourceId ?? null,
            foodSourceVersion: ingredient.foodSourceVersion ?? null,
          }))
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    nutrients: meal.nutrients
      .map((nutrient) => {
        const internal = toInternalNutrientAmount(nutrient.nutrientCode, nutrient.value, nutrient.unit);
        return {
          dishId: nutrient.dishId,
          nutrientCode: nutrient.nutrientCode,
          value: internal.value,
          unit: internal.unit,
          source: nutrient.source,
        };
      })
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  });
  return JSON.stringify(normalize(current)) !== JSON.stringify(normalize(editor));
}

function asDate(value: unknown, column: string): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`invalid ${column}`);
  return date;
}

function parseJsonObject(value: unknown, column: string): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`invalid ${column}`);
  return structuredClone(parsed as Record<string, unknown>);
}

function mapMealSyncGeneration(row: Record<string, unknown>): MealSyncGenerationRow {
  const phase = String(row.phase) as MealSyncGenerationPhase;
  if (!mealSyncGenerationPhases.has(phase)) throw new Error('invalid meal sync generation phase');
  return {
    id: String(row.id),
    mealId: String(row.meal_id),
    userId: String(row.user_id),
    contentRevision: Number(row.content_revision),
    phase,
    createdAt: asDate(row.created_at, 'meal_sync_generations.created_at'),
    updatedAt: asDate(row.updated_at, 'meal_sync_generations.updated_at'),
  };
}

function mapMealSyncPoint(row: Record<string, unknown>): MealSyncPointRow {
  const status = String(row.status) as MealSyncPointStatus;
  if (!mealSyncPointStatuses.has(status)) throw new Error('invalid meal sync point status');
  const role = row.role === 'delete_target' ? 'delete_target' : row.role === 'create_target' ? 'create_target' : undefined;
  if (!role) throw new Error('invalid meal sync point role');
  return {
    id: String(row.id),
    generationId: String(row.generation_id),
    userId: String(row.user_id),
    dishKey: String(row.dish_key),
    role,
    dataPointName: String(row.data_point_name),
    payload: parseJsonObject(row.payload, 'meal_sync_points.payload'),
    payloadHash: row.payload_hash ? String(row.payload_hash) : undefined,
    status,
    attemptCount: Number(row.attempt_count ?? 0),
    nextAttemptAt: row.next_attempt_at ? asDate(row.next_attempt_at, 'meal_sync_points.next_attempt_at') : undefined,
    leaseUntil: row.lease_until ? asDate(row.lease_until, 'meal_sync_points.lease_until') : undefined,
    lastAttemptAt: row.last_attempt_at ? asDate(row.last_attempt_at, 'meal_sync_points.last_attempt_at') : undefined,
    lastErrorCode: row.last_error_code ? String(row.last_error_code) : undefined,
    googleOperationName: row.google_operation_name ? String(row.google_operation_name) : undefined,
    recoveryState: row.recovery_state ? String(row.recovery_state) : undefined,
    recoveryRequestedAt: row.recovery_requested_at ? asDate(row.recovery_requested_at, 'meal_sync_points.recovery_requested_at') : undefined,
  };
}

function mapCurrentMealSnapshot(
  meal: Record<string, unknown>,
  dishes: Array<Record<string, unknown>>,
  ingredients: Array<Record<string, unknown>>,
  nutrients: Array<Record<string, unknown>>,
): CurrentMealSnapshot {
  const id = String(meal.id);
  const userId = String(meal.user_id);
  const syncState = String(meal.sync_state) as CurrentMealSyncState;
  if (!mealTypes.has(String(meal.meal_type) as MealType)) throw new Error('invalid current meal type');
  if (!currentMealSyncStates.has(syncState)) throw new Error('invalid current meal sync state');

  const ingredientsByDish = new Map<string, Array<Record<string, unknown>>>();
  for (const ingredient of ingredients) {
    const dishKey = String(ingredient.dish_key);
    const rows = ingredientsByDish.get(dishKey) ?? [];
    rows.push(ingredient);
    ingredientsByDish.set(dishKey, rows);
  }
  const nutrientEditorRows = nutrients.map((nutrient) => {
    const nutrientCode = String(nutrient.nutrient_code);
    const currentUnit = nutrient.current_unit === 'kcal' ? 'kcal' : nutrient.current_unit === 'g' ? 'g' : undefined;
    if (!currentUnit) throw new Error('invalid current nutrient unit');
    const internalValue = currentUnit === 'kcal' ? Number(nutrient.kcal) : Number(nutrient.grams);
    const amount = fromInternalNutrientAmount(nutrientCode, internalValue, String(nutrient.source_unit) as 'kcal' | 'g' | 'mg' | 'μg');
    return {
      dishId: String(nutrient.dish_key),
      nutrientCode,
      value: amount.value,
      unit: amount.unit,
      source: nutrient.source,
    };
  });
  const editor = parsedEditorForMeal({
    view: 'draft',
    mealId: id,
    mealType: String(meal.meal_type),
    eatenAt: asDate(meal.eaten_at, 'current_meals.eaten_at').toISOString(),
    dishes: dishes.map((dish) => ({
      id: String(dish.dish_key),
      nameZh: String(dish.name_zh),
      portionGrams: Number(dish.portion_grams),
      ingredients: (ingredientsByDish.get(String(dish.dish_key)) ?? []).map((ingredient) => ({
        nameZh: String(ingredient.name_zh),
        grams: Number(ingredient.grams),
        foodSource: ingredient.food_source,
        foodSourceId: ingredient.food_source_id ?? undefined,
        foodSourceVersion: ingredient.food_source_version ?? undefined,
      })),
    })),
    nutrients: nutrientEditorRows,
  }, id);
  return currentMealSnapshotFromEditor({
    id,
    userId,
    editor,
    contentRevision: Number(meal.content_revision),
    syncState,
    lastSyncedGenerationId: meal.last_synced_generation_id ? String(meal.last_synced_generation_id) : undefined,
    createdAt: asDate(meal.created_at, 'current_meals.created_at'),
    updatedAt: asDate(meal.updated_at, 'current_meals.updated_at'),
  });
}

function storeFor(queryable: Queryable): AuthStore {
  const connections = {
    async findByHealthUserId(healthUserId: string): Promise<ConnectionRow | undefined> {
      const result = await queryable.query('SELECT * FROM google_health_connections WHERE health_user_id = $1', [healthUserId]);
      return result.rows[0] ? mapConnection(result.rows[0]) : undefined;
    },
    async findByUserId(userId: string): Promise<ConnectionRow | undefined> {
      const result = await queryable.query('SELECT * FROM google_health_connections WHERE user_id = $1', [userId]);
      return result.rows[0] ? mapConnection(result.rows[0]) : undefined;
    },
    async insert(row: ConnectionRow): Promise<void> {
      await queryable.query(
        `INSERT INTO google_health_connections (
          id, user_id, health_user_id, legacy_user_id,
          token_envelope_ciphertext, token_envelope_iv, token_envelope_auth_tag, encryption_key_version,
          access_token_expires_at, refresh_token_expires_at, granted_scopes, status, last_error_code, connected_at, updated_at, last_successful_sync_at,
          next_sync_at, sync_retry_count, sync_lease_until, last_sync_attempt_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          row.id,
          row.userId,
          row.healthUserId,
          row.legacyUserId ?? null,
          row.tokenEnvelopeCiphertext ?? null,
          row.tokenEnvelopeIv ?? null,
          row.tokenEnvelopeAuthTag ?? null,
          row.encryptionKeyVersion ?? null,
          row.accessTokenExpiresAt ?? null,
          row.refreshTokenExpiresAt ?? null,
          row.grantedScopes,
          row.status,
          row.lastErrorCode ?? null,
          row.connectedAt,
          row.updatedAt,
          row.lastSuccessfulSyncAt ?? null,
          row.nextSyncAt ?? null,
          row.syncRetryCount ?? 0,
          row.syncLeaseUntil ?? null,
          row.lastSyncAttemptAt ?? null,
        ],
      );
    },
    async update(row: ConnectionRow): Promise<void> {
      await queryable.query(
        `UPDATE google_health_connections SET
          health_user_id = $2, legacy_user_id = $3,
          token_envelope_ciphertext = $4, token_envelope_iv = $5, token_envelope_auth_tag = $6, encryption_key_version = $7,
          access_token_expires_at = $8, refresh_token_expires_at = $9, granted_scopes = $10, status = $11, last_error_code = $12,
          connected_at = $13, updated_at = $14, last_successful_sync_at = $15,
          next_sync_at = $16, sync_retry_count = $17, sync_lease_until = $18, last_sync_attempt_at = $19
         WHERE id = $1`,
        [
          row.id,
          row.healthUserId,
          row.legacyUserId ?? null,
          row.tokenEnvelopeCiphertext ?? null,
          row.tokenEnvelopeIv ?? null,
          row.tokenEnvelopeAuthTag ?? null,
          row.encryptionKeyVersion ?? null,
          row.accessTokenExpiresAt ?? null,
          row.refreshTokenExpiresAt ?? null,
          row.grantedScopes,
          row.status,
          row.lastErrorCode ?? null,
          row.connectedAt,
          row.updatedAt,
          row.lastSuccessfulSyncAt ?? null,
          row.nextSyncAt ?? null,
          row.syncRetryCount ?? 0,
          row.syncLeaseUntil ?? null,
          row.lastSyncAttemptAt ?? null,
        ],
      );
    },
    async updateAccessTokenIfSyncable(input: AccessTokenUpdate): Promise<boolean> {
      const result = await queryable.query(
        `UPDATE google_health_connections SET
          token_envelope_ciphertext = $3, token_envelope_iv = $4, token_envelope_auth_tag = $5, encryption_key_version = $6,
          access_token_expires_at = $7, refresh_token_expires_at = COALESCE($8, refresh_token_expires_at), updated_at = $9
         WHERE id = $1 AND user_id = $2 AND status IN ('active', 'partial')`,
        [
          input.id,
          input.userId,
          input.tokenEnvelopeCiphertext,
          input.tokenEnvelopeIv,
          input.tokenEnvelopeAuthTag,
          input.encryptionKeyVersion,
          input.accessTokenExpiresAt,
          input.refreshTokenExpiresAt ?? null,
          input.updatedAt,
        ],
      );
      return result.rowCount === 1;
    },
    async markLastSuccessfulSyncIfSyncable(input: LastSuccessfulSyncUpdate): Promise<boolean> {
      const result = await queryable.query(
        `UPDATE google_health_connections
         SET last_successful_sync_at = $3, updated_at = $3
         WHERE id = $1 AND user_id = $2 AND status IN ('active', 'partial')`,
        [input.id, input.userId, input.syncedAt],
      );
      return result.rowCount === 1;
    },
    async claimDueSyncs(input: DueSyncClaim) {
      const values: unknown[] = [input.now, input.leaseUntil, input.limit];
      const userFilter = input.userId ? ` AND user_id = $${values.push(input.userId)}` : '';
      const result = await queryable.query(
        `WITH due AS (
           SELECT id
           FROM google_health_connections
           WHERE status IN ('active', 'partial')
             AND token_envelope_ciphertext IS NOT NULL
             AND (refresh_token_expires_at IS NULL OR refresh_token_expires_at > $1)
             AND next_sync_at IS NOT NULL
             AND next_sync_at <= $1
             AND (sync_lease_until IS NULL OR sync_lease_until <= $1)
             ${userFilter}
           ORDER BY next_sync_at ASC, id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $3
         )
         UPDATE google_health_connections AS connection
         SET sync_lease_until = $2, last_sync_attempt_at = $1, updated_at = $1, next_sync_at = NULL
         FROM due
         WHERE connection.id = due.id
         RETURNING connection.*`,
        values,
      );
      return result.rows.map(mapConnection);
    },
    async finishScheduledSync(input: ScheduledSyncFinish) {
      const result = await queryable.query(
        `UPDATE google_health_connections
         SET next_sync_at = CASE
               WHEN next_sync_at IS NOT NULL AND next_sync_at <= $7 THEN next_sync_at
               ELSE $4
             END,
             sync_retry_count = CASE
               WHEN next_sync_at IS NOT NULL AND next_sync_at <= $7 THEN sync_retry_count
               ELSE $5
             END,
             sync_lease_until = NULL,
             last_error_code = CASE
               WHEN next_sync_at IS NOT NULL AND next_sync_at <= $7 THEN last_error_code
               ELSE $6
             END,
             updated_at = $7
         WHERE id = $1
           AND user_id = $2
           AND status IN ('active', 'partial')
           AND sync_lease_until = $3`,
        [
          input.id,
          input.userId,
          input.leaseUntil,
          input.nextSyncAt,
          input.syncRetryCount,
          input.lastErrorCode ?? null,
          input.now,
        ],
      );
      return result.rowCount === 1;
    },
    async expireIfSyncable(input: ConnectionExpire): Promise<boolean> {
      const result = await queryable.query(
        `UPDATE google_health_connections
         SET status = 'expired', next_sync_at = NULL, sync_retry_count = 0, sync_lease_until = NULL,
             last_error_code = $3, updated_at = $4
         WHERE id = $1 AND user_id = $2 AND status IN ('active', 'partial')
           AND sync_lease_until = $5
           AND token_envelope_ciphertext IS NOT DISTINCT FROM $6`,
        [input.id, input.userId, input.lastErrorCode, input.now, input.leaseUntil, input.tokenEnvelopeCiphertext ?? null],
      );
      return result.rowCount === 1;
    },
    async clearSyncLeaseIfHeld(input: SyncLeaseRelease): Promise<boolean> {
      const result = await queryable.query(
        `UPDATE google_health_connections
         SET sync_lease_until = NULL, updated_at = $4
         WHERE id = $1 AND user_id = $2 AND sync_lease_until = $3`,
        [input.id, input.userId, input.leaseUntil, input.now],
      );
      return result.rowCount === 1;
    },
  };

  const foodComposition = {
    async findExactFood(nameZh: string): Promise<LocalTwFdaFood | undefined> {
      const lookupKeys = twFdaLookupKeys(nameZh);
      if (lookupKeys.length === 0) {
        return undefined;
      }
      const candidates = await queryable.query(
        `SELECT DISTINCT food.*
         FROM food_composition_aliases AS alias
         JOIN food_composition_foods AS food
           ON food.source_revision = alias.source_revision
          AND food.official_food_id = alias.official_food_id
         JOIN food_composition_sources AS source
           ON source.source_revision = food.source_revision
         WHERE source.is_current = true
           AND alias.normalized_alias = ANY($1)
         ORDER BY food.official_food_id ASC`,
        [lookupKeys],
      );
      if (candidates.rows.length !== 1) {
        return undefined;
      }
      const food = candidates.rows[0]!;
      const [aliases, nutrients] = await Promise.all([
        queryable.query(
          `SELECT display_alias
           FROM food_composition_aliases
           WHERE source_revision = $1 AND official_food_id = $2
           ORDER BY display_alias ASC`,
          [food.source_revision, food.official_food_id],
        ),
        queryable.query(
          `SELECT official_nutrient_name, raw_unit, per_100g_value
           FROM food_composition_nutrients
           WHERE source_revision = $1 AND official_food_id = $2
           ORDER BY official_nutrient_name ASC`,
          [food.source_revision, food.official_food_id],
        ),
      ]);
      return {
        sourceRevision: food.source_revision,
        officialFoodId: food.official_food_id,
        nameZh: food.name_zh,
        aliases: aliases.rows.map((row) => row.display_alias),
        nutrients: nutrients.rows.map((row) => ({
          officialName: row.official_nutrient_name,
          rawUnit: row.raw_unit,
          per100gValue: Number(row.per_100g_value),
        })),
      };
    },
  };

  const nutritionOutbox = {
    async claimDue(input: { now: Date; leaseUntil: Date; limit: number }): Promise<OutboxRow[]> {
      const result = await queryable.query(
        `WITH due AS (
           SELECT id
           FROM nutrition_write_outbox
           WHERE status IN ('write_pending', 'retrying', 'operation_pending')
             AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
             AND (lease_until IS NULL OR lease_until <= $1)
           ORDER BY COALESCE(next_attempt_at, created_at) ASC, id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $3
         )
         UPDATE nutrition_write_outbox AS outbox
         SET lease_until = $2,
             last_attempt_at = $1,
             next_attempt_at = NULL,
             attempt_count = outbox.attempt_count + 1,
             updated_at = $1
         FROM due
         WHERE outbox.id = due.id
         RETURNING outbox.*`,
        [input.now, input.leaseUntil, input.limit],
      );
      return result.rows.map(mapOutbox);
    },
    async markSynced(input: NutritionOutboxLease) {
      if (canStartTransaction(queryable)) {
        return store.withTransaction((inner) => inner.nutritionOutbox.markSynced(input));
      }
      const result = await queryable.query(
        `UPDATE nutrition_write_outbox
         SET status = 'synced', lease_until = NULL, next_attempt_at = NULL,
             last_error_code = NULL, updated_at = $4
         WHERE id = $1 AND user_id = $2 AND lease_until = $3
         RETURNING dish_id, user_id, data_point_name`,
        [input.id, input.userId, input.leaseUntil, input.now],
      );
      const row = result.rows[0];
      if (!row) {
        return false;
      }
      await queryable.query(
        `INSERT INTO google_nutrition_links (dish_id, user_id, data_point_name)
         VALUES ($1,$2,$3)
         ON CONFLICT (dish_id) DO UPDATE SET data_point_name = EXCLUDED.data_point_name`,
        [row.dish_id, row.user_id, row.data_point_name],
      );
      return true;
    },
    async markRetrying(input: NutritionOutboxLease & { nextAttemptAt: Date; errorCode: string }) {
      const result = await queryable.query(
        `UPDATE nutrition_write_outbox
         SET status = 'retrying', lease_until = NULL, next_attempt_at = $4,
             last_error_code = $5, updated_at = $6
         WHERE id = $1 AND user_id = $2 AND lease_until = $3`,
        [input.id, input.userId, input.leaseUntil, input.nextAttemptAt, input.errorCode, input.now],
      );
      return result.rowCount === 1;
    },
    async markFailedActionRequired(input: NutritionOutboxLease & { errorCode: string }) {
      const result = await queryable.query(
        `UPDATE nutrition_write_outbox
         SET status = 'failed_action_required', lease_until = NULL, next_attempt_at = NULL,
             last_error_code = $4, updated_at = $5
         WHERE id = $1 AND user_id = $2 AND lease_until = $3`,
        [input.id, input.userId, input.leaseUntil, input.errorCode, input.now],
      );
      return result.rowCount === 1;
    },
    async markUnknown(input: NutritionOutboxLease & { errorCode: string }) {
      const result = await queryable.query(
        `UPDATE nutrition_write_outbox
         SET status = 'unknown', lease_until = NULL, next_attempt_at = NULL,
             last_error_code = $4, updated_at = $5
         WHERE id = $1 AND user_id = $2 AND lease_until = $3`,
        [input.id, input.userId, input.leaseUntil, input.errorCode, input.now],
      );
      return result.rowCount === 1;
    },
    async markOperationPending(input: NutritionOutboxLease & { operationName: string; nextAttemptAt: Date }) {
      const result = await queryable.query(
        `UPDATE nutrition_write_outbox
         SET status = 'operation_pending', lease_until = NULL, next_attempt_at = $4,
             google_operation_name = $5, last_error_code = NULL, updated_at = $6
         WHERE id = $1 AND user_id = $2 AND lease_until = $3`,
        [input.id, input.userId, input.leaseUntil, input.nextAttemptAt, input.operationName, input.now],
      );
      return result.rowCount === 1;
    },
  };

  async function readCurrentMeal(userId: string, mealId: string, lock = false): Promise<CurrentMealSnapshot | undefined> {
    const meal = await queryable.query(
      `SELECT * FROM current_meals
       WHERE id = $1 AND user_id = $2${lock ? ' FOR UPDATE' : ''}`,
      [mealId, userId],
    );
    const row = meal.rows[0];
    if (!row) return undefined;
    const dishes = await queryable.query(
      `SELECT * FROM current_meal_dishes
       WHERE meal_id = $1 AND user_id = $2
       ORDER BY dish_key ASC`,
      [mealId, userId],
    );
    const ingredients = await queryable.query(
      `SELECT * FROM current_meal_ingredients
       WHERE meal_id = $1 AND user_id = $2
       ORDER BY dish_key ASC, id ASC`,
      [mealId, userId],
    );
    const nutrients = await queryable.query(
      `SELECT * FROM current_meal_nutrients
       WHERE meal_id = $1 AND user_id = $2
       ORDER BY dish_key ASC, nutrient_code ASC`,
      [mealId, userId],
    );
    return mapCurrentMealSnapshot(row, dishes.rows, ingredients.rows, nutrients.rows);
  }

  async function writeCurrentChildren(snapshot: CurrentMealSnapshot): Promise<void> {
    for (const dish of snapshot.dishes) {
      await queryable.query(
        `INSERT INTO current_meal_dishes (meal_id, user_id, dish_key, name_zh, portion_grams)
         VALUES ($1,$2,$3,$4,$5)`,
        [snapshot.id, snapshot.userId, dish.id, dish.nameZh, dish.portionGrams],
      );
      for (const ingredient of dish.ingredients) {
        await queryable.query(
          `INSERT INTO current_meal_ingredients (
            id, meal_id, dish_key, user_id, name_zh, grams, food_source, food_source_id, food_source_version
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            randomUUID(), snapshot.id, dish.id, snapshot.userId, ingredient.nameZh, ingredient.grams,
            ingredient.foodSource, ingredient.foodSourceId ?? null, ingredient.foodSourceVersion ?? null,
          ],
        );
      }
    }
    for (const nutrient of snapshot.nutrients) {
      const internal = toInternalNutrientAmount(nutrient.nutrientCode, nutrient.value, nutrient.unit);
      await queryable.query(
        `INSERT INTO current_meal_nutrients (
          meal_id, user_id, dish_key, nutrient_code, grams, kcal, source, source_unit, current_unit
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          snapshot.id,
          snapshot.userId,
          nutrient.dishId,
          nutrient.nutrientCode,
          internal.unit === 'g' ? internal.value : null,
          internal.unit === 'kcal' ? internal.value : null,
          nutrient.source,
          nutrient.unit,
          internal.unit,
        ],
      );
    }
  }

  let store: AuthStore;
  const currentMeals: CurrentMealStore = {
    async insertEditorDraft(input) {
      const editor = parsedEditorForMeal(input.editor, input.id);
      if (editor.mealType !== input.mealType) throw new Error('editor meal type must match draft meal type');
      if (new Date(editor.eatenAt).getTime() !== input.eatenAt.getTime()) {
        throw new Error('editor eaten at must match draft eaten at');
      }
      await queryable.query(
        `INSERT INTO meal_drafts (id, user_id, meal_type, eaten_at, vision, editor, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$7)`,
        [input.id, input.userId, input.mealType, input.eatenAt, JSON.stringify(input.vision), JSON.stringify(editor), input.now],
      );
      return structuredClone(editor);
    },
    async findEditorDraft(userId, id) {
      const result = await queryable.query(
        `SELECT editor FROM meal_drafts
         WHERE id = $1 AND user_id = $2 AND editor IS NOT NULL`,
        [id, userId],
      );
      const row = result.rows[0];
      return row ? parsedEditorForMeal(row.editor, id) : undefined;
    },
    async replaceEditorDraft(input) {
      const editor = parsedEditorForMeal(input.editor, input.id);
      const result = await queryable.query(
        `UPDATE meal_drafts
         SET editor = $3::jsonb, updated_at = $4
         WHERE id = $1 AND user_id = $2 AND editor IS NOT NULL
         RETURNING editor`,
        [input.id, input.userId, JSON.stringify(editor), input.now],
      );
      const row = result.rows[0];
      return row ? parsedEditorForMeal(row.editor, input.id) : undefined;
    },
    async saveEditorDraft(input) {
      if (canStartTransaction(queryable)) {
        return store.withTransaction((inner) => inner.currentMeals.saveEditorDraft(input));
      }
      const draft = await queryable.query(
        `SELECT id, user_id, editor FROM meal_drafts
         WHERE id = $1 AND user_id = $2 AND editor IS NOT NULL
         FOR UPDATE`,
        [input.draftId, input.userId],
      );
      const draftRow = draft.rows[0];
      if (!draftRow) throw new Error('editor draft not found');
      const editor = parsedEditorForMeal(draftRow.editor, input.draftId);
      const existing = await queryable.query(
        `SELECT id FROM current_meals
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [input.draftId, input.userId],
      );
      if (existing.rows[0]) throw new Error('current meal already exists');
      const snapshot = currentMealSnapshotFromEditor({
        id: input.draftId,
        userId: input.userId,
        editor,
        contentRevision: 1,
        syncState: 'unsynced',
        lastSyncedGenerationId: undefined,
        createdAt: input.now,
        updatedAt: input.now,
      });
      await queryable.query(
        `INSERT INTO current_meals (
          id, user_id, meal_type, eaten_at, content_revision, sync_state, last_synced_generation_id, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
        [
          snapshot.id, snapshot.userId, snapshot.mealType, snapshot.eatenAt, snapshot.contentRevision,
          snapshot.syncState, null, snapshot.createdAt,
        ],
      );
      await writeCurrentChildren(snapshot);
      await queryable.query('DELETE FROM meal_drafts WHERE id = $1 AND user_id = $2', [input.draftId, input.userId]);
      return snapshot;
    },
    async findCurrentMeal(userId, id) {
      return readCurrentMeal(userId, id);
    },
    async lockCurrentMealForEdit(userId, id) {
      return readCurrentMeal(userId, id, true);
    },
    async replaceCurrentMealContent(input) {
      if (canStartTransaction(queryable)) {
        return store.withTransaction((inner) => inner.currentMeals.replaceCurrentMealContent(input));
      }
      const current = await readCurrentMeal(input.userId, input.mealId, true);
      if (!current) return undefined;
      if (current.syncState === 'syncing' || current.syncState === 'recovery') throw new CurrentMealEditLockedError();
      const editor = parsedEditorForMeal(input.editor, input.mealId);
      if (!hasMeaningfulCurrentContentChange(current, editor)) return current;
      const next = currentMealSnapshotFromEditor({
        ...current,
        editor,
        contentRevision: current.contentRevision + 1,
        syncState: 'unsynced',
        updatedAt: input.now,
      });
      await queryable.query(
        `UPDATE current_meals
         SET meal_type = $3, eaten_at = $4, content_revision = $5, sync_state = $6, updated_at = $7
         WHERE id = $1 AND user_id = $2`,
        [next.id, next.userId, next.mealType, next.eatenAt, next.contentRevision, next.syncState, next.updatedAt],
      );
      await queryable.query('DELETE FROM current_meal_dishes WHERE meal_id = $1 AND user_id = $2', [next.id, next.userId]);
      await writeCurrentChildren(next);
      return next;
    },
    async setCurrentMealNutrient(input) {
      if (canStartTransaction(queryable)) {
        return store.withTransaction((inner) => inner.currentMeals.setCurrentMealNutrient(input));
      }
      const current = await readCurrentMeal(input.userId, input.mealId, true);
      if (!current) return undefined;
      if (current.syncState === 'syncing' || current.syncState === 'recovery') throw new CurrentMealEditLockedError();
      const existing = current.nutrients.find((nutrient) => nutrient.dishId === input.dishId && nutrient.nutrientCode === input.nutrientCode);
      if (!existing) throw new Error(`unknown nutrient: ${input.nutrientCode}`);
      const internal = toInternalNutrientAmount(input.nutrientCode, input.value, input.unit);
      const existingInternal = toInternalNutrientAmount(existing.nutrientCode, existing.value, existing.unit);
      if (existingInternal.value === internal.value && existingInternal.unit === internal.unit) return current;
      const updatedNutrient = {
        ...existing,
        value: internal.value,
        unit: internal.unit,
        source: 'user_edit' as const,
      };
      const nutrientUpdate = await queryable.query(
        `UPDATE current_meal_nutrients
         SET grams = $5, kcal = $6, source = $7, source_unit = $8, current_unit = $9
         WHERE meal_id = $1 AND user_id = $2 AND dish_key = $3 AND nutrient_code = $4
         RETURNING meal_id`,
        [
          input.mealId, input.userId, input.dishId, input.nutrientCode,
          internal.unit === 'g' ? internal.value : null,
          internal.unit === 'kcal' ? internal.value : null,
          'user_edit', internal.unit, internal.unit,
        ],
      );
      if (!nutrientUpdate.rows[0]) return undefined;
      const revision = current.contentRevision + 1;
      await queryable.query(
        `UPDATE current_meals
         SET content_revision = $3, sync_state = 'unsynced', updated_at = $4
         WHERE id = $1 AND user_id = $2`,
        [input.mealId, input.userId, revision, input.now],
      );
      return {
        ...current,
        contentRevision: revision,
        syncState: 'unsynced',
        updatedAt: new Date(input.now),
        nutrients: current.nutrients.map((nutrient) => nutrient === existing ? updatedNutrient : nutrient),
      };
    },
  };

  async function findActiveSyncGeneration(input: { mealId: string; userId: string; lock?: boolean }): Promise<MealSyncGenerationRow | undefined> {
    const result = await queryable.query(
      `SELECT * FROM meal_sync_generations
       WHERE meal_id = $1 AND user_id = $2 AND phase <> 'synced'
       ORDER BY created_at ASC, id ASC
       LIMIT 1${input.lock ? ' FOR UPDATE' : ''}`,
      [input.mealId, input.userId],
    );
    return result.rows[0] ? mapMealSyncGeneration(result.rows[0]) : undefined;
  }

  async function readSyncPoints(generationId: string, userId: string, lock = false): Promise<MealSyncPointRow[]> {
    const result = await queryable.query(
      `SELECT * FROM meal_sync_points
       WHERE generation_id = $1 AND user_id = $2
       ORDER BY created_at ASC, id ASC${lock ? ' FOR UPDATE' : ''}`,
      [generationId, userId],
    );
    return result.rows.map(mapMealSyncPoint);
  }

  async function updateCurrentMealSyncState(input: {
    generation: MealSyncGenerationRow;
    syncState: CurrentMealSyncState;
    now: Date;
    lastSyncedGenerationId?: string | undefined;
  }): Promise<void> {
    await queryable.query(
      `UPDATE current_meals
       SET sync_state = $3,
           last_synced_generation_id = COALESCE($4, last_synced_generation_id),
           updated_at = $5
       WHERE id = $1 AND user_id = $2`,
      [input.generation.mealId, input.generation.userId, input.syncState, input.lastSyncedGenerationId ?? null, input.now],
    );
  }

  async function finaliseSyncGeneration(generation: MealSyncGenerationRow, now: Date): Promise<void> {
    const mealResult = await queryable.query(
      `SELECT last_synced_generation_id
       FROM current_meals
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [generation.mealId, generation.userId],
    );
    const meal = mealResult.rows[0];
    if (!meal) throw new Error('current meal disappeared during sync finalisation');
    const priorGenerationId = meal.last_synced_generation_id ? String(meal.last_synced_generation_id) : undefined;
    await queryable.query(
      `UPDATE meal_sync_generations
       SET phase = 'synced', updated_at = $2
       WHERE id = $1 AND user_id = $3`,
      [generation.id, now, generation.userId],
    );
    await queryable.query(
      `UPDATE current_meals
       SET sync_state = 'synced', last_synced_generation_id = $3, updated_at = $4
       WHERE id = $1 AND user_id = $2`,
      [generation.mealId, generation.userId, generation.id, now],
    );
    await queryable.query(
      `DELETE FROM meal_sync_points
       WHERE generation_id = $1 AND user_id = $2 AND role = 'delete_target'`,
      [generation.id, generation.userId],
    );
    if (priorGenerationId && priorGenerationId !== generation.id) {
      await queryable.query(
        'DELETE FROM meal_sync_generations WHERE id = $1 AND user_id = $2',
        [priorGenerationId, generation.userId],
      );
    }
  }

  async function refreshSyncGenerationState(generation: MealSyncGenerationRow, now: Date): Promise<MealSyncGenerationPhase> {
    const points = await readSyncPoints(generation.id, generation.userId, true);
    const createPoints = points.filter((point) => point.role === 'create_target');
    const deletePoints = points.filter((point) => point.role === 'delete_target');
    if (createPoints.length > 0 && createPoints.every((point) => point.status === 'synced')) {
      await finaliseSyncGeneration(generation, now);
      return 'synced';
    }
    const blocked = points.some((point) => (
      point.status === 'unknown' || point.status === 'failed_action_required'
    ));
    const phase: MealSyncGenerationPhase = blocked
      ? 'recovery'
      : deletePoints.every((point) => point.status === 'synced') ? 'pending_create' : 'pending_delete';
    const syncState: CurrentMealSyncState = phase === 'recovery' ? 'recovery' : 'syncing';
    await queryable.query(
      `UPDATE meal_sync_generations
       SET phase = $3, updated_at = $4
       WHERE id = $1 AND user_id = $2`,
      [generation.id, generation.userId, phase, now],
    );
    await updateCurrentMealSyncState({ generation, syncState, now });
    return phase;
  }

  function resumePointStatus(point: MealSyncPointRow): 'pending' | 'operation_pending' {
    return point.googleOperationName || point.recoveryState === 'operation_pending' ? 'operation_pending' : 'pending';
  }

  const mealSync: MealSyncStore = {
    async startGeneration(input) {
      if (canStartTransaction(queryable)) {
        return store.withTransaction((inner) => inner.mealSync!.startGeneration(input));
      }
      const meal = await readCurrentMeal(input.userId, input.mealId, true);
      if (!meal || meal.syncState !== 'unsynced') return undefined;
      if (await findActiveSyncGeneration({ ...input, lock: true })) return undefined;
      const payloads = buildCurrentMealGooglePayloads({
        meal,
        dataPointIdForDish: () => `d-${randomUUID()}`,
      });
      if (payloads.length === 0) return undefined;
      const priorPoints = meal.lastSyncedGenerationId
        ? await readSyncPoints(meal.lastSyncedGenerationId, input.userId, true)
        : [];
      const generation: MealSyncGenerationRow = {
        id: randomUUID(), mealId: input.mealId, userId: input.userId, contentRevision: meal.contentRevision,
        phase: priorPoints.length > 0 ? 'pending_delete' : 'pending_create',
        createdAt: new Date(input.now), updatedAt: new Date(input.now),
      };
      await queryable.query(
        `INSERT INTO meal_sync_generations (id, meal_id, user_id, content_revision, phase, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$6)`,
        [generation.id, generation.mealId, generation.userId, generation.contentRevision, generation.phase, generation.createdAt],
      );
      for (const point of priorPoints.filter((item) => item.role === 'create_target')) {
        await queryable.query(
          `INSERT INTO meal_sync_points (
            id, generation_id, user_id, dish_key, role, data_point_name, payload, payload_hash, status, created_at, updated_at
          ) VALUES ($1,$2,$3,$4,'delete_target',$5,NULL,NULL,'pending',$6,$6)`,
          [randomUUID(), generation.id, generation.userId, point.dishKey, point.dataPointName, input.now],
        );
      }
      for (const payload of payloads) {
        await queryable.query(
          `INSERT INTO meal_sync_points (
            id, generation_id, user_id, dish_key, role, data_point_name, payload, payload_hash, status, created_at, updated_at
          ) VALUES ($1,$2,$3,$4,'create_target',$5,$6::jsonb,$7,'pending',$8,$8)`,
          [
            randomUUID(), generation.id, generation.userId, payload.dishKey, payload.dataPoint.name,
            JSON.stringify(payload.dataPoint), payload.payloadHash, input.now,
          ],
        );
      }
      await updateCurrentMealSyncState({ generation, syncState: 'syncing', now: input.now });
      return generation;
    },
    async beginRecovery(input) {
      if (canStartTransaction(queryable)) {
        return store.withTransaction((inner) => inner.mealSync!.beginRecovery(input));
      }
      void input.reason;
      const generation = await findActiveSyncGeneration({ ...input, lock: true });
      if (!generation) return undefined;
      const points = await readSyncPoints(generation.id, generation.userId, true);
      const unknown = points.filter((point) => point.status === 'unknown');
      if (unknown.length > 0) {
        await queryable.query(
          `UPDATE meal_sync_points
           SET recovery_requested_at = $3, updated_at = $3
           WHERE generation_id = $1 AND user_id = $2 AND status = 'unknown'`,
          [generation.id, generation.userId, input.now],
        );
        await queryable.query(
          `UPDATE meal_sync_generations SET phase = 'recovery', updated_at = $3 WHERE id = $1 AND user_id = $2`,
          [generation.id, generation.userId, input.now],
        );
        await updateCurrentMealSyncState({ generation, syncState: 'recovery', now: input.now });
        return { ...generation, phase: 'recovery', updatedAt: new Date(input.now) };
      }
      for (const point of points.filter((item) => item.status === 'failed_action_required')) {
        await queryable.query(
          `UPDATE meal_sync_points
           SET status = $4, next_attempt_at = $5, last_error_code = NULL, recovery_state = NULL, updated_at = $5
           WHERE id = $1 AND generation_id = $2 AND user_id = $3 AND status = 'failed_action_required'`,
          [point.id, generation.id, generation.userId, resumePointStatus(point), input.now],
        );
      }
      const phase = await refreshSyncGenerationState(generation, input.now);
      return { ...generation, phase, updatedAt: new Date(input.now) };
    },
    async claimDuePoints(input) {
      const result = await queryable.query(
        `WITH candidate AS (
           SELECT point.id, point.generation_id, point.user_id
           FROM meal_sync_points AS point
           JOIN meal_sync_generations AS generation ON generation.id = point.generation_id AND generation.user_id = point.user_id
           WHERE generation.phase <> 'synced'
             AND (point.lease_until IS NULL OR point.lease_until <= $1)
             AND (
               (
                 EXISTS (
                   SELECT 1 FROM meal_sync_points AS unknown_point
                   WHERE unknown_point.generation_id = generation.id AND unknown_point.user_id = generation.user_id
                     AND unknown_point.status = 'unknown'
                 )
                 AND point.status = 'unknown' AND point.recovery_requested_at IS NOT NULL AND point.recovery_requested_at <= $1
               )
               OR (
                 NOT EXISTS (
                   SELECT 1 FROM meal_sync_points AS unknown_point
                   WHERE unknown_point.generation_id = generation.id AND unknown_point.user_id = generation.user_id
                     AND unknown_point.status = 'unknown'
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM meal_sync_points AS failed_point
                   WHERE failed_point.generation_id = generation.id AND failed_point.user_id = generation.user_id
                     AND failed_point.status = 'failed_action_required'
                 )
                 AND point.status IN ('pending', 'retrying', 'operation_pending')
                 AND (point.next_attempt_at IS NULL OR point.next_attempt_at <= $1)
                 AND (
                   (
                     EXISTS (
                       SELECT 1 FROM meal_sync_points AS unfinished_delete
                       WHERE unfinished_delete.generation_id = generation.id AND unfinished_delete.user_id = generation.user_id
                         AND unfinished_delete.role = 'delete_target' AND unfinished_delete.status <> 'synced'
                     )
                     AND point.role = 'delete_target'
                   )
                   OR (
                     NOT EXISTS (
                       SELECT 1 FROM meal_sync_points AS unfinished_delete
                       WHERE unfinished_delete.generation_id = generation.id AND unfinished_delete.user_id = generation.user_id
                         AND unfinished_delete.role = 'delete_target' AND unfinished_delete.status <> 'synced'
                     )
                     AND point.role = 'create_target'
                   )
               )
             )
             AND (
               $4::text IS NULL
               OR (
                 $4 = 'batch_delete'
                 AND point.role = 'delete_target'
                 AND point.status IN ('pending', 'retrying')
                 AND point.google_operation_name IS NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM meal_sync_points AS unknown_point
                   WHERE unknown_point.generation_id = generation.id AND unknown_point.user_id = generation.user_id
                     AND unknown_point.status = 'unknown'
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM meal_sync_points AS failed_point
                   WHERE failed_point.generation_id = generation.id AND failed_point.user_id = generation.user_id
                     AND failed_point.status = 'failed_action_required'
                 )
               )
               OR (
                 $4 = 'single'
                 AND NOT (
                   point.role = 'delete_target'
                   AND point.status IN ('pending', 'retrying')
                   AND point.google_operation_name IS NULL
                 )
               )
             )
           )
           ORDER BY COALESCE(point.next_attempt_at, point.created_at) ASC, point.id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $3
         ),
         selected_batch_generation AS (
           SELECT generation_id, user_id
           FROM candidate
           WHERE $4 = 'batch_delete'
           ORDER BY generation_id, user_id
           LIMIT 1
         ),
         selected_candidate AS (
           SELECT candidate.id
           FROM candidate
           WHERE $4 IS DISTINCT FROM 'batch_delete'
              OR EXISTS (
                SELECT 1 FROM selected_batch_generation AS selected
                WHERE selected.generation_id = candidate.generation_id AND selected.user_id = candidate.user_id
              )
         )
         UPDATE meal_sync_points AS point
         SET lease_until = $2, last_attempt_at = $1, next_attempt_at = NULL,
             attempt_count = point.attempt_count + 1, updated_at = $1
         FROM selected_candidate AS candidate
         WHERE point.id = candidate.id
         RETURNING point.*`,
        [input.now, input.leaseUntil, input.limit, input.mode ?? null],
      );
      return result.rows.map(mapMealSyncPoint);
    },
    async renewPointLease(input) {
      if (canStartTransaction(queryable)) return store.withTransaction((inner) => inner.mealSync!.renewPointLease(input));
      const result = await queryable.query(
        `UPDATE meal_sync_points
         SET lease_until = $5, updated_at = $7
         WHERE id = $1 AND generation_id = $2 AND user_id = $3
           AND lease_until = $4 AND lease_until > $6 AND $5 > $4`,
        [
          input.id, input.generationId, input.userId, input.leaseUntil,
          input.renewedLeaseUntil, input.now, input.now,
        ],
      );
      return result.rowCount === 1;
    },
    async finishPoint(input) {
      if (canStartTransaction(queryable)) {
        return store.withTransaction((inner) => inner.mealSync!.finishPoint(input));
      }
      const result = await queryable.query(
        `UPDATE meal_sync_points
         SET status = 'synced', lease_until = NULL, next_attempt_at = NULL, last_error_code = NULL,
             recovery_state = NULL, recovery_requested_at = NULL, updated_at = $5
         WHERE id = $1 AND generation_id = $2 AND user_id = $3 AND lease_until = $4
         RETURNING generation_id`,
        [input.id, input.generationId, input.userId, input.leaseUntil, input.now],
      );
      if (!result.rows[0]) return false;
      const generationResult = await queryable.query(
        'SELECT * FROM meal_sync_generations WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [input.generationId, input.userId],
      );
      if (!generationResult.rows[0]) return false;
      await refreshSyncGenerationState(mapMealSyncGeneration(generationResult.rows[0]), input.now);
      return true;
    },
    async retryPoint(input) {
      if (canStartTransaction(queryable)) return store.withTransaction((inner) => inner.mealSync!.retryPoint(input));
      const result = await queryable.query(
        `UPDATE meal_sync_points
         SET recovery_state = CASE WHEN google_operation_name IS NULL THEN 'pending' ELSE 'operation_pending' END,
             status = 'retrying', lease_until = NULL, next_attempt_at = $5, last_error_code = $6, updated_at = $7
         WHERE id = $1 AND generation_id = $2 AND user_id = $3 AND lease_until = $4
         RETURNING generation_id`,
        [input.id, input.generationId, input.userId, input.leaseUntil, input.nextAttemptAt, input.errorCode, input.now],
      );
      if (!result.rows[0]) return false;
      const generationResult = await queryable.query('SELECT * FROM meal_sync_generations WHERE id = $1 AND user_id = $2 FOR UPDATE', [input.generationId, input.userId]);
      if (!generationResult.rows[0]) return false;
      await refreshSyncGenerationState(mapMealSyncGeneration(generationResult.rows[0]), input.now);
      return true;
    },
    async markPointUnknown(input) {
      if (canStartTransaction(queryable)) return store.withTransaction((inner) => inner.mealSync!.markPointUnknown(input));
      const result = await queryable.query(
        `UPDATE meal_sync_points
         SET recovery_state = CASE WHEN google_operation_name IS NULL THEN 'pending' ELSE 'operation_pending' END,
             status = 'unknown', lease_until = NULL, next_attempt_at = NULL, last_error_code = $5,
             recovery_requested_at = NULL, updated_at = $6
         WHERE id = $1 AND generation_id = $2 AND user_id = $3 AND lease_until = $4
         RETURNING generation_id`,
        [input.id, input.generationId, input.userId, input.leaseUntil, input.errorCode, input.now],
      );
      if (!result.rows[0]) return false;
      const generationResult = await queryable.query('SELECT * FROM meal_sync_generations WHERE id = $1 AND user_id = $2 FOR UPDATE', [input.generationId, input.userId]);
      if (!generationResult.rows[0]) return false;
      await refreshSyncGenerationState(mapMealSyncGeneration(generationResult.rows[0]), input.now);
      return true;
    },
    async markPointFailedActionRequired(input) {
      if (canStartTransaction(queryable)) return store.withTransaction((inner) => inner.mealSync!.markPointFailedActionRequired(input));
      const result = await queryable.query(
        `UPDATE meal_sync_points
         SET recovery_state = CASE WHEN google_operation_name IS NULL THEN 'pending' ELSE 'operation_pending' END,
             status = 'failed_action_required', lease_until = NULL, next_attempt_at = NULL, last_error_code = $5, updated_at = $6
         WHERE id = $1 AND generation_id = $2 AND user_id = $3 AND lease_until = $4
         RETURNING generation_id`,
        [input.id, input.generationId, input.userId, input.leaseUntil, input.errorCode, input.now],
      );
      if (!result.rows[0]) return false;
      const generationResult = await queryable.query('SELECT * FROM meal_sync_generations WHERE id = $1 AND user_id = $2 FOR UPDATE', [input.generationId, input.userId]);
      if (!generationResult.rows[0]) return false;
      await refreshSyncGenerationState(mapMealSyncGeneration(generationResult.rows[0]), input.now);
      return true;
    },
    async markPointOperationPending(input) {
      if (canStartTransaction(queryable)) return store.withTransaction((inner) => inner.mealSync!.markPointOperationPending(input));
      const result = await queryable.query(
        `UPDATE meal_sync_points
         SET status = 'operation_pending', lease_until = NULL, google_operation_name = $5,
             next_attempt_at = $6, last_error_code = NULL, recovery_state = 'operation_pending', updated_at = $7
         WHERE id = $1 AND generation_id = $2 AND user_id = $3 AND lease_until = $4`,
        [input.id, input.generationId, input.userId, input.leaseUntil, input.operationName, input.nextAttemptAt, input.now],
      );
      return result.rowCount === 1;
    },
    async requestUnknownRecovery(input) {
      if (canStartTransaction(queryable)) return store.withTransaction((inner) => inner.mealSync!.requestUnknownRecovery(input));
      const result = await queryable.query(
        `UPDATE meal_sync_points
         SET recovery_requested_at = $4, updated_at = $4
         WHERE id = $1 AND generation_id = $2 AND user_id = $3 AND status = 'unknown'`,
        [input.pointId, input.generationId, input.userId, input.now],
      );
      if (result.rowCount !== 1) return false;
      const generationResult = await queryable.query(
        'UPDATE meal_sync_generations SET phase = \'recovery\', updated_at = $3 WHERE id = $1 AND user_id = $2 RETURNING *',
        [input.generationId, input.userId, input.now],
      );
      if (!generationResult.rows[0]) return false;
      await updateCurrentMealSyncState({ generation: mapMealSyncGeneration(generationResult.rows[0]), syncState: 'recovery', now: input.now });
      return true;
    },
    async readGenerationState(input) {
      const generation = await findActiveSyncGeneration(input);
      if (!generation) return undefined;
      const points = await readSyncPoints(generation.id, generation.userId);
      const pointStatusCounts: Partial<Record<MealSyncPointStatus, number>> = {};
      for (const point of points) pointStatusCounts[point.status] = (pointStatusCounts[point.status] ?? 0) + 1;
      const recoveryRequestedAt = points
        .filter((point) => point.status === 'unknown' && point.recoveryRequestedAt)
        .map((point) => point.recoveryRequestedAt!)
        .sort((left, right) => right.getTime() - left.getTime())[0];
      return {
        generation,
        pointStatusCounts,
        hasUnknownPoint: points.some((point) => point.status === 'unknown'),
        recoveryRequestedAt: recoveryRequestedAt ? new Date(recoveryRequestedAt) : undefined,
      };
    },
  };

  function assertWindowUser<T extends { userId: string }>(userId: string, rows: T[] | undefined): T[] {
    const list = rows ?? [];
    for (const row of list) {
      if (row.userId !== userId) throw new Error('health metrics write user mismatch');
    }
    return list;
  }

  async function applyHealthWindow(metrics: HealthMetricsStore, input: HealthMetricsWindowWrite): Promise<void> {
    await metrics.upsertMinutes(assertWindowUser(input.userId, input.minutes));
    await metrics.upsertActivityLevelIntervals(assertWindowUser(input.userId, input.activityLevelIntervals));
    for (const row of assertWindowUser(input.userId, input.heartRateZones)) await metrics.replaceHeartRateZones(row);
    for (const row of assertWindowUser(input.userId, input.timeInZone)) await metrics.replaceTimeInZone(row);
    await metrics.upsertExerciseIntervals(assertWindowUser(input.userId, input.exerciseIntervals));
    for (const row of assertWindowUser(input.userId, input.dailyCardio)) await metrics.upsertDailyCardio(row);
    for (const row of assertWindowUser(input.userId, input.metricResults)) await metrics.upsertMetricResult(row);
    await metrics.updateCursor({
      connectionId: input.connectionId,
      dataType: input.dataType,
      ...input.cursor,
    });
  }

  const healthMetrics: HealthMetricsStore = {
    async ingestWindow(input) {
      if (canStartTransaction(queryable)) {
        return store.withTransaction((inner) => inner.healthMetrics.ingestWindow(input));
      }
      const owner = await queryable.query(
        'SELECT user_id FROM google_health_connections WHERE id = $1',
        [input.connectionId],
      );
      if (owner.rows[0]?.user_id !== input.userId) {
        throw new HealthMetricsConnectionMismatchError();
      }
      await applyHealthWindow(healthMetrics, input);
    },
    async upsertMinutes(minutes) {
      for (const row of minutes) {
        const incoming = parseHeartRateMinuteAggregate(row);
        const existingResult = await queryable.query(
          `SELECT * FROM heart_rate_minute_aggregates
           WHERE user_id = $1 AND source_family = $2 AND minute_start_utc = $3`,
          [incoming.userId, incoming.sourceFamily, new Date(incoming.minuteStartUtc)],
        );
        const merged = existingResult.rows[0]
          ? mergeHeartRateMinuteUpsert(mapHeartRateMinuteAggregateRow(existingResult.rows[0]), incoming)
          : incoming;
        await queryable.query(
          `INSERT INTO heart_rate_minute_aggregates (
            user_id, source_family, minute_start_utc, civil_date, utc_offset, iana_time_zone,
            local_minute_of_day, avg_bpm, min_bpm, max_bpm, sample_count, coverage_seconds, activity_level
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          ON CONFLICT (user_id, source_family, minute_start_utc) DO UPDATE SET
            civil_date = EXCLUDED.civil_date,
            utc_offset = EXCLUDED.utc_offset,
            iana_time_zone = EXCLUDED.iana_time_zone,
            local_minute_of_day = EXCLUDED.local_minute_of_day,
            avg_bpm = EXCLUDED.avg_bpm,
            min_bpm = EXCLUDED.min_bpm,
            max_bpm = EXCLUDED.max_bpm,
            sample_count = EXCLUDED.sample_count,
            coverage_seconds = EXCLUDED.coverage_seconds,
            activity_level = EXCLUDED.activity_level`,
          [
            merged.userId,
            merged.sourceFamily,
            new Date(merged.minuteStartUtc),
            merged.civilDate,
            merged.utcOffsetMinutes,
            merged.ianaTimeZone,
            merged.localMinuteOfDay,
            merged.avgBpm,
            merged.minBpm,
            merged.maxBpm,
            merged.sampleCount,
            merged.coverageSeconds,
            merged.activityLevel,
          ],
        );
      }
    },
    async listMinutesByCivilDate(input) {
      const result = await queryable.query(
        `SELECT * FROM heart_rate_minute_aggregates
         WHERE user_id = $1 AND civil_date = $2
         ORDER BY minute_start_utc ASC`,
        [input.userId, input.civilDate],
      );
      return result.rows.map(mapHeartRateMinuteAggregateRow);
    },
    async listMinutesInRange(input) {
      const result = await queryable.query(
        `SELECT * FROM heart_rate_minute_aggregates
         WHERE user_id = $1
           AND minute_start_utc >= $2
           AND ($3::timestamptz IS NULL OR minute_start_utc < $3)
         ORDER BY minute_start_utc ASC`,
        [input.userId, new Date(input.fromUtc), input.toUtcExclusive ? new Date(input.toUtcExclusive) : null],
      );
      return result.rows.map(mapHeartRateMinuteAggregateRow);
    },
    async updateMinuteLocalAssociation(input) {
      const existingResult = await queryable.query(
        `SELECT * FROM heart_rate_minute_aggregates
         WHERE user_id = $1 AND source_family = $2 AND minute_start_utc = $3`,
        [input.userId, input.sourceFamily, new Date(input.minuteStartUtc)],
      );
      const existingRow = existingResult.rows[0];
      if (!existingRow) return false;
      const merged = parseHeartRateMinuteAggregate({
        ...mapHeartRateMinuteAggregateRow(existingRow),
        civilDate: input.civilDate,
        ianaTimeZone: input.ianaTimeZone,
        localMinuteOfDay: input.localMinuteOfDay,
      });
      const result = await queryable.query(
        `UPDATE heart_rate_minute_aggregates
         SET civil_date = $4, iana_time_zone = $5, local_minute_of_day = $6
         WHERE user_id = $1 AND source_family = $2 AND minute_start_utc = $3
         RETURNING user_id`,
        [merged.userId, merged.sourceFamily, new Date(merged.minuteStartUtc), merged.civilDate, merged.ianaTimeZone, merged.localMinuteOfDay],
      );
      return (result.rowCount ?? 0) === 1;
    },
    async upsertActivityLevelIntervals(intervals) {
      for (const row of intervals) {
        const parsed = parseActivityLevelInterval(row);
        await queryable.query(
          `INSERT INTO activity_level_intervals (
            user_id, source_family, interval_start_utc, interval_end_utc, activity_level_type
          ) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (user_id, source_family, interval_start_utc) DO UPDATE SET
            interval_end_utc = EXCLUDED.interval_end_utc,
            activity_level_type = EXCLUDED.activity_level_type`,
          [
            parsed.userId,
            parsed.sourceFamily,
            new Date(parsed.startTime),
            new Date(parsed.endTime),
            parsed.activityLevelType,
          ],
        );
      }
    },
    async listActivityLevelIntervalsInRange(input) {
      const result = await queryable.query(
        `SELECT * FROM activity_level_intervals
         WHERE user_id = $1
           AND interval_end_utc > $2
           AND ($3::timestamptz IS NULL OR interval_start_utc < $3)
         ORDER BY interval_start_utc ASC`,
        [input.userId, new Date(input.fromUtc), input.toUtcExclusive ? new Date(input.toUtcExclusive) : null],
      );
      return result.rows.map(mapActivityLevelIntervalRow);
    },
    async replaceHeartRateZones(zones) {
      const parsed = parseDailyHeartRateZones(zones);
      await queryable.query(
        `INSERT INTO daily_heart_rate_zones (user_id, source_family, civil_date, zones, received_at)
         VALUES ($1,$2,$3,$4::jsonb, now())
         ON CONFLICT (user_id, source_family, civil_date) DO UPDATE SET
           zones = EXCLUDED.zones,
           received_at = EXCLUDED.received_at`,
        [parsed.userId, parsed.sourceFamily, parsed.date, JSON.stringify(parsed.zones)],
      );
    },
    async getHeartRateZones(input) {
      const result = await queryable.query(
        `SELECT * FROM daily_heart_rate_zones
         WHERE user_id = $1 AND civil_date = $2 AND source_family = 'google-wearables'`,
        [input.userId, input.civilDate],
      );
      return result.rows[0] ? mapDailyHeartRateZonesRow(result.rows[0]) : undefined;
    },
    async replaceTimeInZone(row) {
      const parsed = parseDailyTimeInZone(row);
      await queryable.query(
        `INSERT INTO daily_time_in_zone (
          user_id, source_family, civil_date, light_minutes, moderate_minutes, vigorous_minutes, peak_minutes
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (user_id, source_family, civil_date) DO UPDATE SET
           light_minutes = EXCLUDED.light_minutes,
           moderate_minutes = EXCLUDED.moderate_minutes,
           vigorous_minutes = EXCLUDED.vigorous_minutes,
           peak_minutes = EXCLUDED.peak_minutes`,
        [
          parsed.userId,
          parsed.sourceFamily,
          parsed.date,
          parsed.minutes.light,
          parsed.minutes.moderate,
          parsed.minutes.vigorous,
          parsed.minutes.peak,
        ],
      );
    },
    async getTimeInZone(input) {
      const result = await queryable.query(
        `SELECT * FROM daily_time_in_zone
         WHERE user_id = $1 AND civil_date = $2 AND source_family = 'google-wearables'`,
        [input.userId, input.civilDate],
      );
      return result.rows[0] ? mapDailyTimeInZoneRow(result.rows[0]) : undefined;
    },
    async upsertExerciseIntervals(intervals) {
      for (const row of intervals) {
        const parsed = parseExerciseInterval(row);
        await queryable.query(
          `INSERT INTO exercise_intervals (
            user_id, source_family, source_record_id, start_time_utc, end_time_utc, utc_offset, civil_date
          ) VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (user_id, source_family, source_record_id) DO UPDATE SET
            start_time_utc = EXCLUDED.start_time_utc,
            end_time_utc = EXCLUDED.end_time_utc,
            utc_offset = EXCLUDED.utc_offset,
            civil_date = EXCLUDED.civil_date`,
          [
            parsed.userId,
            parsed.sourceFamily,
            parsed.sourceRecordId,
            new Date(parsed.startTime),
            new Date(parsed.endTime),
            parsed.utcOffsetMinutes,
            parsed.civilDate,
          ],
        );
      }
    },
    async listExerciseIntervalsInRange(input) {
      const result = await queryable.query(
        `SELECT * FROM exercise_intervals
         WHERE user_id = $1
           AND end_time_utc > $2
           AND ($3::timestamptz IS NULL OR start_time_utc < $3)
         ORDER BY start_time_utc ASC`,
        [input.userId, new Date(input.fromUtc), input.toUtcExclusive ? new Date(input.toUtcExclusive) : null],
      );
      return result.rows.map(mapExerciseIntervalRow);
    },
    async upsertDailyCardio(row) {
      const parsed = parseDailyCardio(row);
      await queryable.query(
        `INSERT INTO daily_cardio (
          user_id, civil_date, status, strain, dose,
          light_minutes, moderate_minutes, vigorous_minutes, peak_minutes,
          known_context_minutes, raw_coverage_minutes, attributed_minutes, metric_version
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (user_id, civil_date) DO UPDATE SET
           status = EXCLUDED.status,
           strain = EXCLUDED.strain,
           dose = EXCLUDED.dose,
           light_minutes = EXCLUDED.light_minutes,
           moderate_minutes = EXCLUDED.moderate_minutes,
           vigorous_minutes = EXCLUDED.vigorous_minutes,
           peak_minutes = EXCLUDED.peak_minutes,
           known_context_minutes = EXCLUDED.known_context_minutes,
           raw_coverage_minutes = EXCLUDED.raw_coverage_minutes,
           attributed_minutes = EXCLUDED.attributed_minutes,
           metric_version = EXCLUDED.metric_version`,
        [
          parsed.userId,
          parsed.date,
          parsed.status,
          parsed.strain,
          parsed.dose,
          parsed.zoneMinutes.light,
          parsed.zoneMinutes.moderate,
          parsed.zoneMinutes.vigorous,
          parsed.zoneMinutes.peak,
          parsed.knownContextMinutes,
          parsed.rawCoverageMinutes,
          parsed.attributedMinutes,
          parsed.metricVersion,
        ],
      );
    },
    async getDailyCardio(input) {
      const result = await queryable.query(
        'SELECT * FROM daily_cardio WHERE user_id = $1 AND civil_date = $2',
        [input.userId, input.civilDate],
      );
      return result.rows[0] ? mapDailyCardioRow(result.rows[0]) : undefined;
    },
    async listDailyCardio(input) {
      const result = await queryable.query(
        `SELECT * FROM daily_cardio
         WHERE user_id = $1 AND civil_date >= $2 AND civil_date <= $3
         ORDER BY civil_date ASC`,
        [input.userId, input.fromCivilDate, input.toCivilDate],
      );
      return result.rows.map(mapDailyCardioRow);
    },
    async upsertMetricResult(row) {
      const parsed = parseMetricResult(row);
      await queryable.query(
        `INSERT INTO metric_results (
          user_id, civil_date, metric_name, metric_version, score, status, quality, reason,
          evidence, source, coverage, computed_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb, now())
         ON CONFLICT (user_id, civil_date, metric_name, metric_version) DO UPDATE SET
           score = EXCLUDED.score,
           status = EXCLUDED.status,
           quality = EXCLUDED.quality,
           reason = EXCLUDED.reason,
           evidence = EXCLUDED.evidence,
           source = EXCLUDED.source,
           coverage = EXCLUDED.coverage,
           computed_at = EXCLUDED.computed_at`,
        [
          parsed.userId,
          parsed.civilDate,
          parsed.metricName,
          parsed.metricVersion,
          parsed.score,
          parsed.status,
          parsed.quality,
          parsed.reason,
          JSON.stringify(parsed.evidence),
          JSON.stringify(parsed.source),
          JSON.stringify(parsed.coverage),
        ],
      );
    },
    async getMetricResult(input) {
      const result = await queryable.query(
        `SELECT * FROM metric_results
         WHERE user_id = $1 AND civil_date = $2 AND metric_name = $3 AND metric_version = $4`,
        [input.userId, input.civilDate, input.metricName, input.metricVersion ?? WHOOP_STYLE_METRIC_VERSION],
      );
      return result.rows[0] ? mapMetricResultRow(result.rows[0]) : undefined;
    },
    async listMetricResults(input) {
      const result = await queryable.query(
        `SELECT * FROM metric_results
         WHERE user_id = $1 AND civil_date = $2
         ORDER BY metric_name ASC`,
        [input.userId, input.civilDate],
      );
      return result.rows.map(mapMetricResultRow);
    },
    async readCursor(input) {
      const result = await queryable.query(
        'SELECT * FROM health_sync_cursors WHERE connection_id = $1 AND data_type = $2',
        [input.connectionId, input.dataType],
      );
      return result.rows[0] ? mapHealthSyncCursorRow(result.rows[0]) : undefined;
    },
    async listCursors(input) {
      const result = await queryable.query(
        'SELECT * FROM health_sync_cursors WHERE connection_id = $1 ORDER BY data_type ASC',
        [input.connectionId],
      );
      return result.rows.map(mapHealthSyncCursorRow);
    },
    async updateCursor(cursor) {
      const parsed = parseHealthSyncCursor(cursor);
      await queryable.query(
        `INSERT INTO health_sync_cursors (
          connection_id, data_type, successful_watermark, last_error_code, retry_count, next_attempt_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6, now())
         ON CONFLICT (connection_id, data_type) DO UPDATE SET
           successful_watermark = EXCLUDED.successful_watermark,
           last_error_code = EXCLUDED.last_error_code,
           retry_count = EXCLUDED.retry_count,
           next_attempt_at = EXCLUDED.next_attempt_at,
           updated_at = EXCLUDED.updated_at`,
        [
          parsed.connectionId,
          parsed.dataType,
          parsed.successfulWatermark ?? null,
          parsed.lastErrorCode ?? null,
          parsed.retryCount,
          parsed.nextAttemptAt ?? null,
        ],
      );
    },
    async scheduleCursor(input) {
      const parsed = parseHealthSyncCursor({
        connectionId: input.connectionId,
        dataType: input.dataType,
        lastErrorCode: input.lastErrorCode,
        retryCount: input.retryCount,
        nextAttemptAt: input.nextAttemptAt,
      });
      await queryable.query(
        `INSERT INTO health_sync_cursors (
          connection_id, data_type, last_error_code, retry_count, next_attempt_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (connection_id, data_type) DO UPDATE SET
           last_error_code = EXCLUDED.last_error_code,
           retry_count = EXCLUDED.retry_count,
           next_attempt_at = EXCLUDED.next_attempt_at,
           updated_at = EXCLUDED.updated_at`,
        [parsed.connectionId, parsed.dataType, parsed.lastErrorCode ?? null, parsed.retryCount, parsed.nextAttemptAt ?? null],
      );
    },
    async listDueCursors(input) {
      const result = await queryable.query(
        `SELECT * FROM health_sync_cursors
         WHERE next_attempt_at IS NOT NULL AND next_attempt_at <= $1
           AND ($2::uuid IS NULL OR connection_id = $2)
         ORDER BY next_attempt_at ASC, connection_id ASC, data_type ASC`,
        [input.now, input.connectionId ?? null],
      );
      return result.rows.map(mapHealthSyncCursorRow);
    },
    async insertSleepGoal(goal) {
      const parsed = parseSleepGoal(goal);
      try {
        await queryable.query(
          `INSERT INTO user_sleep_goal_history (user_id, effective_civil_date, goal_minutes)
           VALUES ($1,$2,$3)`,
          [parsed.userId, parsed.effectiveCivilDate, parsed.goalMinutes],
        );
      } catch (error) {
        if (isUniqueViolation(error)) throw new SleepGoalConflictError();
        throw error;
      }
    },
    async lookupSleepGoal(input) {
      const result = await queryable.query(
        `SELECT * FROM user_sleep_goal_history
         WHERE user_id = $1 AND effective_civil_date <= $2
         ORDER BY effective_civil_date DESC
         LIMIT 1`,
        [input.userId, input.civilDate],
      );
      return result.rows[0] ? mapSleepGoalRow(result.rows[0]) : undefined;
    },
    async insertTimeZoneHistory(row) {
      const parsed = parseHealthTimeZoneHistory(row);
      try {
        await queryable.query(
          `INSERT INTO user_health_time_zone_history (user_id, effective_at, iana_time_zone, is_backfill_anchor)
           VALUES ($1,$2,$3,$4)`,
          [parsed.userId, new Date(parsed.effectiveAt), parsed.ianaTimeZone, parsed.isBackfillAnchor],
        );
      } catch (error) {
        if (isUniqueViolation(error)) throw new TimeZoneHistoryConflictError();
        throw error;
      }
    },
    async lookupTimeZoneHistory(input) {
      const result = await queryable.query(
        `SELECT * FROM user_health_time_zone_history
         WHERE user_id = $1 AND effective_at <= $2
         ORDER BY effective_at DESC
         LIMIT 1`,
        [input.userId, new Date(input.at)],
      );
      return result.rows[0] ? mapHealthTimeZoneHistoryRow(result.rows[0]) : undefined;
    },
    async listTimeZoneHistory(userId) {
      const result = await queryable.query(
        `SELECT * FROM user_health_time_zone_history
         WHERE user_id = $1
         ORDER BY effective_at ASC`,
        [userId],
      );
      return result.rows.map(mapHealthTimeZoneHistoryRow);
    },
    async deleteForUser(userId) {
      if (canStartTransaction(queryable)) {
        return store.withTransaction((inner) => inner.healthMetrics.deleteForUser(userId));
      }
      await queryable.query('DELETE FROM heart_rate_minute_aggregates WHERE user_id = $1', [userId]);
      await queryable.query('DELETE FROM activity_level_intervals WHERE user_id = $1', [userId]);
      await queryable.query('DELETE FROM daily_heart_rate_zones WHERE user_id = $1', [userId]);
      await queryable.query('DELETE FROM daily_time_in_zone WHERE user_id = $1', [userId]);
      await queryable.query('DELETE FROM exercise_intervals WHERE user_id = $1', [userId]);
      await queryable.query('DELETE FROM daily_cardio WHERE user_id = $1', [userId]);
      await queryable.query('DELETE FROM metric_results WHERE user_id = $1', [userId]);
      await queryable.query(
        `DELETE FROM health_sync_cursors
         WHERE connection_id IN (SELECT id FROM google_health_connections WHERE user_id = $1)`,
        [userId],
      );
      await queryable.query('DELETE FROM user_sleep_goal_history WHERE user_id = $1', [userId]);
      await queryable.query('DELETE FROM user_health_time_zone_history WHERE user_id = $1', [userId]);
    },
  };

  store = {
    async withTransaction<T>(fn: (inner: AuthStore) => Promise<T>): Promise<T> {
      const pool = canStartTransaction(queryable) ? queryable : undefined;
      if (!pool) {
        return fn(store);
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(storeFor(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    users: {
      async insert(id: string): Promise<void> {
        await queryable.query('INSERT INTO users (id) VALUES ($1)', [id]);
      },
      async setNutritionWritebackEnabled(id: string, enabled: boolean): Promise<void> {
        await queryable.query('UPDATE users SET nutrition_writeback_enabled = $2, updated_at = now() WHERE id = $1', [id, enabled]);
      },
      async nutritionWritebackEnabled(id: string): Promise<boolean> {
        const result = await queryable.query('SELECT nutrition_writeback_enabled FROM users WHERE id = $1', [id]);
        return result.rows[0]?.nutrition_writeback_enabled === true;
      },
    },
    meals: {
      async insertDraft(input): Promise<MealDraftRow> {
        const id = randomUUID();
        const result = await queryable.query(
          `INSERT INTO meal_drafts (id, user_id, meal_type, eaten_at, vision, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6)
           RETURNING *`,
          [id, input.userId, input.mealType, input.eatenAt, JSON.stringify(input.vision), input.now],
        );
        return mapDraft(result.rows[0]);
      },
      async findDraft(userId, id): Promise<MealDraftRow | undefined> {
        const result = await queryable.query('SELECT * FROM meal_drafts WHERE id = $1 AND user_id = $2', [id, userId]);
        return result.rows[0] ? mapDraft(result.rows[0]) : undefined;
      },
      async confirmDraft(input) {
        if (canStartTransaction(queryable)) {
          return store.withTransaction((inner) => inner.meals.confirmDraft(input));
        }
        const draft = await store.meals.findDraft(input.userId, input.draftId);
        if (!draft) {
          return { ok: false as const, reason: '草稿不存在' };
        }
        const enabled = await store.users.nutritionWritebackEnabled(input.userId);
        const resolved = await resolveDraftNutrition(draft, input.catalog);
        const result = confirmDraftRows(draft, input, enabled, resolved);
        if (!result.ok) {
          return result;
        }
        await queryable.query(
          `INSERT INTO meal_versions (id, user_id, previous_version_id, meal_type, eaten_at, writeback_this_meal, confirmed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            result.version.id,
            result.version.userId,
            result.version.previousVersionId ?? null,
            result.version.mealType,
            result.version.eatenAt,
            result.version.writebackThisMeal,
            result.version.confirmedAt,
          ],
        );
        for (const dish of result.dishes) {
          await queryable.query(
            `INSERT INTO meal_dishes (id, version_id, user_id, client_short_id, name_zh, portion_grams, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [dish.id, dish.versionId, dish.userId, dish.clientShortId, dish.nameZh, dish.portionGrams, dish.source],
          );
        }
        for (const item of result.outbox) {
          await queryable.query(
            `INSERT INTO nutrition_write_outbox (id, user_id, dish_id, operation, data_point_name, payload, payload_hash, status)
             VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
            [item.id, item.userId, item.dishId, item.operation, item.dataPointName, item.payload ? JSON.stringify(item.payload) : null, item.payloadHash ?? null, item.status],
          );
        }
        for (const item of result.ingredients) {
          await queryable.query(
            `INSERT INTO meal_ingredients (id, dish_id, user_id, food_name, food_source, food_source_id, food_source_version, grams)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [item.id, item.dishId, item.userId, item.foodName, item.foodSource, item.foodSourceId ?? null, item.foodSourceVersion ?? null, item.grams],
          );
        }
        for (const item of result.nutrients) {
          await queryable.query(
            `INSERT INTO meal_nutrients (dish_id, user_id, nutrient_code, grams, kcal, source, confidence)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [item.dishId, item.userId, item.nutrientCode, item.grams ?? null, item.kcal ?? null, item.source, item.confidence ?? null],
          );
        }
        for (const item of result.provenance) {
          await queryable.query(
            `INSERT INTO meal_nutrition_provenance (
              dish_id, user_id, resolver_version, food_source, food_source_version,
              vision_confidence, total_ingredient_grams, matched_ingredient_grams
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              item.dishId,
              item.userId,
              item.resolverVersion,
              item.foodSource,
              item.foodSourceVersion ?? null,
              item.visionConfidence,
              item.totalIngredientGrams,
              item.matchedIngredientGrams,
            ],
          );
        }
        await queryable.query('DELETE FROM meal_drafts WHERE id = $1 AND user_id = $2', [input.draftId, input.userId]);
        return result;
      },
      async listVersions(userId): Promise<MealVersionRow[]> {
        const result = await queryable.query(
          'SELECT * FROM meal_versions WHERE user_id = $1 ORDER BY confirmed_at DESC',
          [userId],
        );
        return result.rows.map(mapVersion);
      },
      async listIngredients(userId, versionId) {
        const result = await queryable.query(
          `SELECT ingredient.*
           FROM meal_ingredients AS ingredient
           JOIN meal_dishes AS dish ON dish.id = ingredient.dish_id
           WHERE ingredient.user_id = $1 AND dish.version_id = $2`,
          [userId, versionId],
        );
        return result.rows.map((row) => ({
          id: row.id,
          dishId: row.dish_id,
          userId: row.user_id,
          foodName: row.food_name,
          foodSource: row.food_source,
          foodSourceId: row.food_source_id ?? undefined,
          foodSourceVersion: row.food_source_version ?? undefined,
          grams: Number(row.grams),
        }));
      },
      async listNutrients(userId, versionId) {
        const result = await queryable.query(
          `SELECT nutrient.*
           FROM meal_nutrients AS nutrient
           JOIN meal_dishes AS dish ON dish.id = nutrient.dish_id
           WHERE nutrient.user_id = $1 AND dish.version_id = $2`,
          [userId, versionId],
        );
        return result.rows.map((row) => ({
          dishId: row.dish_id,
          userId: row.user_id,
          nutrientCode: row.nutrient_code,
          grams: row.grams === null ? undefined : Number(row.grams),
          kcal: row.kcal === null ? undefined : Number(row.kcal),
          source: row.source,
          confidence: row.confidence === null ? undefined : Number(row.confidence),
        }));
      },
    },
    currentMeals,
    mealSync,
    connections,
    sessions: {
      async insert(row: SessionRow): Promise<void> {
        await queryable.query(
          `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [row.id, row.userId, row.tokenHash, row.expiresAt, row.createdAt, row.lastSeenAt],
        );
      },
      async findByTokenHash(tokenHash: Buffer): Promise<SessionRow | undefined> {
        const result = await queryable.query('SELECT * FROM sessions WHERE token_hash = $1', [tokenHash]);
        const row = result.rows[0];
        if (!row) {
          return undefined;
        }
        return {
          id: row.id,
          userId: row.user_id,
          tokenHash: asBuffer(row.token_hash) ?? tokenHash,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
          lastSeenAt: row.last_seen_at,
        };
      },
      async deleteByTokenHash(tokenHash: Buffer): Promise<void> {
        await queryable.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
      },
      async deleteAllForUser(userId: string): Promise<void> {
        await queryable.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
      },
    },
    healthSnapshots: {
      async deleteForUser(userId: string): Promise<void> {
        await queryable.query('DELETE FROM health_snapshots WHERE user_id = $1', [userId]);
      },
    },
    healthMetrics,
    foodComposition,
    nutritionOutbox,
    transactions: {
      async insert(row: OauthTransactionRow): Promise<void> {
        await queryable.query(
          `INSERT INTO oauth_transactions (
            id, state_hash, pkce_verifier_ciphertext, pkce_verifier_iv, pkce_verifier_auth_tag, pkce_key_version, initiating_user_id, expires_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            row.id,
            row.stateHash,
            row.pkceVerifierCiphertext,
            row.pkceVerifierIv,
            row.pkceVerifierAuthTag,
            row.pkceKeyVersion,
            row.initiatingUserId ?? null,
            row.expiresAt,
          ],
        );
      },
      async findById(id: string): Promise<OauthTransactionRow | undefined> {
        const result = await queryable.query('SELECT * FROM oauth_transactions WHERE id = $1', [id]);
        const row = result.rows[0];
        if (!row) {
          return undefined;
        }
        return {
          id: row.id,
          stateHash: asBuffer(row.state_hash) ?? Buffer.alloc(0),
          pkceVerifierCiphertext: asBuffer(row.pkce_verifier_ciphertext) ?? Buffer.alloc(0),
          pkceVerifierIv: asBuffer(row.pkce_verifier_iv) ?? Buffer.alloc(0),
          pkceVerifierAuthTag: asBuffer(row.pkce_verifier_auth_tag) ?? Buffer.alloc(0),
          pkceKeyVersion: row.pkce_key_version,
          initiatingUserId: row.initiating_user_id ?? undefined,
          expiresAt: row.expires_at,
        };
      },
      async deleteById(id: string): Promise<void> {
        await queryable.query('DELETE FROM oauth_transactions WHERE id = $1', [id]);
      },
      async deleteExpired(now: Date): Promise<void> {
        await queryable.query('DELETE FROM oauth_transactions WHERE expires_at <= $1', [now]);
      },
    },
  };

  return store;
}

export function getPostgresStore(databaseUrl: string): AuthStore {
  return storeFor(poolFor(databaseUrl) as unknown as PostgresQueryable);
}

/** Keeps SQL mapping and transaction boundaries testable without a networked database. */
export function createPostgresStoreForTesting(queryable: PostgresQueryable): AuthStore {
  return storeFor(queryable);
}

export function getPool(databaseUrl: string): pg.Pool {
  return poolFor(databaseUrl);
}

const migrated = new Set<string>();

export async function ensurePostgresReady(databaseUrl: string): Promise<AuthStore> {
  if (migrated.has(databaseUrl)) {
    return getPostgresStore(databaseUrl);
  }
  const { migrate } = await import('./migrate');
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await migrate(databaseUrl);
      migrated.add(databaseUrl);
      return getPostgresStore(databaseUrl);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}
