import type { AuthStore, MealSyncPointLease } from '../auth/types';
import { canonicalNutritionHash, type GoogleNutritionDataPoint } from './google-nutrition';
import {
  GoogleNutritionWriteError,
  LEASE_MS,
  OPERATION_RECHECK_MS,
  type GoogleNutritionOperation,
  type GoogleNutritionOutboxClient,
  errorCode,
  rejectErroredOperation,
  requestTimeout,
  retryAt,
  withLeaseSafeTimeout,
} from './nutrition-outbox';
import type { MealSyncPointRow } from './types';

type CurrentMealSyncResult = {
  claimed: number;
  succeeded: number;
  failed: number;
  retrying: number;
  unknown: number;
};

type CurrentMealSyncInput = {
  store: AuthStore;
  now?: Date;
  limit?: number;
  tokenForUser(userId: string): Promise<string>;
  google: GoogleNutritionOutboxClient;
  /** Test-only override; production requests default to 30 seconds. */
  requestTimeoutMs?: number;
};

function pointLease(row: MealSyncPointRow, now: Date): MealSyncPointLease {
  if (!row.leaseUntil) {
    throw new Error('claimed current-meal sync point is missing a lease');
  }
  return {
    id: row.id,
    generationId: row.generationId,
    userId: row.userId,
    leaseUntil: row.leaseUntil,
    now,
  };
}

function asPayload(row: MealSyncPointRow): GoogleNutritionDataPoint | undefined {
  return row.payload as GoogleNutritionDataPoint | undefined;
}

function initialResult(claimed: number): CurrentMealSyncResult {
  return { claimed, succeeded: 0, failed: 0, retrying: 0, unknown: 0 };
}

async function markWriteError(input: {
  row: MealSyncPointRow;
  now: Date;
  store: AuthStore;
  result: CurrentMealSyncResult;
  error: unknown;
}): Promise<void> {
  const owner = pointLease(input.row, input.now);
  if (input.error instanceof GoogleNutritionWriteError && (input.error.status === 401 || input.error.status === 403)) {
    if (await input.store.mealSync!.markPointFailedActionRequired({ ...owner, errorCode: errorCode(input.error) })) {
      input.result.failed += 1;
    }
    return;
  }
  if (input.error instanceof GoogleNutritionWriteError && (input.error.status === 429 || input.error.status >= 500)) {
    if (await input.store.mealSync!.retryPoint({
      ...owner,
      nextAttemptAt: retryAt(input.now, input.row.attemptCount),
      errorCode: errorCode(input.error),
    })) {
      input.result.retrying += 1;
    }
    return;
  }
  if (await input.store.mealSync!.markPointUnknown({ ...owner, errorCode: errorCode(input.error) })) {
    input.result.unknown += 1;
  }
}

async function markOperationResult(input: {
  row: MealSyncPointRow;
  operation: GoogleNutritionOperation;
  now: Date;
  store: AuthStore;
  result: CurrentMealSyncResult;
}): Promise<void> {
  const owner = pointLease(input.row, input.now);
  if (input.operation.done) {
    if (await input.store.mealSync!.finishPoint(owner)) input.result.succeeded += 1;
    return;
  }
  if (input.operation.name) {
    await input.store.mealSync!.markPointOperationPending({
      ...owner,
      operationName: input.operation.name,
      nextAttemptAt: new Date(input.now.getTime() + OPERATION_RECHECK_MS),
    });
    return;
  }
  if (await input.store.mealSync!.markPointUnknown({ ...owner, errorCode: 'missing_operation_name' })) {
    input.result.unknown += 1;
  }
}

async function accessTokenFor(input: {
  row: MealSyncPointRow;
  timeoutMs: number;
  tokenForUser(userId: string): Promise<string>;
}): Promise<string> {
  return withLeaseSafeTimeout(() => input.tokenForUser(input.row.userId), input.timeoutMs);
}

/**
 * Reconciliation after an indeterminate write deliberately has no write path:
 * it can only look up this generation's immutable, exact data-point name.
 */
