import type { OAuthConfig } from '../config/env';
import type { AuthStore, ConnectionRow, ScheduledSyncLease } from '../auth/types';
import { createGoogleTokenRefresher, resolveAccessToken, TokenRefreshError, type TokenRefresher } from './access-token';
import {
  connectionNextSyncAt,
  initialCivilBackfillRange,
  isUnsyncableError,
  scheduleTypeFailure,
  SNAPSHOT_SYNC_TYPES,
  successCursor,
  syncCardioConnection,
  type LoadHealthRecords,
} from './cardio-sync';
import { parseCardioLoadBootstrap } from '../../domain/cardio-records';
import { CARDIO_LOAD_TRIMP_VERSION } from '../../domain/metric-types';
import type { HealthSyncDataType } from './cardio-store';
import { createHealthApiClient, type HealthApiClient } from './health-api';
import { GoogleHealthProvider, type SnapshotRecordDataType } from './google-health-provider';
import { emptyUserHealthRecords, type HealthDateRange, type UserHealthRecords } from './provider';
import { loadHealthSnapshot, saveHealthSnapshot, type HealthSnapshot } from './snapshot-store';

const TRIMP_BOOTSTRAP_CARDIO_TYPES = ['heart-rate', 'activity-level'] as const satisfies readonly HealthSyncDataType[];

function bootstrapErrorCode(error: unknown): string {
  return error instanceof Error && /health api 429/i.test(error.message) ? 'rate_limited' : 'sync_failed';
}

