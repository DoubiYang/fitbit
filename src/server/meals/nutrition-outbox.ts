import type { AuthStore } from '../auth/types';
import { canonicalNutritionHash, type GoogleNutritionDataPoint } from './google-nutrition';
import type { OutboxRow } from './types';

const GOOGLE_HEALTH_API = 'https://health.googleapis.com/v4';
export const LEASE_MS = 2 * 60 * 1_000;
export const OPERATION_RECHECK_MS = 60 * 1_000;
// Keep every outbound request well inside the two-minute DB lease. A timed-out
// create is reconciled by its deterministic data-point name and is never retried
// automatically, preventing a second worker from duplicating a late write.
// A row can need token retrieval, create and exact-name recovery in sequence.
// At 30 seconds each their worst case is still below the two-minute lease.
export const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 1_000;

export class GoogleNutritionWriteError extends Error {
  constructor(readonly status: number) {
    super(`Google nutrition write failed with status ${status}`);
    this.name = 'GoogleNutritionWriteError';
  }
}

export class NutritionOutboxRequestTimeoutError extends Error {
  constructor() {
    super('Google nutrition request exceeded the outbox lease-safe timeout');
    this.name = 'NutritionOutboxRequestTimeoutError';
  }
}

export class GoogleNutritionOperationError extends Error {
  constructor() {
    super('Google nutrition operation completed with an error');
    this.name = 'GoogleNutritionOperationError';
  }
}

export type GoogleNutritionOperation = {
  done: boolean;
  name?: string;
  error?: unknown;
};

export type GoogleNutritionOutboxClient = {
  create(accessToken: string, payload: GoogleNutritionDataPoint, signal?: AbortSignal): Promise<GoogleNutritionOperation>;
  batchDelete(accessToken: string, pointNames: string[], signal?: AbortSignal): Promise<GoogleNutritionOperation>;
  getDataPoint(accessToken: string, name: string, signal?: AbortSignal): Promise<GoogleNutritionDataPoint | undefined>;
  getOperation(accessToken: string, name: string, signal?: AbortSignal): Promise<GoogleNutritionOperation>;
};

export function createGoogleNutritionOutboxClient(fetchImpl: typeof fetch = fetch): GoogleNutritionOutboxClient {
  async function request(accessToken: string, path: string, init?: RequestInit, signal?: AbortSignal): Promise<Response> {
    return fetchImpl(`${GOOGLE_HEALTH_API}/${path}`, {
      ...init,
      signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init?.headers ?? {}),
      },
    });
  }

  async function parseOperation(response: Response, fallbackName?: string): Promise<GoogleNutritionOperation> {
    if (!response.ok) {
      throw new GoogleNutritionWriteError(response.status);
    }
    const body = (await response.json()) as Partial<GoogleNutritionOperation>;
    return {
      done: body.done === true,
      name: typeof body.name === 'string' ? body.name : fallbackName,
      error: body.error,
    };
  }

  return {
    async create(accessToken, payload, signal) {
      const response = await request(accessToken, 'users/me/dataTypes/nutrition-log/dataPoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, signal);
      return parseOperation(response);
    },
    async batchDelete(accessToken, pointNames, signal) {
      const names = [...new Set(pointNames)];
      if (names.length === 0) {
        throw new Error('batchDelete requires at least one data point name');
      }
      const response = await request(accessToken, 'users/me/dataTypes/nutrition-log/dataPoints:batchDelete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names }),
      }, signal);
      return parseOperation(response);
    },
    async getDataPoint(accessToken, name, signal) {
      const response = await request(accessToken, name, undefined, signal);
      if (response.status === 404) {
        return undefined;
      }
      if (!response.ok) {
        throw new GoogleNutritionWriteError(response.status);
      }
      return (await response.json()) as GoogleNutritionDataPoint;
    },
    async getOperation(accessToken, name, signal) {
      const response = await request(accessToken, name, undefined, signal);
      return parseOperation(response, name);
    },
  };
}

export function errorCode(error: unknown): string {
  if (error instanceof GoogleNutritionWriteError) {
    return `google_${error.status}`;
  }
  if (error instanceof NutritionOutboxRequestTimeoutError) {
    return 'request_timeout';
  }
  if (error instanceof GoogleNutritionOperationError) {
    return 'google_operation_error';
  }
  return 'indeterminate_create';
}

export function rejectErroredOperation(operation: GoogleNutritionOperation): GoogleNutritionOperation {
  if (operation.error !== undefined && operation.error !== null) {
    throw new GoogleNutritionOperationError();
  }
  return operation;
}

export async function withLeaseSafeTimeout<T>(
  call: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new NutritionOutboxRequestTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => call(controller.signal)), timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function requestTimeout(input: number | undefined): number {
  const requested = input ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error('requestTimeoutMs must be a positive finite number');
  }
  // A row can use this budget three times (token, create/operation, recovery),
  // so cap every individual outbound step at one quarter of the two-minute
  // lease and leave a full 30-second margin for state transitions.
  return Math.min(requested, LEASE_MS / 4);
}

export function retryAt(now: Date, attemptCount: number): Date {
  const delay = attemptCount <= 1 ? 60_000 : attemptCount === 2 ? 5 * 60_000 : 30 * 60_000;
  return new Date(now.getTime() + delay);
}

