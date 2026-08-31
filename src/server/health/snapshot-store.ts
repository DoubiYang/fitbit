import { getPool } from '../db/postgres-store';
import type { DailyHrv, DailyRhr, SleepSession, TrainingDay } from '../../domain/health-records';
import type { UserHealthRecords } from './provider';

export type HealthSnapshot = {
  records: UserHealthRecords;
  syncedAt: Date;
};

export const HEALTH_SNAPSHOT_RETAIN_CIVIL_DAYS = 35;

function addCivilDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function mergeByKey<T>(existing: T[], incoming: T[], keyOf: (row: T) => string): T[] {
  const merged = new Map<string, T>();
  for (const row of existing) {
    merged.set(keyOf(row), row);
  }
  for (const row of incoming) {
    merged.set(keyOf(row), row);
  }
  return [...merged.values()];
}

export function mergeHealthRecords(
  existing: UserHealthRecords | undefined,
  incoming: UserHealthRecords,
  options: { retainCivilDays?: number; now: Date },
): UserHealthRecords {
  const retain = options.retainCivilDays ?? HEALTH_SNAPSHOT_RETAIN_CIVIL_DAYS;
  const nowCivil = options.now.toISOString().slice(0, 10);
  const sleepSessions = mergeByKey(
    existing?.sleepSessions ?? [],
    incoming.sleepSessions,
    (row: SleepSession) => row.sourceRecordId || row.id,
  );
  const dailyHrv = mergeByKey(existing?.dailyHrv ?? [], incoming.dailyHrv, (row: DailyHrv) => row.date);
  const dailyRhr = mergeByKey(existing?.dailyRhr ?? [], incoming.dailyRhr, (row: DailyRhr) => row.date);
  const trainingDays = mergeByKey(
    existing?.trainingDays ?? [],
    incoming.trainingDays,
    (row: TrainingDay) => row.date,
  );
  const latest = [
    nowCivil,
    ...sleepSessions.map((row) => row.civilEndDate),
    ...dailyHrv.map((row) => row.date),
    ...dailyRhr.map((row) => row.date),
    ...trainingDays.map((row) => row.date),
  ].reduce((max, date) => (date > max ? date : max));
  const cutoff = addCivilDays(latest, -(retain - 1));
  return {
    sleepSessions: sleepSessions
      .filter((row) => row.civilEndDate >= cutoff)
      .sort((left, right) => left.civilEndDate.localeCompare(right.civilEndDate) || left.id.localeCompare(right.id)),
    dailyHrv: dailyHrv
      .filter((row) => row.date >= cutoff)
      .sort((left, right) => left.date.localeCompare(right.date)),
    dailyRhr: dailyRhr
      .filter((row) => row.date >= cutoff)
      .sort((left, right) => left.date.localeCompare(right.date)),
    trainingDays: trainingDays
      .filter((row) => row.date >= cutoff)
      .sort((left, right) => left.date.localeCompare(right.date)),
  };
}

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
