import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { BodyAgeEstimate } from '../../src/domain/body-age';
import { createMemoryStore } from '../../src/server/db/memory-store';
import { createPostgresStoreForTesting } from '../../src/server/db/postgres-store';
import { normalizeDailyVo2Writes } from '../../src/server/health/cardio-store';

type Query = { text: string; values: unknown[] | undefined };
type QueryResponse = { rows: Array<Record<string, unknown>>; rowCount?: number } | Error;

const userId = '11111111-1111-1111-1111-111111111111';
const otherUserId = '33333333-3333-3333-3333-333333333333';
const migration = readFileSync(new URL('../../db/migrations/012_body_age_air_cn_v1.sql', import.meta.url), 'utf8');

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

function dailyVo2(civilDate: string, overrides: Partial<{
  vo2Max: number;
  receivedAt: string;
  revision: number;
  estimated: boolean;
}> = {}) {
  return {
    userId,
    civilDate,
    vo2Max: 42,
    sourceFamily: 'google-wearables',
    receivedAt: '2026-08-22T16:00:00.000Z',
    revision: 1,
    estimated: false,
    ...overrides,
  };
}

function estimate(overrides: Partial<BodyAgeEstimate> = {}): BodyAgeEstimate {
  return {
    age: 39,
    coverageDays: 14,
    latestInputCivilDate: '2026-08-22',
    route: 'daily_vo2',
    status: 'daily_vo2_provisional',
    referenceVersion: 'chinese-community-cycle-vo2peak-p50-v1',
    disclaimer: 'non_medical_non_calibrated_estimate',
    dataGaps: {
      dailyVo2DaysNeeded: 0,
      rhrDaysNeeded: 0,
      observedHrPeakRequired: false,
    },
    ...overrides,
  };
}

function resultWrite(overrides: Record<string, unknown> = {}) {
  return {
    userId,
    algorithmVersion: 'air-cn-v1',
    estimate: estimate(),
    lastCalculatedCivilDate: '2026-08-22',
    referenceHash: 'sha256:reference',
    inputFingerprint: 'sha256:inputs',
    profileRevision: 3,
    chronologicalAgeDeltaYears: -2,
    windowDays: 28,
    exclusionCounts: {
      invalidDailyVo2: 0,
      futureDailyVo2: 0,
      untrustedDailyVo2: 0,
      invalidDailyRhr: 0,
      futureDailyRhr: 0,
      untrustedDailyRhr: 0,
    },
    computedAt: '2026-08-22T16:01:00.000Z',
    ...overrides,
  };
}

