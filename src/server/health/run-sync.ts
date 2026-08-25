import type { OAuthConfig } from '../config/env';
import type { AuthStore, ConnectionRow } from '../auth/types';
import { civilDateRange } from '../time/civil-date';
import type { HealthDateRange, UserHealthRecords } from './provider';
import { GoogleHealthProvider } from './google-health-provider';
import { saveHealthSnapshot } from './snapshot-store';

export async function syncUserConnection(input: {
  config: OAuthConfig;
  store: AuthStore;
  userId: string;
  now?: Date;
  rangeDays?: number;
  persistSnapshot?: (userId: string, records: UserHealthRecords, syncedAt: Date) => Promise<void>;
  syncOne?: (connection: ConnectionRow, range: HealthDateRange) => Promise<void>;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const rangeDays = input.rangeDays ?? 14;
  const { from, to } = civilDateRange(now, rangeDays);
  const persistSnapshot =
    input.persistSnapshot ??
    ((userId, records, syncedAt) =>
      saveHealthSnapshot({
        databaseUrl: input.config.databaseUrl,
        userId,
        records,
        syncedAt,
      }));
  const syncOne =
    input.syncOne ??
    (async (connection, range) => {
      const provider = new GoogleHealthProvider({
        config: input.config,
        store: input.store,
        connection,
        now,
        persistSnapshot: (records, syncedAt) => persistSnapshot(connection.userId, records, syncedAt),
      });
      await provider.listRecords(connection.userId, range);
    });
  const connection = await input.store.connections.findByUserId(input.userId);
  if (!connection || (connection.status !== 'active' && connection.status !== 'partial')) {
    return false;
  }
  await syncOne(connection, { from, to });
  return true;
}