async function recoverUnknownPoint(input: {
  row: MealSyncPointRow;
  now: Date;
  timeoutMs: number;
  store: AuthStore;
  tokenForUser(userId: string): Promise<string>;
  google: GoogleNutritionOutboxClient;
  result: CurrentMealSyncResult;
}): Promise<void> {
  const owner = pointLease(input.row, input.now);
  let accessToken: string;
  try {
    accessToken = await accessTokenFor(input);
  } catch {
    if (await input.store.mealSync!.markPointFailedActionRequired({ ...owner, errorCode: 'token_unavailable' })) {
      input.result.failed += 1;
    }
    return;
  }
  try {
    const existing = await withLeaseSafeTimeout(
      (signal) => input.google.getDataPoint(accessToken, input.row.dataPointName, signal),
      input.timeoutMs,
    );
    const confirmed = input.row.role === 'delete_target'
      ? existing === undefined
      : Boolean(existing && input.row.payloadHash && canonicalNutritionHash(existing.nutritionLog) === input.row.payloadHash);
    if (confirmed) {
      if (await input.store.mealSync!.finishPoint(owner)) input.result.succeeded += 1;
      return;
    }
    if (await input.store.mealSync!.markPointUnknown({ ...owner, errorCode: 'recovery_not_confirmed' })) {
      input.result.unknown += 1;
    }
  } catch (error) {
    // This point represents a write whose outcome is unknown.  A failed read
    // cannot safely turn it into retrying: retrying create points are eligible
    // for POST, which would replay that uncertain write.  Authentication is
    // the only actionable exception; all other read failures remain unknown.
    if (error instanceof GoogleNutritionWriteError && (error.status === 401 || error.status === 403)) {
      if (await input.store.mealSync!.markPointFailedActionRequired({ ...owner, errorCode: errorCode(error) })) {
        input.result.failed += 1;
      }
    } else if (await input.store.mealSync!.markPointUnknown({ ...owner, errorCode: errorCode(error) })) {
      input.result.unknown += 1;
    }
  }
}

async function pollOperation(input: {
  row: MealSyncPointRow;
  now: Date;
  timeoutMs: number;
  store: AuthStore;
  tokenForUser(userId: string): Promise<string>;
  google: GoogleNutritionOutboxClient;
  result: CurrentMealSyncResult;
}): Promise<void> {
  const owner = pointLease(input.row, input.now);
  if (!input.row.googleOperationName) {
    await input.store.mealSync!.markPointUnknown({ ...owner, errorCode: 'missing_operation_name' });
    input.result.unknown += 1;
    return;
  }
  let accessToken: string;
  try {
    accessToken = await accessTokenFor(input);
  } catch {
    if (await input.store.mealSync!.markPointFailedActionRequired({ ...owner, errorCode: 'token_unavailable' })) {
      input.result.failed += 1;
    }
    return;
  }
  try {
    const operation = rejectErroredOperation(await withLeaseSafeTimeout(
      (signal) => input.google.getOperation(accessToken, input.row.googleOperationName!, signal),
      input.timeoutMs,
    ));
    await markOperationResult({ row: input.row, operation, now: input.now, store: input.store, result: input.result });
  } catch (error) {
    await markWriteError({ row: input.row, now: input.now, store: input.store, result: input.result, error });
  }
}

async function createPoint(input: {
  row: MealSyncPointRow;
  now: Date;
  timeoutMs: number;
  store: AuthStore;
  tokenForUser(userId: string): Promise<string>;
  google: GoogleNutritionOutboxClient;
  result: CurrentMealSyncResult;
}): Promise<void> {
  const owner = pointLease(input.row, input.now);
  const payload = asPayload(input.row);
  if (!payload) {
    if (await input.store.mealSync!.markPointUnknown({ ...owner, errorCode: 'missing_payload' })) input.result.unknown += 1;
    return;
  }
  let accessToken: string;
  try {
    accessToken = await accessTokenFor(input);
  } catch {
    if (await input.store.mealSync!.markPointFailedActionRequired({ ...owner, errorCode: 'token_unavailable' })) {
      input.result.failed += 1;
    }
    return;
  }
  try {
    const operation = rejectErroredOperation(await withLeaseSafeTimeout(
      (signal) => input.google.create(accessToken, payload, signal),
      input.timeoutMs,
    ));
    await markOperationResult({ row: input.row, operation, now: input.now, store: input.store, result: input.result });
  } catch (error) {
    await markWriteError({ row: input.row, now: input.now, store: input.store, result: input.result, error });
  }
}

