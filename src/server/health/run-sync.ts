import type { OAuthConfig } from '../config/env';
import type { AuthStore, ConnectionRow } from '../auth/types';
import { civilDateRange } from '../time/civil-date';
import { createGoogleTokenRefresher, resolveAccessToken, type TokenRefresher } from './access-token';
import { syncCardioConnection, type LoadHealthRecords } from './cardio-sync';
import { createHealthApiClient, type HealthApiClient } from './health-api';
import { GoogleHealthProvider } from './google-health-provider';
import type { HealthDateRange, UserHealthRecords } from './provider';
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
  const provider = new GoogleHealthProvider({
    config: input.config,
    store: input.store,
    connection,
    now,
    api,
    refresher,
    persistSnapshot: (records, syncedAt) => persistSnapshot(connection.userId, records, syncedAt),
    loadSnapshot:
      input.loadSnapshot ??
      (input.persistSnapshot
        ? undefined
        : (userId) => loadHealthSnapshot(input.config.databaseUrl, userId)),
  });
  const snapshotRecords = await provider.listRecords(connection.userId, { from, to });
  const latest = (await input.store.connections.findByUserId(connection.userId)) ?? connection;
  const accessToken = await resolveAccessToken({
    config: input.config,
    store: input.store,
    connection: latest,
    refresher,
    now,
  });
  const loadRecords: LoadHealthRecords = input.loadRecords ?? (async () => snapshotRecords);
  const cardio = await syncCardioConnection({
    store: input.store,
    connection: latest,
    api,
    accessToken,
    now,
    loadRecords,
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
