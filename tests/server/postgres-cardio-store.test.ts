import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  parseDailyCardio,
  parseDailyHeartRateZones,
  parseHeartRateMinuteAggregate,
  parseMetricResult,
  parseSleepGoal,
} from '../../src/domain/cardio-records';
import { WHOOP_STYLE_METRIC_VERSION } from '../../src/domain/metric-types';
import { createPostgresStoreForTesting } from '../../src/server/db/postgres-store';
import {
  healthMetricsExposesRawSamplePersistence,
  SleepGoalConflictError,
} from '../../src/server/health/cardio-store';

type Query = { text: string; values: unknown[] | undefined };
type QueryResponse = { rows: Array<Record<string, unknown>>; rowCount?: number } | Error;

const userId = '11111111-1111-1111-1111-111111111111';
const connectionId = '22222222-2222-2222-2222-222222222222';
const civilDate = '2026-08-22';
const now = new Date('2026-08-22T16:00:00.000Z');
const migration = readFileSync(new URL('../../db/migrations/010_whoop_style_metrics.sql', import.meta.url), 'utf8');

const zones = {
  LIGHT: { minBeatsPerMinute: 97, maxBeatsPerMinute: 116 },
  MODERATE: { minBeatsPerMinute: 117, maxBeatsPerMinute: 136 },
  VIGOROUS: { minBeatsPerMinute: 137, maxBeatsPerMinute: 155 },
  PEAK: { minBeatsPerMinute: 156, maxBeatsPerMinute: 200 },
};

class RecordingPool {
  readonly queries: Query[] = [];
  private readonly responses: QueryResponse[];
  readonly client = {
    query: async (text: string, values?: unknown[]) => this.query(text, values),
    release: () => undefined,
  };

  constructor(responses: QueryResponse[] = []) {
    this.responses = [...responses];
  }

  async connect() {
    return this.client;
  }

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text, values });
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    if (!response) return { rows: [] as Array<Record<string, unknown>>, rowCount: 0 };
    return { rows: response.rows, rowCount: response.rowCount ?? response.rows.length };
  }
}

function minute() {
  return parseHeartRateMinuteAggregate({
    userId,
    sourceFamily: 'google-wearables',
    minuteStartUtc: '2026-08-22T12:00:00.000Z',
    civilDate,
    utcOffsetMinutes: 480,
    ianaTimeZone: null,
    localMinuteOfDay: 1200,
    avgBpm: 110,
    minBpm: 108,
    maxBpm: 112,
    sampleCount: 8,
    coverageSeconds: 60,
    activityLevel: 'LIGHTLY_ACTIVE',
  });
}

function metric() {
  return parseMetricResult({
    userId,
    civilDate,
    metricName: 'strain',
    metricVersion: WHOOP_STYLE_METRIC_VERSION,
    score: 8.4,
    status: 'complete',
    quality: null,
    reason: null,
    evidence: [{ label: 'dose', date: civilDate, value: 70 }],
    source: {
      heartRateZones: true,
      activityLevel: true,
      exercise: false,
      sleep: false,
      hrv: false,
      rhr: false,
      sleepGoal: false,
      timeZone: 'missing',
    },
    coverage: {
      knownContextMinutes: 600,
      rawHeartRateMinutes: 610,
      attributedMinutes: 24,
      lastKnownContextAt: '2026-08-22T15:50:00.000Z',
    },
  });
}