export async function syncUserConnection(input: {
  config: OAuthConfig;
  store: AuthStore;
  userId: string;
  now?: Date;
  rangeDays?: number;
  persistSnapshot?: (userId: string, records: UserHealthRecords, syncedAt: Date) => Promise<void>;
  syncOne?: (connection: ConnectionRow, range: HealthDateRange) => Promise<void>;
  api?: HealthApiClient;
  refresher?: TokenRefresher;
  loadSnapshot?: (userId: string) => Promise<HealthSnapshot | undefined>;
  loadRecords?: LoadHealthRecords;
  scheduledRun?: ScheduledSyncLease & { signal: AbortSignal };
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const rangeDays = input.rangeDays ?? 42;
  const { from, to } = initialCivilBackfillRange(now, rangeDays);
  const persistSnapshot =
    input.persistSnapshot ??
    ((userId, records, syncedAt) =>
      saveHealthSnapshot({
        databaseUrl: input.config.databaseUrl,
        userId,
        records,
        syncedAt,
        lease: input.scheduledRun,
      }));
  const connection = await input.store.connections.findByUserId(input.userId);
  if (!connection || (connection.status !== 'active' && connection.status !== 'partial')) {
    return false;
  }
  if (input.syncOne) {
    await input.syncOne(connection, { from, to });
    return true;
  }

  const throwIfAborted = () => {
    if (input.scheduledRun?.signal.aborted) {
      throw new Error('scheduled sync deadline exceeded');
    }
  };
  const scheduledWrite = async <T>(write: (store: AuthStore) => Promise<T>): Promise<T> => {
    throwIfAborted();
    if (!input.scheduledRun) return write(input.store);
    return input.store.withScheduledSyncLease(input.scheduledRun, async (inner) => {
      throwIfAborted();
      return write(inner);
    });
  };
  const existingBootstrap = await input.store.healthMetrics.readCardioLoadBootstrap({
    userId: connection.userId,
    connectionId: connection.id,
  });
  const needsTrimpBootstrap = existingBootstrap?.status !== 'completed';
  const writeBootstrap = async (status: 'pending' | 'failed' | 'completed', errorCode: string | null) => {
    await scheduledWrite((store) => store.healthMetrics.upsertCardioLoadBootstrap(parseCardioLoadBootstrap({
      userId: connection.userId,
      connectionId: connection.id,
      metricVersion: CARDIO_LOAD_TRIMP_VERSION,
      status,
      attemptedAt: now.toISOString(),
      completedAt: status === 'completed' ? now.toISOString() : null,
      errorCode,
    })));
  };
  if (needsTrimpBootstrap) {
    await writeBootstrap('pending', null);
  }

  const api = input.api ?? createHealthApiClient();
  const refresher = input.refresher ?? createGoogleTokenRefresher(input.config);
  const loadSnapshot =
    input.loadSnapshot ??
    (input.persistSnapshot ? undefined : (userId: string) => loadHealthSnapshot(input.config.databaseUrl, userId));
  const provider = new GoogleHealthProvider({
    config: input.config,
    store: input.store,
    connection,
    now,
    api,
    refresher,
    persistSnapshot: (records, syncedAt) => persistSnapshot(connection.userId, records, syncedAt),
    loadSnapshot,
    lease: input.scheduledRun,
    signal: input.scheduledRun?.signal,
  });
  let snapshotRecords: UserHealthRecords | undefined;
  let snapshotAffectedDates: string[] = [];
  const dueSnapshotTypes: SnapshotRecordDataType[] = [];
  let hasIncompleteSnapshotBackfill = false;
  if (needsTrimpBootstrap) {
    dueSnapshotTypes.push(...SNAPSHOT_SYNC_TYPES);
    hasIncompleteSnapshotBackfill = true;
  } else {
    for (const dataType of SNAPSHOT_SYNC_TYPES) {
      throwIfAborted();
      const cursor = await input.store.healthMetrics.readCursor({ connectionId: connection.id, dataType });
      if (!cursor?.nextAttemptAt || cursor.nextAttemptAt.getTime() <= now.getTime()) {
        dueSnapshotTypes.push(dataType);
        hasIncompleteSnapshotBackfill ||= !cursor?.successfulWatermark;
      }
    }
  }
  let snapshotSucceeded: SnapshotRecordDataType[] = [];
  let snapshotFailure: unknown;
  let snapshotFailures: Array<{ dataType: SnapshotRecordDataType; error: unknown }> = [];
  try {
    if (dueSnapshotTypes.length > 0) {
      const snapshot = await provider.syncRecords(
        connection.userId,
        { from, to },
        dueSnapshotTypes,
        hasIncompleteSnapshotBackfill,
        !needsTrimpBootstrap,
      );
      snapshotRecords = snapshot.records;
      snapshotAffectedDates = snapshot.affectedDates;
      snapshotSucceeded = snapshot.succeededDataTypes;
      snapshotFailures = snapshot.failures.flatMap((failure) =>
        SNAPSHOT_SYNC_TYPES.includes(failure.dataType as SnapshotRecordDataType)
          ? [{ dataType: failure.dataType as SnapshotRecordDataType, error: failure.error }]
          : [],
      );
      for (const dataType of snapshot.succeededDataTypes) {
        if (needsTrimpBootstrap) {
          continue;
        }
        await scheduledWrite((store) => store.healthMetrics.updateCursor({
          connectionId: connection.id,
          dataType,
          ...successCursor(now),
        }));
      }
      for (const failure of snapshot.failures) {
        if (!SNAPSHOT_SYNC_TYPES.includes(failure.dataType as (typeof SNAPSHOT_SYNC_TYPES)[number])) {
          continue;
        }
        await scheduleTypeFailure({
          store: input.store,
          connectionId: connection.id,
          dataType: failure.dataType as (typeof SNAPSHOT_SYNC_TYPES)[number],
          now,
          error: failure.error,
          lease: input.scheduledRun,
        });
      }
    }
  } catch (error) {
    snapshotFailure = error;
    const current = await input.store.connections.findByUserId(connection.userId);
    if (!current || (current.status !== 'active' && current.status !== 'partial')) {
      return false;
    }
    if (error instanceof TokenRefreshError && error.isAuthFailure) {
      if (needsTrimpBootstrap) {
        await writeBootstrap('failed', bootstrapErrorCode(error));
      }
      throw error;
    }
    if (error instanceof Error && /connection no longer syncable/i.test(error.message)) {
      return false;
    }
    for (const dataType of dueSnapshotTypes) {
      await scheduleTypeFailure({
        store: input.store,
        connectionId: connection.id,
        dataType,
        now,
        error,
        lease: input.scheduledRun,
      });
    }
  }
  const latest = (await input.store.connections.findByUserId(connection.userId)) ?? connection;
  if (latest.status !== 'active' && latest.status !== 'partial') {
    return false;
  }
  let accessToken: string;
  try {
    accessToken = await resolveAccessToken({
      config: input.config,
      store: input.store,
      connection: latest,
      refresher,
      now,
      lease: input.scheduledRun,
    });
  } catch (error) {
    if (needsTrimpBootstrap) {
      await writeBootstrap('failed', bootstrapErrorCode(error));
    }
    throw error;
  }
  const loadRecords: LoadHealthRecords =
    input.loadRecords ??
    (async (userId) => {
      if (snapshotRecords) {
        return snapshotRecords;
      }
      return (await loadSnapshot?.(userId))?.records ?? emptyUserHealthRecords();
    });
  const lastSuccessfulSyncAt = latest.lastSuccessfulSyncAt;
  let cardio;
  try {
    cardio = await syncCardioConnection({
      store: input.store,
      connection: latest,
      api,
      accessToken,
      now,
      loadRecords,
      loadSnapshot,
      extraDates: needsTrimpBootstrap ? [from, ...snapshotAffectedDates] : snapshotAffectedDates,
      lastSuccessfulSyncAt,
      forceInitialBackfillDataTypes: needsTrimpBootstrap ? TRIMP_BOOTSTRAP_CARDIO_TYPES : undefined,
      deferSuccessCursorDataTypes: needsTrimpBootstrap ? TRIMP_BOOTSTRAP_CARDIO_TYPES : undefined,
      lease: input.scheduledRun,
      signal: input.scheduledRun?.signal,
    });
  } catch (error) {
    if (isUnsyncableError(error)) {
      return false;
    }
    if (needsTrimpBootstrap) {
      await writeBootstrap('failed', bootstrapErrorCode(error));
    }
    throw error;
  }
  if (needsTrimpBootstrap) {
    const snapshotComplete = SNAPSHOT_SYNC_TYPES.every((dataType) => snapshotSucceeded.includes(dataType));
    const cardioComplete = TRIMP_BOOTSTRAP_CARDIO_TYPES.every((dataType) => cardio.succeededDataTypes.includes(dataType))
      && !TRIMP_BOOTSTRAP_CARDIO_TYPES.some((dataType) => cardio.failedDataTypes.includes(dataType));
    if (snapshotComplete && cardioComplete) {
      await scheduledWrite(async (store) => {
        for (const dataType of SNAPSHOT_SYNC_TYPES) {
          await store.healthMetrics.updateCursor({
            connectionId: connection.id,
            dataType,
            ...successCursor(now),
          });
        }
        for (const dataType of TRIMP_BOOTSTRAP_CARDIO_TYPES) {
          await store.healthMetrics.updateCursor({
            connectionId: connection.id,
            dataType,
            ...successCursor(now),
          });
        }
        const current = await store.connections.findByUserId(connection.userId);
        if (!current || (current.status !== 'active' && current.status !== 'partial')) {
          throw new Error('connection no longer syncable');
        }
        const stamped = await store.connections.markLastSuccessfulSyncIfSyncable({
          id: current.id,
          userId: current.userId,
          syncedAt: now,
          lease: input.scheduledRun,
        });
        if (!stamped) {
          throw new Error('connection no longer syncable');
        }
        await store.healthMetrics.upsertCardioLoadBootstrap(parseCardioLoadBootstrap({
          userId: connection.userId,
          connectionId: connection.id,
          metricVersion: CARDIO_LOAD_TRIMP_VERSION,
          status: 'completed',
          attemptedAt: now.toISOString(),
          completedAt: now.toISOString(),
          errorCode: null,
        }));
      });
    } else {
      await writeBootstrap('failed', bootstrapErrorCode(snapshotFailure ?? snapshotFailures[0]?.error));
    }
  }
  const after = await input.store.connections.findByUserId(connection.userId);
  if (!input.scheduledRun && after && (after.status === 'active' || after.status === 'partial')) {
    await input.store.connections.update({
      ...after,
      nextSyncAt: connectionNextSyncAt(
        await input.store.healthMetrics.listCursors({ connectionId: connection.id }),
        now,
      ),
    });
  }
  return true;
}
