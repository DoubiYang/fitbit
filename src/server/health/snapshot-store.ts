import { getPool } from '../db/postgres-store';
import type { UserHealthRecords } from './provider';

export type HealthSnapshot = {
  records: UserHealthRecords;
  syncedAt: Date;
};

export async function saveHealthSnapshot(input: {
  databaseUrl: string;
  userId: string;
  records: UserHealthRecords;
  syncedAt: Date;
}): Promise<void> {
  const pool = getPool(input.databaseUrl);
  const result = await pool.query(
    `WITH active_connection AS (
       SELECT user_id
       FROM google_health_connections
       WHERE user_id = $1 AND status IN ('active', 'partial')
       FOR UPDATE
     )
     INSERT INTO health_snapshots (user_id, sleep_count, hrv_count, rhr_count, training_day_count, records, synced_at)
     SELECT user_id, $2, $3, $4, $5, $6, $7
     FROM active_connection
     ON CONFLICT (user_id) DO UPDATE SET
       sleep_count = EXCLUDED.sleep_count,
       hrv_count = EXCLUDED.hrv_count,
       rhr_count = EXCLUDED.rhr_count,
       training_day_count = EXCLUDED.training_day_count,
       records = EXCLUDED.records,
       synced_at = EXCLUDED.synced_at
     RETURNING user_id`,
    [
      input.userId,
      input.records.sleepSessions.length,
      input.records.dailyHrv.length,
      input.records.dailyRhr.length,
      input.records.trainingDays.length,
      JSON.stringify(input.records),
      input.syncedAt,
    ],
  );
  if (result.rowCount !== 1) {
    throw new Error('connection no longer syncable');
  }
}

export async function loadHealthSnapshot(databaseUrl: string, userId: string): Promise<HealthSnapshot | undefined> {
  const pool = getPool(databaseUrl);
  const result = await pool.query('SELECT records, synced_at FROM health_snapshots WHERE user_id = $1', [userId]);
  const row = result.rows[0];
  if (!row) {
    return undefined;
  }
  return {
    records: row.records as UserHealthRecords,
    syncedAt: row.synced_at,
  };
}
