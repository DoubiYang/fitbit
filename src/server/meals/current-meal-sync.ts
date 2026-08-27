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

const MAX_BATCH_DELETE_CLAIM_LIMIT = 20;

function claimLimit(input: number | undefined): number {
  const requested = input ?? MAX_BATCH_DELETE_CLAIM_LIMIT;
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new Error('limit must be a positive integer');
  }
  return Math.min(requested, MAX_BATCH_DELETE_CLAIM_LIMIT);
}

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

/**
 * A claimed point gets another full lease window immediately before token/API
 * I/O.  Exact old-lease ownership makes a stale worker harmless: if renewal
 * loses the compare-and-set race it must not send the remote request.
 */
async function renewLeaseForExternalAction(input: {
  row: MealSyncPointRow;
  now: Date;
  store: AuthStore;
}): Promise<boolean> {
  const currentLeaseUntil = input.row.leaseUntil;
  if (!currentLeaseUntil) return false;
  const renewedLeaseUntil = new Date(currentLeaseUntil.getTime() + LEASE_MS);
  const renewed = await input.store.mealSync!.renewPointLease({
    ...pointLease(input.row, input.now),
    renewedLeaseUntil,
  });
  if (!renewed) return false;
  input.row.leaseUntil = renewedLeaseUntil;
  return true;
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
  if (!await renewLeaseForExternalAction(input)) return;
  const owner = pointLease(input.row, input.now);
  let accessToken: string;
  try {
    accessToken = await accessTokenFor(input);
  } catch {
    // This is already an indeterminate write.  Do not turn a recovery-token
    // problem into failed_action_required: beginRecovery would resume that
    // status as pending and make the original create eligible for POST.
    if (await input.store.mealSync!.markPointUnknown({ ...owner, errorCode: 'token_unavailable' })) {
      input.result.unknown += 1;
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
    // cannot safely transition to *any* resumable state: retrying and
    // failed_action_required can both become POST-eligible after recovery.
    // Keep the error in last_error_code while retaining unknown's exact-GET
    // recovery path, including for token and 401/403 failures.
    if (await input.store.mealSync!.markPointUnknown({ ...owner, errorCode: errorCode(error) })) {
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
  if (!input.row.googleOperationName) {
    const owner = pointLease(input.row, input.now);
    await input.store.mealSync!.markPointUnknown({ ...owner, errorCode: 'missing_operation_name' });
    input.result.unknown += 1;
    return;
  }
  if (!await renewLeaseForExternalAction(input)) return;
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
  const payload = asPayload(input.row);
  if (!payload) {
    const owner = pointLease(input.row, input.now);
    if (await input.store.mealSync!.markPointUnknown({ ...owner, errorCode: 'missing_payload' })) input.result.unknown += 1;
    return;
  }
  if (!await renewLeaseForExternalAction(input)) return;
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
  const rows: MealSyncPointRow[] = [];
  for (const row of input.rows) {
    if (await renewLeaseForExternalAction({ row, now: input.now, store: input.store })) rows.push(row);
  }
  const [first] = rows;
  if (!first) return;
  let accessToken: string;
  try {
    accessToken = await accessTokenFor({ row: first, timeoutMs: input.timeoutMs, tokenForUser: input.tokenForUser });
  } catch {
    for (const row of rows) {
      const owner = pointLease(row, input.now);
      if (await input.store.mealSync!.markPointFailedActionRequired({ ...owner, errorCode: 'token_unavailable' })) {
        input.result.failed += 1;
      }
    }
    return;
  }
  try {
    const operation = rejectErroredOperation(await withLeaseSafeTimeout(
      (signal) => input.google.batchDelete(accessToken, rows.map((row) => row.dataPointName), signal),
      input.timeoutMs,
    ));
    for (const row of rows) {
      await markOperationResult({ row, operation, now: input.now, store: input.store, result: input.result });
    }
  } catch (error) {
    for (const row of rows) {
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
  const batchLimit = claimLimit(input.limit);
  if (!input.store.mealSync) return initialResult(0);
  const now = input.now ?? new Date();
  const timeoutMs = requestTimeout(input.requestTimeoutMs);
  // A delete batch makes exactly one Google write.  The store leases only one
  // generation/user cohort, so all names share that one bounded request.
  const deleteClaims = await input.store.mealSync.claimDuePoints({
    now,
    leaseUntil: new Date(now.getTime() + LEASE_MS),
    limit: batchLimit,
    mode: 'batch_delete',
  });
  if (deleteClaims.length > 0) {
    const result = initialResult(deleteClaims.length);
    await deleteBatch({ ...input, rows: deleteClaims, now, timeoutMs, result });
    return result;
  }
  // Creates, exact-name recovery, and operation polling each may consume a
  // token plus an API timeout.  Lease one only, rather than allowing later
  // points to expire while earlier network calls are still in flight.
  const [row] = await input.store.mealSync.claimDuePoints({
    now,
    leaseUntil: new Date(now.getTime() + LEASE_MS),
    limit: 1,
    mode: 'single',
  });
  const result = initialResult(row ? 1 : 0);
  if (!row) return result;
  if (row.status === 'unknown') {
    await recoverUnknownPoint({ ...input, row, now, timeoutMs, result });
  } else if (row.googleOperationName || row.status === 'operation_pending') {
    await pollOperation({ ...input, row, now, timeoutMs, result });
  } else if (row.role === 'create_target') {
    await createPoint({ ...input, row, now, timeoutMs, result });
  } else {
    const owner = pointLease(row, now);
    if (await input.store.mealSync.markPointUnknown({ ...owner, errorCode: 'unexpected_delete_state' })) result.unknown += 1;
  }
  return result;
}