test('migration 010 creates the ten whoop-style metric tables with cascade, checks, and lookup indexes', () => {
  for (const table of [
    'heart_rate_minute_aggregates',
    'activity_level_intervals',
    'daily_heart_rate_zones',
    'daily_time_in_zone',
    'exercise_intervals',
    'daily_cardio',
    'health_sync_cursors',
    'metric_results',
    'user_sleep_goal_history',
    'user_health_time_zone_history',
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`, 'u'));
    if (table === 'health_sync_cursors') {
      assert.match(migration, /REFERENCES google_health_connections \(id\) ON DELETE CASCADE/u);
    } else {
      assert.match(migration, new RegExp(`${table}[\\s\\S]*?REFERENCES users \\(id\\) ON DELETE CASCADE`, 'u'));
    }
  }

  assert.match(migration, /PRIMARY KEY \(user_id, source_family, minute_start_utc\)/u);
  assert.match(migration, /PRIMARY KEY \(user_id, source_family, interval_start_utc\)/u);
  assert.match(migration, /PRIMARY KEY \(user_id, source_family, civil_date\)/u);
  assert.match(migration, /PRIMARY KEY \(user_id, source_family, source_record_id\)/u);
  assert.match(migration, /PRIMARY KEY \(user_id, civil_date\)/u);
  assert.match(migration, /PRIMARY KEY \(connection_id, data_type\)/u);
  assert.match(migration, /PRIMARY KEY \(user_id, civil_date, metric_name, metric_version\)/u);
  assert.match(migration, /PRIMARY KEY \(user_id, effective_civil_date\)/u);
  assert.match(migration, /PRIMARY KEY \(user_id, effective_at\)/u);
  assert.match(migration, /CHECK \(goal_minutes BETWEEN 300 AND 900\)/u);
  assert.match(migration, /is_backfill_anchor BOOLEAN NOT NULL/u);
  assert.match(migration, /successful_watermark TIMESTAMPTZ/u);
  assert.match(migration, /last_error_code TEXT/u);
  assert.match(migration, /retry_count INTEGER NOT NULL DEFAULT 0/u);
  assert.match(migration, /next_attempt_at TIMESTAMPTZ/u);
  assert.match(migration, /iana_time_zone TEXT/u);
  assert.match(migration, /utc_offset INTEGER NOT NULL/u);
  assert.match(migration, /\(user_id, civil_date DESC\)/u);
  assert.match(migration, /health_sync_cursors_due_idx[\s\S]*next_attempt_at/u);
  assert.match(migration, /zones JSONB NOT NULL/u);
  assert.match(migration, /evidence JSONB NOT NULL/u);
  assert.doesNotMatch(migration, /CREATE TABLE heart_rate_samples/u);
  assert.doesNotMatch(migration, /raw_heart_rate/u);
});

test('upserts minutes on (user, source family, UTC minute) and never persists raw samples', async () => {
  const pool = new RecordingPool();
  const store = createPostgresStoreForTesting(pool);

  await store.healthMetrics.upsertMinutes([minute()]);

  const insert = pool.queries.find((query) => /INSERT INTO heart_rate_minute_aggregates/u.test(query.text));
  assert.ok(insert);
  assert.match(insert?.text ?? '', /ON CONFLICT \(user_id, source_family, minute_start_utc\)/u);
  assert.equal(insert?.values?.[0], userId);
  assert.equal(insert?.values?.[1], 'google-wearables');
  assert.equal((insert?.values?.[2] as Date).toISOString(), '2026-08-22T12:00:00.000Z');
  assert.equal(healthMetricsExposesRawSamplePersistence(store.healthMetrics), false);
  assert.equal(pool.queries.some((query) => /heart_rate_samples|raw_heart_rate/u.test(query.text)), false);
});

test('upserts activity-level intervals on interval start and replaces zones by local date using JSONB thresholds', async () => {
  const pool = new RecordingPool();
  const store = createPostgresStoreForTesting(pool);

  await store.healthMetrics.upsertActivityLevelIntervals([{
    userId,
    sourceFamily: 'google-wearables',
    startTime: '2026-08-22T12:00:00.000Z',
    endTime: '2026-08-22T12:01:00.000Z',
    activityLevelType: 'LIGHTLY_ACTIVE',
  }]);
  await store.healthMetrics.replaceHeartRateZones(parseDailyHeartRateZones({
    userId,
    sourceFamily: 'google-wearables',
    date: civilDate,
    zones,
  }));

  const activityInsert = pool.queries.find((query) => /INSERT INTO activity_level_intervals/u.test(query.text));
  const zoneInsert = pool.queries.find((query) => /INSERT INTO daily_heart_rate_zones/u.test(query.text));
  assert.match(activityInsert?.text ?? '', /ON CONFLICT \(user_id, source_family, interval_start_utc\)/u);
  assert.match(zoneInsert?.text ?? '', /ON CONFLICT \(user_id, source_family, civil_date\)/u);
  assert.match(zoneInsert?.text ?? '', /\$4::jsonb/u);
  assert.match(String(zoneInsert?.values?.[3]), /"PEAK"/u);
});

test('ingestWindow writes aggregates, daily rows, results, and the data-type cursor in one transaction', async () => {
  const pool = new RecordingPool();
  const store = createPostgresStoreForTesting(pool);

  await store.healthMetrics.ingestWindow({
    userId,
    connectionId,
    dataType: 'heart-rate',
    minutes: [minute()],
    dailyCardio: [parseDailyCardio({
      userId,
      date: civilDate,
      status: 'complete',
      strain: 8.4,
      dose: 70,
      zoneMinutes: { light: 12, moderate: 8, vigorous: 4, peak: 0 },
      knownContextMinutes: 600,
      rawCoverageMinutes: 610,
      attributedMinutes: 24,
      metricVersion: WHOOP_STYLE_METRIC_VERSION,
    })],
    metricResults: [metric()],
    cursor: {
      successfulWatermark: now,
      lastErrorCode: undefined,
      retryCount: 0,
      nextAttemptAt: undefined,
    },
  });

  assert.equal(pool.queries[0]?.text, 'BEGIN');
  assert.equal(pool.queries.at(-1)?.text, 'COMMIT');
  assert.equal(pool.queries.some((query) => /INSERT INTO heart_rate_minute_aggregates/u.test(query.text)), true);
  assert.equal(pool.queries.some((query) => /INSERT INTO daily_cardio/u.test(query.text)), true);
  const resultInsert = pool.queries.find((query) => /INSERT INTO metric_results/u.test(query.text));
  assert.match(resultInsert?.text ?? '', /evidence, source, coverage/u);
  assert.match(resultInsert?.text ?? '', /::jsonb/u);
  const cursorInsert = pool.queries.find((query) => /INSERT INTO health_sync_cursors/u.test(query.text));
  assert.match(cursorInsert?.text ?? '', /ON CONFLICT \(connection_id, data_type\)/u);
  assert.equal(cursorInsert?.values?.[0], connectionId);
  assert.equal(cursorInsert?.values?.[1], 'heart-rate');
  assert.equal((cursorInsert?.values?.[2] as Date).toISOString(), now.toISOString());
});

test('rolls the ingest window back when a later metric write fails', async () => {
  const pool = new RecordingPool([
    { rows: [] },
    { rows: [] },
    new Error('metric_results write failed'),
    { rows: [] },
  ]);
  const store = createPostgresStoreForTesting(pool);

  await assert.rejects(store.healthMetrics.ingestWindow({
    userId,
    connectionId,
    dataType: 'heart-rate',
    minutes: [minute()],
    metricResults: [metric()],
    cursor: { successfulWatermark: now, lastErrorCode: undefined, retryCount: 0, nextAttemptAt: undefined },
  }), /metric_results write failed/u);

  assert.equal(pool.queries[0]?.text, 'BEGIN');
  assert.equal(pool.queries.at(-1)?.text, 'ROLLBACK');
});

test('looks up historical sleep goals and due cursors with user/date predicates', async () => {
  const pool = new RecordingPool([
    { rows: [{ user_id: userId, goal_minutes: 480, effective_civil_date: '2026-08-23' }] },
    { rows: [{
      connection_id: connectionId,
      data_type: 'heart-rate',
      successful_watermark: now,
      last_error_code: 'rate_limited',
      retry_count: 1,
      next_attempt_at: new Date('2026-08-22T16:30:00.000Z'),
    }] },
  ]);
  const store = createPostgresStoreForTesting(pool);

  const goal = await store.healthMetrics.lookupSleepGoal({ userId, civilDate: '2026-08-24' });
  const due = await store.healthMetrics.listDueCursors({ now: new Date('2026-08-22T16:30:00.000Z'), connectionId });

  assert.equal(goal?.goalMinutes, 480);
  assert.match(pool.queries[0]?.text ?? '', /FROM user_sleep_goal_history/u);
  assert.match(pool.queries[0]?.text ?? '', /effective_civil_date <= \$2/u);
  assert.deepEqual(pool.queries[0]?.values?.slice(0, 2), [userId, '2026-08-24']);
  assert.equal(due[0]?.lastErrorCode, 'rate_limited');
  assert.match(pool.queries[1]?.text ?? '', /FROM health_sync_cursors/u);
  assert.match(pool.queries[1]?.text ?? '', /next_attempt_at <= \$1/u);
});

test('range-updates minute local associations and maps JSONB metric results', async () => {
  const pool = new RecordingPool([
    { rows: [] },
    { rows: [{ user_id: userId }], rowCount: 1 },
    { rows: [{
      user_id: userId,
      civil_date: civilDate,
      metric_name: 'strain',
      metric_version: WHOOP_STYLE_METRIC_VERSION,
      score: 8.4,
      status: 'complete',
      quality: null,
      reason: null,
      evidence: [{ label: 'dose', date: civilDate, value: 70 }],
      source: {
        heartRateZones: true, activityLevel: true, exercise: false, sleep: false, hrv: false, rhr: false, sleepGoal: false, timeZone: 'missing',
      },
      coverage: {
        knownContextMinutes: 600, rawHeartRateMinutes: 610, attributedMinutes: 24, lastKnownContextAt: '2026-08-22T15:50:00.000Z',
      },
    }] },
  ]);
  const store = createPostgresStoreForTesting(pool);

  await store.healthMetrics.listMinutesInRange({
    userId,
    fromUtc: '2026-08-21T00:00:00.000Z',
    toUtcExclusive: '2026-08-22T00:00:00.000Z',
  });
  const updated = await store.healthMetrics.updateMinuteLocalAssociation({
    userId,
    sourceFamily: 'google-wearables',
    minuteStartUtc: '2026-08-21T16:00:00.000Z',
    civilDate,
    ianaTimeZone: 'Asia/Shanghai',
    localMinuteOfDay: 0,
  });
  const result = await store.healthMetrics.getMetricResult({ userId, civilDate, metricName: 'strain' });

  assert.match(pool.queries[0]?.text ?? '', /FROM heart_rate_minute_aggregates/u);
  assert.match(pool.queries[0]?.text ?? '', /minute_start_utc >= \$2/u);
  assert.match(pool.queries[1]?.text ?? '', /UPDATE heart_rate_minute_aggregates/u);
  assert.match(pool.queries[1]?.text ?? '', /iana_time_zone = \$5/u);
  assert.equal(updated, true);
  assert.equal(result?.score, 8.4);
  assert.equal(result?.evidence[0]?.label, 'dose');
});

test('deleteForUser removes every whoop-style metric table for that user inside a transaction', async () => {
  const pool = new RecordingPool();
  const store = createPostgresStoreForTesting(pool);

  await store.healthMetrics.deleteForUser(userId);

  const texts = pool.queries.map((query) => query.text).join('\n');
  assert.equal(pool.queries[0]?.text, 'BEGIN');
  assert.equal(pool.queries.at(-1)?.text, 'COMMIT');
  for (const table of [
    'heart_rate_minute_aggregates',
    'activity_level_intervals',
    'daily_heart_rate_zones',
    'daily_time_in_zone',
    'exercise_intervals',
    'daily_cardio',
    'metric_results',
    'health_sync_cursors',
    'user_sleep_goal_history',
    'user_health_time_zone_history',
  ]) {
    assert.match(texts, new RegExp(`DELETE FROM ${table}`, 'u'));
  }
  assert.match(texts, /google_health_connections WHERE user_id = \$1/u);
  for (const query of pool.queries.filter((item) => item.text.startsWith('DELETE'))) {
    assert.equal(query.values?.[0], userId);
  }
});

test('maps a unique sleep-goal insert collision to SleepGoalConflictError', async () => {
  const error = Object.assign(new Error('duplicate key'), { code: '23505' });
  const pool = new RecordingPool([error]);
  const store = createPostgresStoreForTesting(pool);

  await assert.rejects(store.healthMetrics.insertSleepGoal(parseSleepGoal({
    userId,
    goalMinutes: 480,
    effectiveCivilDate: '2026-08-23',
  })), SleepGoalConflictError);
});