test('migration 012 safely extends cursors and creates constrained body-age persistence without raw provider payloads', () => {
  assert.match(migration, /ALTER TABLE health_sync_cursors[\s\S]*DROP CONSTRAINT(?: IF EXISTS)? health_sync_cursors_data_type_check/u);
  assert.match(migration, /ADD CONSTRAINT health_sync_cursors_data_type_check[\s\S]*'daily-vo2-max'/u);
  assert.match(migration, /CREATE TABLE user_body_age_profiles[\s\S]*REFERENCES users \(id\) ON DELETE CASCADE/u);
  assert.match(migration, /birth_date DATE/u);
  assert.match(migration, /reference_sex TEXT[\s\S]*'male'[\s\S]*'female'/u);
  assert.match(migration, /historical_observed_hr_peak_bpm(?: DOUBLE PRECISION)?[\s\S]*BETWEEN 100 AND 230/u);
  assert.match(migration, /profile_revision INTEGER NOT NULL DEFAULT 0[\s\S]*profile_revision >= 0/u);
  assert.match(migration, /CREATE TABLE air_daily_vo2[\s\S]*PRIMARY KEY \(user_id, civil_date\)/u);
  assert.match(migration, /source_family TEXT NOT NULL CHECK \(source_family = 'google-wearables'\)/u);
  const rejectedFloatSpecials = /NOT IN \('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision\)/u;
  assert.match(migration, new RegExp(`historical_observed_hr_peak_bpm DOUBLE PRECISION CHECK \\([\\s\\S]*?${rejectedFloatSpecials.source}`, 'u'));
  assert.match(migration, new RegExp(`vo2_max DOUBLE PRECISION NOT NULL CHECK \\([\\s\\S]*?${rejectedFloatSpecials.source}`, 'u'));
  assert.match(migration, new RegExp(`chronological_age_delta_years DOUBLE PRECISION CHECK \\([\\s\\S]*?${rejectedFloatSpecials.source}`, 'u'));
  assert.doesNotMatch(migration, /\bisfinite\s*\(/u);
  assert.doesNotMatch(migration, /vo2_max[^\n]*<= 100/u);
  assert.match(migration, /CREATE TABLE body_age_results[\s\S]*PRIMARY KEY \(user_id, algorithm_version\)/u);
  assert.match(migration, /last_calculated_civil_date DATE NOT NULL/u);
  assert.match(migration, /input_fingerprint TEXT NOT NULL/u);
  assert.match(migration, /data_gaps JSONB NOT NULL/u);
  assert.match(migration, /window_days INTEGER NOT NULL CHECK \(window_days > 0\)/u);
  assert.match(migration, /exclusion_counts JSONB NOT NULL/u);
  assert.match(migration, /status IN \('daily_vo2_provisional', 'daily_vo2_stable'\)[\s\S]*route IS NOT DISTINCT FROM 'daily_vo2'/u);
  assert.match(migration, /status = 'observed_peak_ratio_provisional'[\s\S]*route IS NOT DISTINCT FROM 'observed_peak_ratio'/u);
  assert.match(migration, /status = 'stale'[\s\S]*route IS NOT NULL AND route IN \('daily_vo2', 'observed_peak_ratio'\)/u);
  assert.doesNotMatch(migration, /DROP TABLE|TRUNCATE|google_record_id|source_record_id|payload/iu);
});

test('Postgres profile and observed peak writes preserve profile revision boundaries', async () => {
  const pool = new RecordingPool([
    { rows: [{
      user_id: userId,
      birth_date: '1988-04-20',
      reference_sex: 'female',
      historical_observed_hr_peak_bpm: null,
      first_observed_hr_peak_at: null,
      latest_observed_hr_peak_at: null,
      profile_revision: 1,
    }] },
    { rows: [{
      user_id: userId,
      birth_date: '1988-04-20',
      reference_sex: 'female',
      historical_observed_hr_peak_bpm: 181,
      first_observed_hr_peak_at: '2026-08-22T12:00:00.000Z',
      latest_observed_hr_peak_at: '2026-08-22T12:00:00.000Z',
      profile_revision: 1,
    }] },
    { rows: [{
      user_id: userId,
      birth_date: '1988-04-20',
      reference_sex: 'female',
      historical_observed_hr_peak_bpm: 181,
      first_observed_hr_peak_at: '2026-08-22T12:00:00.000Z',
      latest_observed_hr_peak_at: '2026-08-22T12:00:00.000Z',
      profile_revision: 1,
    }] },
  ]);
  const store = createPostgresStoreForTesting(pool);

  await store.healthMetrics.updateBodyAgeProfile({
    userId,
    birthDate: '1988-04-20',
    referenceSex: 'female',
  });
  await store.healthMetrics.recordObservedHrPeak({
    userId,
    observedHrPeakBpm: 181,
    observedAt: '2026-08-22T12:00:00.000Z',
  });
  const unchanged = await store.healthMetrics.updateBodyAgeProfile({
    userId,
    birthDate: '1988-04-20',
    referenceSex: 'female',
  });

  const profileWrites = pool.queries.filter((query) => /INSERT INTO user_body_age_profiles \(user_id, birth_date, reference_sex/u.test(query.text));
  const profile = profileWrites[0];
  const noOpProfile = profileWrites[1];
  const observed = pool.queries.find((query) => /historical_observed_hr_peak_bpm/u.test(query.text) && /GREATEST/u.test(query.text));
  assert.ok(profile);
  assert.match(profile?.text ?? '', /profile_revision = CASE WHEN/u);
  assert.match(noOpProfile?.text ?? '', /birth_date IS DISTINCT FROM EXCLUDED\.birth_date/u);
  assert.match(noOpProfile?.text ?? '', /reference_sex IS DISTINCT FROM EXCLUDED\.reference_sex/u);
  assert.match(noOpProfile?.text ?? '', /updated_at = CASE WHEN/u);
  assert.equal(unchanged.profileRevision, 1);
  assert.ok(observed);
  assert.match(observed?.text ?? '', /GREATEST\(\s*user_body_age_profiles\.historical_observed_hr_peak_bpm/u);
  assert.doesNotMatch(observed?.text ?? '', /profile_revision\s*=/u);
});

test('first empty body-age profile starts at revision zero before a settings change increments it', async () => {
  const row = (profileRevision: number, birthDate: string | null, referenceSex: 'female' | null) => ({
    user_id: userId,
    birth_date: birthDate,
    reference_sex: referenceSex,
    historical_observed_hr_peak_bpm: null,
    first_observed_hr_peak_at: null,
    latest_observed_hr_peak_at: null,
    profile_revision: profileRevision,
  });
  const pool = new RecordingPool([
    { rows: [row(0, null, null)] },
    { rows: [row(1, '1988-04-20', 'female')] },
  ]);
  const postgres = createPostgresStoreForTesting(pool);
  const memory = createMemoryStore();

  const postgresEmpty = await postgres.healthMetrics.updateBodyAgeProfile({ userId, birthDate: null, referenceSex: null });
  const postgresConfigured = await postgres.healthMetrics.updateBodyAgeProfile({
    userId,
    birthDate: '1988-04-20',
    referenceSex: 'female',
  });
  const memoryEmpty = await memory.healthMetrics.updateBodyAgeProfile({ userId, birthDate: null, referenceSex: null });
  const memoryConfigured = await memory.healthMetrics.updateBodyAgeProfile({
    userId,
    birthDate: '1988-04-20',
    referenceSex: 'female',
  });

  const insert = pool.queries.find((query) => /INSERT INTO user_body_age_profiles/u.test(query.text));
  assert.match(insert?.text ?? '', /CASE WHEN \$2::date IS NULL AND \$3::text IS NULL THEN 0 ELSE 1 END/u);
  assert.equal(postgresEmpty.profileRevision, 0);
  assert.equal(memoryEmpty.profileRevision, 0);
  assert.equal(postgresConfigured.profileRevision, 1);
  assert.equal(memoryConfigured.profileRevision, 1);
});

test('daily VO2 normalization ignores conflicting lower-priority revisions in either arrival order', () => {
  const lowerFirst = dailyVo2('2026-08-22', { vo2Max: 40, receivedAt: '2026-08-22T08:00:00.000Z', revision: 1 });
  const lowerConflict = dailyVo2('2026-08-22', { vo2Max: 41, receivedAt: '2026-08-22T08:00:00.000Z', revision: 1 });
  const highest = dailyVo2('2026-08-22', { vo2Max: 44, receivedAt: '2026-08-22T09:00:00.000Z', revision: 0 });

  for (const rows of [
    [lowerFirst, lowerConflict, highest],
    [highest, lowerConflict, lowerFirst],
  ]) {
    assert.deepEqual(normalizeDailyVo2Writes(rows).map((row) => ({
      civilDate: row.civilDate,
      vo2Max: row.vo2Max,
      receivedAt: row.receivedAt,
      revision: row.revision,
    })), [{
      civilDate: '2026-08-22',
      vo2Max: 44,
      receivedAt: '2026-08-22T09:00:00.000Z',
      revision: 0,
    }]);
  }
});

test('daily VO2 storage ingress requires an RFC3339 receipt instant with a valid clock and offset', async () => {
  const store = createMemoryStore();
  for (const receivedAt of [
    '2026-08-22T12:00:00',
    '2026-08-22T24:00:00Z',
    '2026-08-22T12:60:00Z',
    '2026-08-22T12:00:60+08:00',
  ]) {
    await assert.rejects(
      store.healthMetrics.upsertDailyVo2([dailyVo2('2026-08-22', { receivedAt })]),
      /invalid daily VO2 receivedAt/u,
    );
  }
});

test('Postgres daily VO2 writes are revision-aware and authoritative replacement deletes only absent window dates', async () => {
  const pool = new RecordingPool();
  const store = createPostgresStoreForTesting(pool);

  await store.healthMetrics.upsertDailyVo2([
    dailyVo2('2026-08-21'),
    dailyVo2('2026-08-22', { vo2Max: 43, revision: 2 }),
  ]);
  await store.healthMetrics.authoritativelyReplaceDailyVo2({
    userId,
    fromCivilDate: '2026-08-20',
    toCivilDate: '2026-08-22',
    rows: [dailyVo2('2026-08-22', { vo2Max: 44, revision: 3 })],
  });

  const inserts = pool.queries.filter((query) => /INSERT INTO air_daily_vo2/u.test(query.text));
  const deletion = pool.queries.find((query) => /DELETE FROM air_daily_vo2/u.test(query.text));
  assert.equal(inserts.length, 2);
  assert.match(inserts[0]?.text ?? '', /ON CONFLICT \(user_id, civil_date\) DO UPDATE/u);
  assert.match(inserts[0]?.text ?? '', /EXCLUDED\.received_at > air_daily_vo2\.received_at/u);
  assert.match(inserts[0]?.text ?? '', /EXCLUDED\.revision > air_daily_vo2\.revision/u);
  assert.ok(deletion);
  assert.match(deletion?.text ?? '', /civil_date >= \$2 AND civil_date <= \$3/u);
  assert.match(deletion?.text ?? '', /NOT \(civil_date = ANY\(\$4::date\[\]\)\)/u);
});

test('Postgres body-age result mapper returns only display-safe result fields and latest calculation date', async () => {
  const pool = new RecordingPool([{ rows: [] }, {
    rows: [{
      user_id: userId,
      algorithm_version: 'air-cn-v1',
      age_years: 39,
      age_boundary: null,
      route: 'daily_vo2',
      status: 'daily_vo2_provisional',
      coverage_days: 14,
      latest_input_civil_date: '2026-08-22',
      last_calculated_civil_date: '2026-08-22',
      reference_version: 'chinese-community-cycle-vo2peak-p50-v1',
      reference_hash: 'sha256:reference',
      input_fingerprint: 'sha256:inputs',
      profile_revision: 3,
      chronological_age_delta_years: -2,
      data_gaps: JSON.stringify({ dailyVo2DaysNeeded: 0, rhrDaysNeeded: 0, observedHrPeakRequired: false }),
      window_days: 28,
      exclusion_counts: JSON.stringify({
        invalidDailyVo2: 0,
        futureDailyVo2: 0,
        untrustedDailyVo2: 0,
        invalidDailyRhr: 0,
        futureDailyRhr: 0,
        untrustedDailyRhr: 0,
      }),
      computed_at: '2026-08-22T16:01:00.000Z',
      birth_date: '1988-04-20',
      vo2_max: 42,
      historical_observed_hr_peak_bpm: 181,
      payload: { forbidden: true },
    }],
  }]);
  const store = createPostgresStoreForTesting(pool);

  await store.healthMetrics.writeBodyAgeResult(resultWrite());
  const result = await store.healthMetrics.readLatestBodyAgeResult({ userId, algorithmVersion: 'air-cn-v1' });

  const insert = pool.queries.find((query) => /INSERT INTO body_age_results/u.test(query.text));
  assert.ok(insert);
  assert.match(insert?.text ?? '', /last_calculated_civil_date/u);
  assert.match(insert?.text ?? '', /window_days, exclusion_counts/u);
  assert.doesNotMatch(insert?.text ?? '', /birth_date|vo2_max|observed_hr_peak|payload/iu);
  assert.deepEqual(result, {
    userId,
    algorithmVersion: 'air-cn-v1',
    estimate: estimate(),
    lastCalculatedCivilDate: '2026-08-22',
    referenceHash: 'sha256:reference',
    inputFingerprint: 'sha256:inputs',
    profileRevision: 3,
    chronologicalAgeDeltaYears: -2,
    windowDays: 28,
    exclusionCounts: {
      invalidDailyVo2: 0,
      futureDailyVo2: 0,
      untrustedDailyVo2: 0,
      invalidDailyRhr: 0,
      futureDailyRhr: 0,
      untrustedDailyRhr: 0,
    },
    computedAt: '2026-08-22T16:01:00.000Z',
  });
  assert.doesNotMatch(JSON.stringify(result), /birthDate|vo2Max|observedHrPeakBpm|payload|peakBpm/u);
});

test('memory store keeps profile settings revisioned, observed peaks monotonic, and daily VO2 window refreshes transactional', async () => {
  const store = createMemoryStore();
  await store.users.insert(userId);

  await store.healthMetrics.recordObservedHrPeak({
    userId,
    observedHrPeakBpm: 181,
    observedAt: '2026-08-20T12:00:00.000Z',
  });
  await store.healthMetrics.updateBodyAgeProfile({ userId, birthDate: '1988-04-20', referenceSex: 'female' });
  await store.healthMetrics.updateBodyAgeProfile({ userId, birthDate: '1988-04-20', referenceSex: 'female' });
  await store.healthMetrics.recordObservedHrPeak({
    userId,
    observedHrPeakBpm: 176,
    observedAt: '2026-08-21T12:00:00.000Z',
  });
  await store.healthMetrics.recordObservedHrPeak({
    userId,
    observedHrPeakBpm: 184,
    observedAt: '2026-08-22T12:00:00.000Z',
  });

  assert.deepEqual(await store.healthMetrics.getBodyAgeProfile({ userId }), {
    userId,
    birthDate: '1988-04-20',
    referenceSex: 'female',
    profileRevision: 1,
    observedHrPeakBpm: 184,
    firstObservedHrPeakAt: '2026-08-20T12:00:00.000Z',
    latestObservedHrPeakAt: '2026-08-22T12:00:00.000Z',
  });

  await store.healthMetrics.upsertDailyVo2([
    dailyVo2('2026-08-19'),
    dailyVo2('2026-08-20'),
    dailyVo2('2026-08-21'),
  ]);
  await store.healthMetrics.upsertDailyVo2([dailyVo2('2026-08-18', { vo2Max: 101 })]);
  await store.healthMetrics.upsertDailyVo2([
    dailyVo2('2026-08-19', { vo2Max: 41, revision: 0 }),
  ]);
  await store.healthMetrics.authoritativelyReplaceDailyVo2({
    userId,
    fromCivilDate: '2026-08-20',
    toCivilDate: '2026-08-22',
    rows: [dailyVo2('2026-08-22', { vo2Max: 44, revision: 3 })],
  });
  assert.deepEqual(
    (await store.healthMetrics.listDailyVo2({ userId, fromCivilDate: '2026-08-19', toCivilDate: '2026-08-22' }))
      .map((row) => [row.civilDate, row.vo2Max]),
    [['2026-08-19', 42], ['2026-08-22', 44]],
  );
  assert.equal((await store.healthMetrics.listDailyVo2({ userId, fromCivilDate: '2026-08-18', toCivilDate: '2026-08-18' }))[0]?.vo2Max, 101);

  await assert.rejects(store.withTransaction(async (transaction) => {
    await transaction.healthMetrics.upsertDailyVo2([dailyVo2('2026-08-23')]);
    throw new Error('rollback body age data');
  }), /rollback body age data/u);
  assert.equal(
    (await store.healthMetrics.listDailyVo2({ userId, fromCivilDate: '2026-08-23', toCivilDate: '2026-08-23' })).length,
    0,
  );
});

test('memory body-age results overwrite by user and algorithm version, retain last calculation date, and cascade on deletion', async () => {
  const store = createMemoryStore();
  await store.users.insert(userId);
  await store.users.insert(otherUserId);
  await store.healthMetrics.writeBodyAgeResult(resultWrite());
  await store.healthMetrics.writeBodyAgeResult(resultWrite({
    estimate: estimate({ status: 'daily_vo2_stable', coverageDays: 28 }),
    lastCalculatedCivilDate: '2026-08-23',
    computedAt: '2026-08-23T16:01:00.000Z',
  }));
  await store.healthMetrics.writeBodyAgeResult(resultWrite({ userId: otherUserId }));
  await store.healthMetrics.upsertDailyVo2([dailyVo2('2026-08-22')]);
  await store.healthMetrics.recordObservedHrPeak({
    userId,
    observedHrPeakBpm: 181,
    observedAt: '2026-08-22T12:00:00.000Z',
  });

  const latest = await store.healthMetrics.readLatestBodyAgeResult({ userId, algorithmVersion: 'air-cn-v1' });
  assert.equal(latest?.estimate.status, 'daily_vo2_stable');
  assert.equal(latest?.lastCalculatedCivilDate, '2026-08-23');
  assert.equal(latest?.computedAt, '2026-08-23T16:01:00.000Z');

  await store.healthMetrics.deleteForUser(userId);
  assert.equal(await store.healthMetrics.readLatestBodyAgeResult({ userId, algorithmVersion: 'air-cn-v1' }), undefined);
  assert.equal((await store.healthMetrics.listDailyVo2({ userId, fromCivilDate: '2026-08-22', toCivilDate: '2026-08-22' })).length, 0);
  assert.equal(await store.healthMetrics.getBodyAgeProfile({ userId }), undefined);
  assert.ok(await store.healthMetrics.readLatestBodyAgeResult({ userId: otherUserId, algorithmVersion: 'air-cn-v1' }));
});

test('body-age result writes reject invalid status, route, age, and chronological-delta combinations', async () => {
  const store = createMemoryStore();

  await assert.rejects(store.healthMetrics.writeBodyAgeResult(resultWrite({
    estimate: estimate({ age: null, route: 'daily_vo2', status: 'profile_missing' }),
    chronologicalAgeDeltaYears: null,
  })), /profile_missing/u);
  await assert.rejects(store.healthMetrics.writeBodyAgeResult(resultWrite({
    estimate: estimate({ age: 'below_reference_min', route: 'daily_vo2' }),
    chronologicalAgeDeltaYears: -2,
  })), /chronological age delta/u);
  await assert.rejects(store.healthMetrics.writeBodyAgeResult(resultWrite({
    estimate: estimate({ age: null, route: 'observed_peak_ratio', status: 'stale' }),
    chronologicalAgeDeltaYears: 1,
  })), /stale/u);
});
