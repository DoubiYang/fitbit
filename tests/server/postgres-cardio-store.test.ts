import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
  HealthMetricsConnectionMismatchError,
  mapDailyCardioRow,
  mapMetricResultRow,
  SleepGoalConflictError,
} from '../../src/server/health/cardio-store';

type Query = { text: string; values: unknown[] | undefined };
type QueryResponse = { rows: Array<Record<string, unknown>>; rowCount?: number } | Error;

const userId = '11111111-1111-1111-1111-111111111111';
const connectionId = '22222222-2222-2222-2222-222222222222';
const civilDate = '2026-08-22';
const now = new Date('2026-08-22T16:00:00.000Z');
const migration = readFileSync(new URL('../../db/migrations/010_whoop_style_metrics.sql', import.meta.url), 'utf8');
const provenanceMigrationPath = new URL('../../db/migrations/013_homepage_strain_provenance.sql', import.meta.url);
const provenanceMigration = existsSync(provenanceMigrationPath) ? readFileSync(provenanceMigrationPath, 'utf8') : '';

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

function minuteRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: userId,
    source_family: 'google-wearables',
    minute_start_utc: '2026-08-22T12:00:00.000Z',
    civil_date: civilDate,
    utc_offset: 480,
    iana_time_zone: 'Asia/Shanghai',
    local_minute_of_day: 0,
    avg_bpm: 100,
    min_bpm: 100,
    max_bpm: 100,
    sample_count: 8,
    coverage_seconds: 60,
    activity_level: 'LIGHTLY_ACTIVE',
    ...overrides,
  };
}

function connectionOwnerResponse(ownerUserId = userId): QueryResponse {
  return { rows: [{ user_id: ownerUserId }] };
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

test('migration 013 preserves legacy rows while constraining version 1 homepage strain provenance', () => {
  assert.match(provenanceMigration, /ALTER TABLE daily_cardio[\s\S]*?ADD COLUMN provenance_version SMALLINT/u);
  assert.match(provenanceMigration, /ALTER TABLE metric_results[\s\S]*?ADD COLUMN provenance_version SMALLINT/u);
  assert.match(provenanceMigration, /input_fingerprint TEXT/u);
  assert.match(provenanceMigration, /calculation_context JSONB/u);
  assert.match(provenanceMigration, /quality_flags TEXT\[\] NOT NULL DEFAULT '\{\}'/u);
  assert.match(provenanceMigration, /provenance_version = 1/u);
  assert.match(provenanceMigration, /input_fingerprint IS NOT NULL/u);
  assert.match(provenanceMigration, /input_fingerprint ~ '\^sha256:\[a-f0-9\]\{64\}\$'/u);
  assert.match(provenanceMigration, /calculation_context IS NOT NULL/u);
  assert.match(provenanceMigration, /jsonb_typeof\(calculation_context\) = 'object'/u);
  assert.match(provenanceMigration, /provenance_version IS NULL[\s\S]*?input_fingerprint IS NULL[\s\S]*?calculation_context IS NULL/u);
  assert.doesNotMatch(provenanceMigration, /metric_version.*provenance_version|provenance_version.*metric_version/u);
});

test('postgres health metrics persistence maps legacy null provenance and parameterizes verified provenance writes', async () => {
  const fingerprint = `sha256:${'a'.repeat(64)}`;
  const provenance = {
    provenanceVersion: 1,
    inputFingerprint: fingerprint,
    calculationContext: { dayBoundary: 'Asia/Shanghai' },
  };
  const daily = parseDailyCardio({
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
    provenance,
  });
  const result = parseMetricResult({
    ...metric(),
    provenance,
    qualityFlags: ['sleep_history_incomplete'],
  });
  const pool = new RecordingPool();
  const store = createPostgresStoreForTesting(pool);

  await store.healthMetrics.upsertDailyCardio(daily);
  await store.healthMetrics.upsertMetricResult(result);

  const dailyInsert = pool.queries.find((query) => /INSERT INTO daily_cardio/u.test(query.text));
  const metricInsert = pool.queries.find((query) => /INSERT INTO metric_results/u.test(query.text));
  assert.match(dailyInsert?.text ?? '', /provenance_version, input_fingerprint, calculation_context/u);
  assert.match(dailyInsert?.text ?? '', /\$14,\$15,\$16::jsonb/u);
  assert.deepEqual(dailyInsert?.values?.slice(-3), [1, fingerprint, JSON.stringify(provenance.calculationContext)]);
  assert.match(metricInsert?.text ?? '', /provenance_version, input_fingerprint, calculation_context, quality_flags/u);
  assert.match(metricInsert?.text ?? '', /\$12,\$13,\$14::jsonb,\$15::text\[\]/u);
  assert.deepEqual(metricInsert?.values?.slice(-4), [1, fingerprint, JSON.stringify(provenance.calculationContext), ['sleep_history_incomplete']]);

  const legacyDaily = mapDailyCardioRow({
    user_id: userId,
    civil_date: civilDate,
    status: 'complete',
    strain: 8.4,
    dose: 70,
    light_minutes: 12,
    moderate_minutes: 8,
    vigorous_minutes: 4,
    peak_minutes: 0,
    known_context_minutes: 600,
    raw_coverage_minutes: 610,
    attributed_minutes: 24,
    metric_version: WHOOP_STYLE_METRIC_VERSION,
    provenance_version: null,
    input_fingerprint: null,
    calculation_context: null,
  });
  const legacyMetric = mapMetricResultRow({
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
    provenance_version: null,
    input_fingerprint: null,
    calculation_context: null,
    quality_flags: null,
  });
  assert.equal(legacyDaily.provenance, undefined);
  assert.equal(legacyMetric.provenance, undefined);
  assert.deepEqual(legacyMetric.qualityFlags, []);
});

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
  assert.match(
    migration,
    /CREATE UNIQUE INDEX user_health_time_zone_history_backfill_anchor_uidx[\s\S]*?\(user_id\)[\s\S]*?WHERE is_backfill_anchor/u,
  );
  assert.doesNotMatch(migration, /CREATE TABLE heart_rate_samples/u);
  assert.doesNotMatch(migration, /raw_heart_rate/u);
});

