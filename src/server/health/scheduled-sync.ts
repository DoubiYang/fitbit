import type { OAuthConfig } from '../config/env';
import type { AuthStore, ConnectionRow } from '../auth/types';
import { TokenRefreshError } from './access-token';
import { syncUserConnection } from './run-sync';

const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;
const LEASE_MS = 15 * 60 * 1_000;
const RETRY_DELAYS_MS = [30 * 60 * 1_000, 60 * 60 * 1_000, 2 * 60 * 60 * 1_000] as const;

export type ScheduledSyncResult = { claimed: number; succeeded: number; failed: number };

type ScheduledSyncInput = {
  config: OAuthConfig;
  store: AuthStore;
  now?: Date;
  limit?: number;
  userId?: string;
  syncConnection?: (connection: ConnectionRow) => Promise<void>;
};

function failureSchedule(now: Date, retryCount: number): { nextSyncAt: Date; syncRetryCount: number } {
  if (retryCount < RETRY_DELAYS_MS.length) {
    return {
      nextSyncAt: new Date(now.getTime() + RETRY_DELAYS_MS[retryCount]),
      syncRetryCount: retryCount + 1,
    };
  }
  return { nextSyncAt: new Date(now.getTime() + SIX_HOURS_MS), syncRetryCount: 0 };
}

function errorCode(error: unknown): string {
  return error instanceof Error && /health api 429/i.test(error.message) ? 'rate_limited' : 'sync_failed';
}

function isAuthFailure(error: unknown): boolean {
  return error instanceof TokenRefreshError && error.isAuthFailure;
}

export async function runDueSyncs(input: ScheduledSyncInput): Promise<ScheduledSyncResult> {
  const maxClaims = input.limit ?? 10;
  const result: ScheduledSyncResult = { claimed: 0, succeeded: 0, failed: 0 };

  for (let index = 0; index < maxClaims; index += 1) {
    const now = input.now ?? new Date();
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    const [connection] = await input.store.connections.claimDueSyncs({
      now,
      leaseUntil,
      limit: 1,
      userId: input.userId,
    });
    if (!connection) {
      break;
    }
    const syncConnection =
      input.syncConnection ??
      (async (row: ConnectionRow) => {
        const synced = await syncUserConnection({ config: input.config, store: input.store, userId: row.userId, now });
        if (!synced) {
          throw new Error('connection no longer syncable');
        }
      });
    result.claimed += 1;
    if (!connection.syncLeaseUntil) {
      result.failed += 1;
      continue;
    }
    try {
      await syncConnection(connection);
      const finished = await input.store.connections.finishScheduledSync({
        id: connection.id,
        userId: connection.userId,
        leaseUntil: connection.syncLeaseUntil,
        now,
        nextSyncAt: new Date(now.getTime() + SIX_HOURS_MS),
        syncRetryCount: 0,
        lastErrorCode: undefined,
      });
      if (finished) {
        result.succeeded += 1;
      } else {
        result.failed += 1;
      }
    } catch (error) {
      if (isAuthFailure(error)) {
        const expired = await input.store.connections.expireIfSyncable({
          id: connection.id,
          userId: connection.userId,
          now,
          lastErrorCode: 'expired',
          leaseUntil: connection.syncLeaseUntil,
          tokenEnvelopeCiphertext: connection.tokenEnvelopeCiphertext,
        });
        if (!expired) {
          await input.store.connections.clearSyncLeaseIfHeld({
            id: connection.id,
            userId: connection.userId,
            leaseUntil: connection.syncLeaseUntil,
            now,
          });
        }
        result.failed += 1;
        continue;
      }
      const next = failureSchedule(now, connection.syncRetryCount ?? 0);
      await input.store.connections.finishScheduledSync({
        id: connection.id,
        userId: connection.userId,
        leaseUntil: connection.syncLeaseUntil,
        now,
        nextSyncAt: next.nextSyncAt,
        syncRetryCount: next.syncRetryCount,
        lastErrorCode: errorCode(error),
      });
      result.failed += 1;
    }
  }
  return result;
}

export async function runDueSyncForUser(
  input: Omit<ScheduledSyncInput, 'userId' | 'limit'> & { userId: string },
): Promise<ScheduledSyncResult> {
  return runDueSyncs({ ...input, limit: 1 });
}

export function scheduleInitialSync(
  run: () => Promise<ScheduledSyncResult>,
  schedule: (work: () => void | Promise<void>) => void,
  log: (message: string) => void = console.log,
): void {
  schedule(() =>
    run()
      .then((result) => {
        log(`[sync] initial claimed=${result.claimed} succeeded=${result.succeeded} failed=${result.failed}`);
      })
      .catch(() => {
        log('[sync] initial sync failed');
      }),
  );
}
