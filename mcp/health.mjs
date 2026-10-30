import { z } from 'zod';

export const dateSchema = z.iso.date();
export const rangeSchema = z.object({ from: dateSchema, to: dateSchema }).strict().refine(
  ({ from, to }) => to >= from && (Date.parse(to) - Date.parse(from)) / 86400000 < 42,
  'Use an ordered date range of at most 42 days.',
);

function pick(row, keys) {
  return Object.fromEntries(keys.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
}

export function createHealthReader(pool, userId, accountUrl) {
  const query = async (sql, params = []) => (await pool.query(sql, [userId, ...params])).rows;
  async function status() {
    const rows = await query(`SELECT c.status, c.last_successful_sync_at, c.next_sync_at,
      c.last_error_code, s.synced_at AS snapshot_synced_at
      FROM google_health_connections c LEFT JOIN health_snapshots s ON s.user_id = c.user_id
      WHERE c.user_id = $1`);
    const row = rows[0];
    const last = row?.last_successful_sync_at;
    return {
      connection: row?.status ?? 'not_connected',
      lastSuccessfulSyncAt: last ?? null,
      snapshotSyncedAt: row?.snapshot_synced_at ?? null,
      nextSyncAt: row?.next_sync_at ?? null,
      lastErrorCode: row?.last_error_code ?? null,
      stale: !last || Date.now() - new Date(last).getTime() > 36 * 3600000,
      accountUrl,
    };
  }
  return {
    status,
    async history(args) {
      const { from, to } = rangeSchema.parse(args);
      const [snapshot] = await query('SELECT records FROM health_snapshots WHERE user_id = $1');
      const records = snapshot?.records ?? {};
      const filter = (key, dateKey, fields) => (records[key] ?? [])
        .filter((row) => row.userId === userId && row[dateKey] >= from && row[dateKey] <= to)
        .map((row) => pick(row, fields));
      const heartRate = await query(`SELECT civil_date::text AS date,
        round((sum(avg_bpm * coverage_seconds) / nullif(sum(coverage_seconds), 0))::numeric, 1) AS average_bpm,
        min(min_bpm) AS minimum_bpm, max(max_bpm) AS maximum_bpm,
        round((sum(coverage_seconds) / 60)::numeric, 1) AS observed_minutes
        FROM heart_rate_minute_aggregates WHERE user_id = $1 AND civil_date BETWEEN $2 AND $3
        GROUP BY civil_date ORDER BY civil_date`, [from, to]);
      return {
        from, to, sync: await status(),
        sleep: filter('sleepSessions', 'civilEndDate', ['civilEndDate', 'startTime', 'endTime', 'minutesAsleep', 'timeInBedMinutes', 'isNap', 'processed']),
        hrv: filter('dailyHrv', 'date', ['date', 'valueMs', 'source']),
        restingHeartRate: filter('dailyRhr', 'date', ['date', 'valueBpm', 'source']),
        activity: filter('trainingDays', 'date', ['date', 'completeness', 'load']),
        heartRate,
        note: 'Local synchronized observations. Missing values are unknown. Empty results may mean no retained data; they do not mean zero.',
      };
    },
    async summary(args) {
      const date = dateSchema.parse(args.date);
      const [metrics, load, capacity] = await Promise.all([
        query(`SELECT metric_name, metric_version, score, quality, reason, quality_flags
          FROM metric_results WHERE user_id = $1 AND civil_date = $2
          AND metric_name IN ('recovery', 'sleep_performance') AND metric_version = 'whoop-style-v2'`, [date]),
        query(`SELECT daily_load, status, quality_state, qualified_seconds, unverified_elevated_hr_seconds
          FROM daily_cardio_loads WHERE user_id = $1 AND civil_date = $2 AND metric_version = 'cardio-load-trimp-v3'`, [date]),
        query(`SELECT usable_load, utilization, status, recovery_tier FROM daily_load_capacities
          WHERE user_id = $1 AND civil_date = $2 AND metric_version = 'cardio-load-trimp-v3'`, [date]),
      ]);
      return { date, sync: await status(), metrics, cardioLoad: load[0] ?? null, capacity: capacity[0] ?? null,
        note: 'TRIMP is in TRIMP units. Capacity is a historical reference. Inspect sync staleness and quality before drawing conclusions.' };
    },
  };
}