function lease(row: OutboxRow, now: Date) {
  if (!row.leaseUntil) {
    throw new Error('claimed nutrition outbox row is missing a lease');
  }
  return { id: row.id, userId: row.userId, leaseUntil: row.leaseUntil, now };
}

async function reconcileIndeterminateCreate(input: {
  row: OutboxRow;
  now: Date;
  accessToken: string;
  store: AuthStore;
  google: GoogleNutritionOutboxClient;
  requestTimeoutMs: number;
  errorCode?: string;
}): Promise<'synced' | 'unknown'> {
  const owner = lease(input.row, input.now);
  try {
    const existing = await withLeaseSafeTimeout(
      (signal) => input.google.getDataPoint(input.accessToken, input.row.dataPointName, signal),
      input.requestTimeoutMs,
    );
    if (existing && input.row.payloadHash && canonicalNutritionHash(existing.nutritionLog) === input.row.payloadHash) {
      await input.store.nutritionOutbox.markSynced(owner);
      return 'synced';
    }
  } catch {
    // An unavailable recovery endpoint remains indeterminate, never a retry.
  }
  await input.store.nutritionOutbox.markUnknown({ ...owner, errorCode: input.errorCode ?? 'indeterminate_create' });
  return 'unknown';
}

export async function runNutritionOutbox(input: {
  store: AuthStore;
  now?: Date;
  limit?: number;
  tokenForUser(userId: string): Promise<string>;
  google: GoogleNutritionOutboxClient;
  /** Test-only override; production requests default to 30 seconds. */
  requestTimeoutMs?: number;
}): Promise<{ claimed: number; succeeded: number; failed: number; retrying: number; unknown: number }> {
  const now = input.now ?? new Date();
  const timeoutMs = requestTimeout(input.requestTimeoutMs);
  const claimed = await input.store.nutritionOutbox.claimDue({
    now,
    leaseUntil: new Date(now.getTime() + LEASE_MS),
    limit: input.limit ?? 20,
  });
  const result = { claimed: claimed.length, succeeded: 0, failed: 0, retrying: 0, unknown: 0 };

  for (const row of claimed) {
    const owner = lease(row, now);
    if (!row.payload) {
      await input.store.nutritionOutbox.markUnknown({ ...owner, errorCode: 'missing_payload' });
      result.unknown += 1;
      continue;
    }
    let accessToken: string;
    try {
      accessToken = await withLeaseSafeTimeout(async () => input.tokenForUser(row.userId), timeoutMs);
    } catch {
      await input.store.nutritionOutbox.markFailedActionRequired({ ...owner, errorCode: 'token_unavailable' });
      result.failed += 1;
      continue;
    }
    try {
      if (row.status === 'operation_pending' && row.googleOperationName) {
        const operation = rejectErroredOperation(
          await withLeaseSafeTimeout(
            (signal) => input.google.getOperation(accessToken, row.googleOperationName!, signal),
            timeoutMs,
          ),
        );
        if (operation.done) {
          await input.store.nutritionOutbox.markSynced(owner);
          result.succeeded += 1;
        } else {
          await input.store.nutritionOutbox.markOperationPending({
            ...owner,
            operationName: row.googleOperationName,
            nextAttemptAt: new Date(now.getTime() + OPERATION_RECHECK_MS),
          });
        }
        continue;
      }

      const operation = rejectErroredOperation(
        await withLeaseSafeTimeout((signal) => input.google.create(accessToken, row.payload!, signal), timeoutMs),
      );
      if (operation.done) {
        await input.store.nutritionOutbox.markSynced(owner);
        result.succeeded += 1;
      } else if (operation.name) {
        await input.store.nutritionOutbox.markOperationPending({
          ...owner,
          operationName: operation.name,
          nextAttemptAt: new Date(now.getTime() + OPERATION_RECHECK_MS),
        });
      } else {
        const state = await reconcileIndeterminateCreate({
          row,
          now,
          accessToken,
          store: input.store,
          google: input.google,
          requestTimeoutMs: timeoutMs,
        });
        if (state === 'synced') {
          result.succeeded += 1;
        } else {
          result.unknown += 1;
        }
      }
    } catch (error) {
      if (error instanceof GoogleNutritionWriteError && (error.status === 401 || error.status === 403)) {
        await input.store.nutritionOutbox.markFailedActionRequired({ ...owner, errorCode: errorCode(error) });
        result.failed += 1;
      } else if (error instanceof GoogleNutritionWriteError && (error.status === 429 || error.status >= 500)) {
        await input.store.nutritionOutbox.markRetrying({
          ...owner,
          nextAttemptAt: retryAt(now, row.attemptCount ?? 1),
          errorCode: errorCode(error),
        });
        result.retrying += 1;
      } else {
        const state = await reconcileIndeterminateCreate({
          row,
          now,
          accessToken,
          store: input.store,
          google: input.google,
          requestTimeoutMs: timeoutMs,
          errorCode: errorCode(error),
        });
        if (state === 'synced') {
          result.succeeded += 1;
        } else {
          result.unknown += 1;
        }
      }
    }
  }
  return result;
}