async function deleteBatch(input: {
  rows: MealSyncPointRow[];
  now: Date;
  timeoutMs: number;
  store: AuthStore;
  tokenForUser(userId: string): Promise<string>;
  google: GoogleNutritionOutboxClient;
  result: CurrentMealSyncResult;
}): Promise<void> {
  const [first] = input.rows;
  if (!first) return;
  let accessToken: string;
  try {
    accessToken = await accessTokenFor({ row: first, timeoutMs: input.timeoutMs, tokenForUser: input.tokenForUser });
  } catch {
    for (const row of input.rows) {
      const owner = pointLease(row, input.now);
      if (await input.store.mealSync!.markPointFailedActionRequired({ ...owner, errorCode: 'token_unavailable' })) {
        input.result.failed += 1;
      }
    }
    return;
  }
  try {
    const operation = rejectErroredOperation(await withLeaseSafeTimeout(
      (signal) => input.google.batchDelete(accessToken, input.rows.map((row) => row.dataPointName), signal),
      input.timeoutMs,
    ));
    for (const row of input.rows) {
      await markOperationResult({ row, operation, now: input.now, store: input.store, result: input.result });
    }
  } catch (error) {
    for (const row of input.rows) {
      await markWriteError({ row, now: input.now, store: input.store, result: input.result, error });
    }
  }
}

/**
 * Executes only already-persisted sync points.  It intentionally has no HTTP
 * surface and no scheduler hookup: an explicit sync request merely creates the
 * immutable generation, while a separate runner invokes this worker.
 */
export async function runCurrentMealSyncOutbox(input: CurrentMealSyncInput): Promise<CurrentMealSyncResult> {
  if (!input.store.mealSync) return initialResult(0);
  const now = input.now ?? new Date();
  const timeoutMs = requestTimeout(input.requestTimeoutMs);
  const claimed = await input.store.mealSync.claimDuePoints({
    now,
    leaseUntil: new Date(now.getTime() + LEASE_MS),
    limit: input.limit ?? 20,
  });
  const result = initialResult(claimed.length);
  const normalDeleteGroups = new Map<string, MealSyncPointRow[]>();
  const individual: MealSyncPointRow[] = [];

  for (const row of claimed) {
    if (row.role === 'delete_target' && !row.googleOperationName && row.status !== 'unknown' && row.status !== 'operation_pending') {
      const key = `${row.generationId}\u0000${row.userId}`;
      const group = normalDeleteGroups.get(key) ?? [];
      group.push(row);
      normalDeleteGroups.set(key, group);
    } else {
      individual.push(row);
    }
  }
  for (const rows of normalDeleteGroups.values()) {
    // Google batchDelete has a 10,000-name maximum. Claim limits are lower,
    // but keep the worker safe should its caller raise the limit later.
    for (let start = 0; start < rows.length; start += 10_000) {
      await deleteBatch({ ...input, rows: rows.slice(start, start + 10_000), now, timeoutMs, result });
    }
  }
  for (const row of individual) {
    if (row.status === 'unknown') {
      await recoverUnknownPoint({ ...input, row, now, timeoutMs, result });
    } else if (row.googleOperationName || row.status === 'operation_pending') {
      await pollOperation({ ...input, row, now, timeoutMs, result });
    } else if (row.role === 'create_target') {
      await createPoint({ ...input, row, now, timeoutMs, result });
    } else {
      // A delete with an operation is handled above; a claimed delete without
      // one belongs to a batch. Keep this as an indeterminate safety valve.
      const owner = pointLease(row, now);
      if (await input.store.mealSync.markPointUnknown({ ...owner, errorCode: 'unexpected_delete_state' })) result.unknown += 1;
    }
  }
  return result;
}