test('upserts minutes on (user, source family, UTC minute) and never persists raw samples', async () => {
  const pool = new RecordingPool();
  const store = createPostgresStoreForTesting(pool);

  await store.healthMetrics.upsertMinutes([minute()]);

  const insert = pool.queries.find((query) => /INSERT INTO heart_rate_minute_aggregates/u.test(query.text));
  assert.ok(insert);
  assert.match(insert?.text ?? '', /jsonb_to_recordset\(\$1::jsonb\)/u);
  assert.equal(insert?.values?.length, 1);
  const inserted = JSON.parse(String(insert?.values?.[0]));
  assert.equal(inserted[0]?.user_id, userId);
  assert.equal(inserted[0]?.source_family, 'google-wearables');
  assert.equal(inserted[0]?.minute_start_utc, '2026-08-22T12:00:00.000Z');
  assert.match(insert?.text ?? '', /ON CONFLICT \(user_id, source_family, minute_start_utc\)/u);
  assert.equal(healthMetricsExposesRawSamplePersistence(store.healthMetrics), false);
  assert.equal(pool.queries.some((query) => /heart_rate_samples|raw_heart_rate/u.test(query.text)), false);
});

test('upsertMinutes preserves stored IANA when incoming IANA is null and utc offset is unchanged', async () => {
  const pool = new RecordingPool([{ rows: [minuteRow()] }]);
  const store = createPostgresStoreForTesting(pool);

  await store.healthMetrics.upsertMinutes([minute()]);

  const select = pool.queries.find((query) => (
    /FROM heart_rate_minute_aggregates/u.test(query.text) && /JOIN keys/u.test(query.text)
  ));
  const insert = pool.queries.find((query) => /INSERT INTO heart_rate_minute_aggregates/u.test(query.text));
  assert.ok(select);
  assert.match(select?.text ?? '', /jsonb_to_recordset\(\$1::jsonb\)/u);
  assert.equal(select?.values?.length, 1);
  assert.ok(insert);
  assert.match(insert?.text ?? '', /jsonb_to_recordset\(\$1::jsonb\)/u);
  assert.equal(insert?.values?.length, 1);
  assert.match(insert?.text ?? '', /ON CONFLICT \(user_id, source_family, minute_start_utc\)/u);
  const inserted = JSON.parse(String(insert?.values?.[0]));
  assert.equal(inserted[0]?.civil_date, civilDate);
  assert.equal(inserted[0]?.utc_offset, 480);
  assert.equal(inserted[0]?.iana_time_zone, 'Asia/Shanghai');
  assert.equal(inserted[0]?.local_minute_of_day, 0);
  assert.equal(inserted[0]?.avg_bpm, 110);
});

