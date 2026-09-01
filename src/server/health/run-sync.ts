import type { OAuthConfig } from '../config/env';
import type { AuthStore, ConnectionRow } from '../auth/types';
import { civilDateRange } from '../time/civil-date';
import { createGoogleTokenRefresher, resolveAccessToken, TokenRefreshError, type TokenRefresher } from './access-token';
import {
  isUnsyncableError,
  scheduleTypeFailure,
  SNAPSHOT_SYNC_TYPES,
  snapshotAffectedDates,
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
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const rangeDays = input.rangeDays ?? 35;
  const { from, to } = civilDateRange(now, rangeDays, 'UTC');
  const persistSnapshot =
    input.persistSnapshot ??
    ((userId, records, syncedAt) =>
      saveHealthSnapshot({
        databaseUrl: input.config.databaseUrl,
        userId,
        records,
        syncedAt,
      }));
  const connection = await input.store.connections.findByUserId(input.userId);
  if (!connection || (connection.status !== 'active' && connection.status !== 'partial')) {
    return false;
  }
  if (input.syncOne) {
    await input.syncOne(connection, { from, to });
    return true;
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
  });
  let snapshotRecords: UserHealthRecords | undefined;
  const dueSnapshotTypes: SnapshotRecordDataType[] = [];
  for (const dataType of SNAPSHOT_SYNC_TYPES) {
    const cursor = await input.store.healthMetrics.readCursor({ connectionId: connection.id, dataType });
    if (!cursor?.nextAttemptAt || cursor.nextAttemptAt.getTime() <= now.getTime()) {
      dueSnapshotTypes.push(dataType);
    }
  }
  try {
    if (dueSnapshotTypes.length > 0) {
      const snapshot = await provider.syncRecords(connection.userId, { from, to }, dueSnapshotTypes);
      snapshotRecords = snapshot.records;
      for (const dataType of snapshot.succeededDataTypes) {
        await input.store.healthMetrics.updateCursor({
          connectionId: connection.id,
          dataType,
          ...successCursor(now),
        });
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
  });
  const loadRecords: LoadHealthRecords =
    input.loadRecords ??
    (async (userId) => {
      if (snapshotRecords) {
        return snapshotRecords;
      }
      return (await loadSnapshot?.(userId))?.records ?? emptyUserHealthRecords();
    });
  const previousSnapshot = snapshotRecords ? undefined : await loadSnapshot?.(connection.userId);
  const lastSuccessfulSyncAt = snapshotRecords
    ? latest.lastSuccessfulSyncAt ?? now
    : previousSnapshot?.syncedAt ?? latest.lastSuccessfulSyncAt;
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
      extraDates: snapshotRecords ? snapshotAffectedDates(snapshotRecords) : [],
      lastSuccessfulSyncAt,
    });
  } catch (error) {
    if (isUnsyncableError(error)) {
      return false;
    }
    throw error;
  }
  const after = await input.store.connections.findByUserId(connection.userId);
  if (after && (after.status === 'active' || after.status === 'partial')) {
    await input.store.connections.update({
      ...after,
      nextSyncAt: cardio.nextSyncAt,
    });
  }
  return true;
}
