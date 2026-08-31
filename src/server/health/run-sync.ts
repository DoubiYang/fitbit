import type { OAuthConfig } from '../config/env';
import type { AuthStore, ConnectionRow } from '../auth/types';
import { civilDateRange } from '../time/civil-date';
import { createGoogleTokenRefresher, resolveAccessToken, type TokenRefresher } from './access-token';
import {
  scheduleTypeFailure,
  SNAPSHOT_SYNC_TYPES,
  successCursor,
  syncCardioConnection,
  type LoadHealthRecords,
} from './cardio-sync';
import { createHealthApiClient, type HealthApiClient } from './health-api';
import { GoogleHealthProvider } from './google-health-provider';
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
  try {
    snapshotRecords = await provider.listRecords(connection.userId, { from, to });
    for (const dataType of SNAPSHOT_SYNC_TYPES) {
      await input.store.healthMetrics.updateCursor({
        connectionId: connection.id,
        dataType,
        ...successCursor(now),
      });
    }
  } catch (error) {
    for (const dataType of SNAPSHOT_SYNC_TYPES) {
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
  const cardio = await syncCardioConnection({
    store: input.store,
    connection: latest,
    api,
    accessToken,
    now,
    loadRecords,
    loadSnapshot,
  });
  const after = await input.store.connections.findByUserId(connection.userId);
  if (after && (after.status === 'active' || after.status === 'partial')) {
    await input.store.connections.update({
      ...after,
      nextSyncAt: cardio.nextSyncAt,
    });
  }
  return true;
}
