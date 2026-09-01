import type { OAuthConfig } from '../config/env';
import type { AuthStore, ConnectionRow, ScheduledSyncLease } from '../auth/types';
import { createGoogleTokenRefresher, resolveAccessToken, TokenRefreshError, type TokenRefresher } from './access-token';
import {
  initialCivilBackfillRange,
  isUnsyncableError,
  scheduleTypeFailure,
  SNAPSHOT_SYNC_TYPES,
  successCursor,
  syncCardioConnection,
  type LoadHealthRecords,
} from './cardio-sync';
import { createHealthApiClient, type HealthApiClient } from './health-api';
import { GoogleHealthProvider, type SnapshotRecordDataType } from './google-health-provider';
import { emptyUserHealthRecords, type HealthDateRange, type UserHealthRecords } from './provider';
import { loadHealthSnapshot, saveHealthSnapshot, type HealthSnapshot } from './snapshot-store';

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
  const rangeDays = input.rangeDays ?? 35;
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
  for (const dataType of SNAPSHOT_SYNC_TYPES) {
    throwIfAborted();
    const cursor = await input.store.healthMetrics.readCursor({ connectionId: connection.id, dataType });
    if (!cursor?.nextAttemptAt || cursor.nextAttemptAt.getTime() <= now.getTime()) {
      dueSnapshotTypes.push(dataType);
      hasIncompleteSnapshotBackfill ||= !cursor?.successfulWatermark;
    }
  }
  try {
    if (dueSnapshotTypes.length > 0) {
      const snapshot = await provider.syncRecords(
        connection.userId,
        { from, to },
        dueSnapshotTypes,
        hasIncompleteSnapshotBackfill,
      );
      snapshotRecords = snapshot.records;
      snapshotAffectedDates = snapshot.affectedDates;
      for (const dataType of snapshot.succeededDataTypes) {
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
    const current = await input.store.connections.findByUserId(connection.userId);
    if (!current || (current.status !== 'active' && current.status !== 'partial')) {
      return false;
    }
    if (error instanceof TokenRefreshError && error.isAuthFailure) {
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
  const accessToken = await resolveAccessToken({
    config: input.config,
    store: input.store,
    connection: latest,
    refresher,
    now,
    lease: input.scheduledRun,
  });
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
      extraDates: snapshotAffectedDates,
      lastSuccessfulSyncAt,
      lease: input.scheduledRun,
      signal: input.scheduledRun?.signal,
    });
  } catch (error) {
    if (isUnsyncableError(error)) {
      return false;
    }
    throw error;
  }
  const after = await input.store.connections.findByUserId(connection.userId);
  if (!input.scheduledRun && after && (after.status === 'active' || after.status === 'partial')) {
    await input.store.connections.update({
      ...after,
      nextSyncAt: cardio.nextSyncAt,
    });
  }
  return true;
}