test('batches a 10,000-minute page into one matching read and one single-JSON upsert', async () => {
  const pool = new RecordingPool([{ rows: [] }]);
  const store = createPostgresStoreForTesting(pool);
  const start = Date.parse('2026-08-01T00:00:00.000Z');
  const page = Array.from({ length: 10_000 }, (_, index) => parseHeartRateMinuteAggregate({
    ...minute(),
    minuteStartUtc: new Date(start + index * 60_000).toISOString(),
    localMinuteOfDay: index % 1_440,
  }));

  await store.healthMetrics.upsertMinutes(page);

  const matchingReads = pool.queries.filter((query) => (
    /FROM heart_rate_minute_aggregates/u.test(query.text) && /jsonb_to_recordset\(\$1::jsonb\)/u.test(query.text)
  ));
  const upserts = pool.queries.filter((query) => /INSERT INTO heart_rate_minute_aggregates/u.test(query.text));
  assert.equal(matchingReads.length, 1);
  assert.equal(upserts.length, 1);
  for (const query of [...matchingReads, ...upserts]) {
    assert.equal(query.values?.length, 1);
    assert.match(query.text, /jsonb_to_recordset\(\$1::jsonb\)/u);
    assert.doesNotMatch(query.text, /\bVALUES\s*\(/u);
  }
  assert.equal(JSON.parse(String(upserts[0]?.values?.[0])).length, 10_000);
});

test('merges repeated minute keys in arrival order from the stored row', async () => {
  const pool = new RecordingPool([{ rows: [minuteRow({
    utc_offset: 0,
    iana_time_zone: 'UTC',
    local_minute_of_day: 720,
  })] }]);
  const store = createPostgresStoreForTesting(pool);
  const repeated = (utcOffsetMinutes: number) => parseHeartRateMinuteAggregate({
    ...minute(),
    utcOffsetMinutes,
    ianaTimeZone: null,
    localMinuteOfDay: 720 + utcOffsetMinutes,
  });

  await store.healthMetrics.upsertMinutes([repeated(0), repeated(60), repeated(0)]);

  const upserts = pool.queries.filter((query) => /INSERT INTO heart_rate_minute_aggregates/u.test(query.text));
  assert.equal(upserts.length, 1);
  const finalRows = JSON.parse(String(upserts[0]?.values?.[0]));
  assert.equal(finalRows.length, 1);
  assert.equal(finalRows[0]?.iana_time_zone, null);
  assert.equal(finalRows[0]?.utc_offset, 0);
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
  assert.match(activityInsert?.text ?? '', /jsonb_to_recordset\(\$1::jsonb\)/u);
  assert.equal(activityInsert?.values?.length, 1);
  assert.match(activityInsert?.text ?? '', /ON CONFLICT \(user_id, source_family, interval_start_utc\)/u);
  assert.match(zoneInsert?.text ?? '', /ON CONFLICT \(user_id, source_family, civil_date\)/u);
  assert.match(zoneInsert?.text ?? '', /\$4::jsonb/u);
  assert.match(String(zoneInsert?.values?.[3]), /"PEAK"/u);
});

test('ingestWindow writes aggregates, daily rows, results, and the data-type cursor in one transaction', async () => {
  const pool = new RecordingPool([
    { rows: [] },
    connectionOwnerResponse(),
  ]);
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
  const owner = pool.queries.find((query) => /FROM google_health_connections/u.test(query.text));
  assert.ok(owner);
  assert.match(owner?.text ?? '', /SELECT user_id FROM google_health_connections WHERE id = \$1/u);
  assert.equal(owner?.values?.[0], connectionId);
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
    connectionOwnerResponse(),
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

test('ingestWindow rolls back when the connection does not belong to the window user', async () => {
  const pool = new RecordingPool([
    { rows: [] },
    { rows: [] },
    { rows: [] },
  ]);
  const store = createPostgresStoreForTesting(pool);

  await assert.rejects(store.healthMetrics.ingestWindow({
    userId,
    connectionId,
    dataType: 'heart-rate',
    minutes: [minute()],
    cursor: { successfulWatermark: now, lastErrorCode: undefined, retryCount: 0, nextAttemptAt: undefined },
  }), HealthMetricsConnectionMismatchError);

  assert.equal(pool.queries[0]?.text, 'BEGIN');
  assert.equal(pool.queries.at(-1)?.text, 'ROLLBACK');
  assert.equal(pool.queries.some((query) => /INSERT INTO heart_rate_minute_aggregates/u.test(query.text)), false);
  assert.equal(pool.queries.some((query) => /INSERT INTO health_sync_cursors/u.test(query.text)), false);

  const wrongOwner = new RecordingPool([
    { rows: [] },
    connectionOwnerResponse('33333333-3333-3333-3333-333333333333'),
    { rows: [] },
  ]);
  const wrongOwnerStore = createPostgresStoreForTesting(wrongOwner);
  await assert.rejects(wrongOwnerStore.healthMetrics.ingestWindow({
    userId,
    connectionId,
    dataType: 'heart-rate',
    minutes: [minute()],
    cursor: { successfulWatermark: now, lastErrorCode: undefined, retryCount: 0, nextAttemptAt: undefined },
  }), HealthMetricsConnectionMismatchError);
  assert.equal(wrongOwner.queries.at(-1)?.text, 'ROLLBACK');
  assert.equal(wrongOwner.queries.some((query) => /INSERT INTO health_sync_cursors/u.test(query.text)), false);
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
    { rows: [minuteRow({ iana_time_zone: null, local_minute_of_day: 1200 })] },
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
  const selectExisting = pool.queries.find((query) => (
    /SELECT \* FROM heart_rate_minute_aggregates/u.test(query.text)
    && /minute_start_utc = \$3/u.test(query.text)
  ));
  const update = pool.queries.find((query) => /UPDATE heart_rate_minute_aggregates/u.test(query.text));
  assert.ok(selectExisting);
  assert.ok(update);
  assert.match(update?.text ?? '', /iana_time_zone = \$5/u);
  assert.doesNotMatch(update?.text ?? '', /utc_offset/u);
  assert.equal(updated, true);
  assert.equal(result?.score, 8.4);
  assert.equal(result?.evidence[0]?.label, 'dose');
});

test('scheduleCursor leaves successful_watermark untouched and rejects invalid retryCount before querying', async () => {
  const pool = new RecordingPool();
  const store = createPostgresStoreForTesting(pool);
  const retryAt = new Date('2026-08-22T16:30:00.000Z');

  await store.healthMetrics.scheduleCursor({
    connectionId,
    dataType: 'heart-rate',
    lastErrorCode: 'rate_limited',
    retryCount: 1,
    nextAttemptAt: retryAt,
  });

  const insert = pool.queries.find((query) => /INSERT INTO health_sync_cursors/u.test(query.text));
  assert.ok(insert);
  assert.doesNotMatch(insert?.text ?? '', /successful_watermark/u);
  assert.match(insert?.text ?? '', /ON CONFLICT \(connection_id, data_type\)/u);

  const beforeInvalid = pool.queries.length;
  await assert.rejects(store.healthMetrics.scheduleCursor({
    connectionId,
    dataType: 'heart-rate',
    lastErrorCode: 'rate_limited',
    retryCount: -1,
    nextAttemptAt: retryAt,
  }));
  assert.equal(pool.queries.length, beforeInvalid);
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
