import { randomUUID } from 'node:crypto';

import { editableMealDraftSchema, toInternalNutrientAmount, type EditableMealDraft } from '../../domain/meal-editor';
import type { AuthStore, ConnectionRow, OauthTransactionRow, SessionRow } from '../auth/types';
import { confirmDraftRows, resolveDraftNutrition } from '../meals/confirm-draft';
import type { CurrentMealDishRow, CurrentMealIngredientRow, CurrentMealNutrientRow, CurrentMealSnapshot, CurrentMealStore, MealDishRow, MealDraftRow, MealIngredientRow, MealNutrientRow, MealNutritionProvenanceRow, MealSyncPointRow, MealType, MealVersionRow, OutboxRow } from '../meals/types';
import { resolveExactTwFdaFood, type LocalTwFdaFood } from '../nutrition/tw-fda';

export type MemoryStore = Omit<AuthStore, 'currentMeals'> & {
  currentMeals: CurrentMealStore;
  deletedHealthSnapshotUserIds: string[];
  seedFoodComposition(foods: LocalTwFdaFood[]): void;
  outboxRows(): OutboxRow[];
  currentMealSnapshots(): CurrentMealSnapshot[];
  mealSyncPoints(): MealSyncPointRow[];
};

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

function cloneCurrentMeal(row: CurrentMealSnapshot): CurrentMealSnapshot {
  return {
    ...structuredClone(row),
    eatenAt: new Date(row.eatenAt),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
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

export function createMemoryStore(): MemoryStore {
  const users = new Set<string>();
  const writebackEnabled = new Map<string, boolean>();
  const drafts = new Map<string, MealDraftRow>();
  const editorDrafts = new Map<string, EditableMealDraft>();
  const currentMeals = new Map<string, CurrentMealSnapshot>();
  const currentDishes = new Map<string, CurrentMealDishRow[]>();
  const currentIngredients = new Map<string, CurrentMealIngredientRow[]>();
  const currentNutrients = new Map<string, CurrentMealNutrientRow[]>();
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
  let foodComposition: LocalTwFdaFood[] = [];

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
      foodSource: 'unmatched' as const,
      foodSourceId: undefined,
      foodSourceVersion: undefined,
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
        source: 'editor',
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
      foodComposition: structuredClone(foodComposition),
    };
  }

  function restoreMap<T>(target: Map<string, T>, source: Map<string, T>): void {
    target.clear();
    for (const [id, row] of source) target.set(id, row);
  }

  function restoreState(state: ReturnType<typeof snapshotState>): void {
    users.clear();
    for (const user of state.users) users.add(user);
    restoreMap(writebackEnabled, state.writebackEnabled);
    restoreMap(drafts, state.drafts);
    restoreMap(editorDrafts, state.editorDrafts);
    restoreMap(currentMeals, state.currentMeals);
    restoreMap(currentDishes, state.currentDishes);
    restoreMap(currentIngredients, state.currentIngredients);
    restoreMap(currentNutrients, state.currentNutrients);
    versions.splice(0, versions.length, ...state.versions);
    dishes.splice(0, dishes.length, ...state.dishes);
    ingredients.splice(0, ingredients.length, ...state.ingredients);
    nutrients.splice(0, nutrients.length, ...state.nutrients);
    provenance.splice(0, provenance.length, ...state.provenance);
    outbox.splice(0, outbox.length, ...state.outbox);
    restoreMap(connections, state.connections);
    restoreMap(sessions, state.sessions);
    restoreMap(transactions, state.transactions);
    deletedHealthSnapshotUserIds.splice(0, deletedHealthSnapshotUserIds.length, ...state.deletedHealthSnapshotUserIds);
    foodComposition = state.foodComposition;
  }

  const store: AuthStore = {
    async withTransaction<T>(fn: (inner: AuthStore) => Promise<T>): Promise<T> {
      const state = snapshotState();
      try {
        return await fn(store);
      } catch (error) {
        restoreState(state);
        throw error;
      }
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
      async replaceCurrentMealContent(input) {
        const current = currentMeals.get(input.mealId);
        if (!current || current.userId !== input.userId) return undefined;
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
              ...nutrient, value: internal.value, unit: internal.unit,
            } : structuredClone(nutrient)),
          },
          now: input.now,
        });
      },
    },
    connections: {
      async findByHealthUserId(healthUserId: string): Promise<ConnectionRow | undefined> {
        const row = [...connections.values()].find((item) => item.healthUserId === healthUserId);
        return row ? cloneConnection(row) : undefined;
      },
      async findByUserId(userId: string): Promise<ConnectionRow | undefined> {
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
        if (!current || current.userId !== input.userId || (current.status !== 'active' && current.status !== 'partial')) {
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
        if (!current || current.userId !== input.userId || (current.status !== 'active' && current.status !== 'partial')) {
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
              row.nextSyncAt &&
              row.nextSyncAt.getTime() <= input.now.getTime() &&
              (!row.syncLeaseUntil || row.syncLeaseUntil.getTime() <= input.now.getTime()),
          )
          .sort((left, right) => {
            const byDue = left.nextSyncAt!.getTime() - right.nextSyncAt!.getTime();
            return byDue || left.id.localeCompare(right.id);
          })
          .slice(0, input.limit);
        for (const row of due) {
          connections.set(
            row.id,
            cloneConnection({
              ...row,
              syncLeaseUntil: input.leaseUntil,
              lastSyncAttemptAt: input.now,
              updatedAt: input.now,
              nextSyncAt: undefined,
            }),
          );
        }
        return due.map((row) =>
          cloneConnection({
            ...row,
            syncLeaseUntil: input.leaseUntil,
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
          current.syncLeaseUntil.getTime() !== input.leaseUntil.getTime()
        ) {
          return false;
        }
        const keepDue = current.nextSyncAt && current.nextSyncAt.getTime() <= input.now.getTime();
        connections.set(
          current.id,
          cloneConnection({
            ...current,
            nextSyncAt: keepDue ? current.nextSyncAt : input.nextSyncAt,
            syncRetryCount: keepDue ? current.syncRetryCount : input.syncRetryCount,
            syncLeaseUntil: undefined,
            lastErrorCode: keepDue ? current.lastErrorCode : input.lastErrorCode,
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
          current.syncLeaseUntil.getTime() !== input.leaseUntil.getTime()
        ) {
          return false;
        }
        connections.set(current.id, cloneConnection({ ...current, syncLeaseUntil: undefined, updatedAt: input.now }));
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

  return Object.assign(store, {
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
    mealSyncPoints() {
      return [];
    },
  }) as MemoryStore;
}
