import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDailyRhr } from '../../src/domain/health-records';
import { BODY_AGE_ALGORITHM_VERSION, recomputeBodyAge } from '../../src/server/health/body-age-recompute';
import { createMemoryStore } from '../../src/server/db/memory-store';
import { emptyUserHealthRecords, type UserHealthRecords } from '../../src/server/health/provider';

const userId = 'u-body-age';
const NOW = new Date('2026-08-24T12:00:00.000Z');

function addCivilDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function googleRhr(date: string, valueBpm = 60) {
  return parseDailyRhr({
    userId,
    source: 'google_health',
    sourceRecordId: `rhr-${date}`,
    date,
    valueBpm,
  });
}

function sevenRhr(asOf = '2026-08-24'): UserHealthRecords {
  return {
    ...emptyUserHealthRecords(),
    dailyRhr: Array.from({ length: 7 }, (_, offset) => googleRhr(addCivilDays(asOf, -offset))),
  };
}

async function seedProfileAndDailyVo2(store: ReturnType<typeof createMemoryStore>, count: number, asOf = '2026-08-24') {
  await store.users.insert(userId);
  await store.healthMetrics.updateBodyAgeProfile({ userId, birthDate: '1988-04-20', referenceSex: 'male' });
  await store.healthMetrics.upsertDailyVo2(Array.from({ length: count }, (_, offset) => ({
    userId,
    civilDate: addCivilDays(asOf, -offset),
    vo2Max: 26.7,
    sourceFamily: 'google-wearables' as const,
    receivedAt: NOW.toISOString(),
    revision: 0,
    estimated: offset === 0,
  })));
}

test('recompute prefers daily VO2 and writes only safe result metadata', async () => {
  const store = createMemoryStore();
  await seedProfileAndDailyVo2(store, 7);
  await store.healthMetrics.recordObservedHrPeak({ userId, observedHrPeakBpm: 120, observedAt: '2026-08-24T11:00:00.000Z' });
  const originalWrite = store.healthMetrics.writeBodyAgeResult;
  let writtenPayload: unknown;
  store.healthMetrics.writeBodyAgeResult = async (input) => {
    writtenPayload = input;
    await originalWrite(input);
  };

  await recomputeBodyAge({ store: store.healthMetrics, userId, now: NOW, records: sevenRhr() });

  const result = await store.healthMetrics.readLatestBodyAgeResult({ userId, algorithmVersion: BODY_AGE_ALGORITHM_VERSION });
  assert.ok(result);
  assert.equal(result.estimate.route, 'daily_vo2');
  assert.equal(result.estimate.status, 'daily_vo2_provisional');
  assert.equal(result.estimate.age, 45);
  assert.equal(result.chronologicalAgeDeltaYears, 7);
  assert.equal(result.lastCalculatedCivilDate, '2026-08-24');
  assert.equal(result.profileRevision, 1);
  assert.equal(result.windowDays, 28);
  assert.match(result.referenceHash, /^[a-f0-9]{64}$/);
  assert.match(result.inputFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(result.exclusionCounts, {
    invalidDailyVo2: 0,
    futureDailyVo2: 0,
    untrustedDailyVo2: 0,
    invalidDailyRhr: 0,
    futureDailyRhr: 0,
    untrustedDailyRhr: 0,
  });
  const serialized = JSON.stringify(writtenPayload);
  assert.equal(serialized.includes('1988-04-20'), false);
  assert.equal(serialized.includes('26.7'), false);
  assert.equal(serialized.includes('60'), false);
  assert.equal(serialized.includes('120'), false);

});

test('recompute fingerprints the calculation civil date even without snapshot RHR inputs', async () => {
  const store = createMemoryStore();
  await seedProfileAndDailyVo2(store, 7);

  await recomputeBodyAge({ store: store.healthMetrics, userId, now: NOW, records: emptyUserHealthRecords() });
  const first = await store.healthMetrics.readLatestBodyAgeResult({ userId, algorithmVersion: BODY_AGE_ALGORITHM_VERSION });
  assert.ok(first);

  await recomputeBodyAge({
    store: store.healthMetrics,
    userId,
    now: new Date('2026-08-25T12:00:00.000Z'),
    records: emptyUserHealthRecords(),
  });
  const nextDay = await store.healthMetrics.readLatestBodyAgeResult({ userId, algorithmVersion: BODY_AGE_ALGORITHM_VERSION });
  assert.ok(nextDay);
  assert.notEqual(nextDay.inputFingerprint, first.inputFingerprint);
});

test('recompute fingerprints complete time-zone history even when the current time zone is unchanged', async () => {
  const store = createMemoryStore();
  await seedProfileAndDailyVo2(store, 7);
  await store.healthMetrics.insertTimeZoneHistory({
    userId,
    ianaTimeZone: 'UTC',
    effectiveAt: '2026-01-01T00:00:00.000Z',
    isBackfillAnchor: true,
  });
  await recomputeBodyAge({ store: store.healthMetrics, userId, now: NOW, records: emptyUserHealthRecords() });
  const before = await store.healthMetrics.readLatestBodyAgeResult({ userId, algorithmVersion: BODY_AGE_ALGORITHM_VERSION });
  assert.ok(before);
  assert.equal(before.lastCalculatedCivilDate, '2026-08-24');

  await store.healthMetrics.insertTimeZoneHistory({
    userId,
    ianaTimeZone: 'Asia/Shanghai',
    effectiveAt: '2025-12-01T00:00:00.000Z',
    isBackfillAnchor: false,
  });
  await recomputeBodyAge({ store: store.healthMetrics, userId, now: NOW, records: emptyUserHealthRecords() });
  const after = await store.healthMetrics.readLatestBodyAgeResult({ userId, algorithmVersion: BODY_AGE_ALGORITHM_VERSION });
  assert.ok(after);
  assert.equal(after.lastCalculatedCivilDate, '2026-08-24');
  assert.notEqual(after.inputFingerprint, before.inputFingerprint);
});

test('recompute fingerprint is stable for unchanged daily values despite synthetic receipt times', async () => {
  const store = createMemoryStore();
  await seedProfileAndDailyVo2(store, 7);
  const records = sevenRhr();
  await recomputeBodyAge({ store: store.healthMetrics, userId, now: NOW, records });
  const first = await store.healthMetrics.readLatestBodyAgeResult({ userId, algorithmVersion: BODY_AGE_ALGORITHM_VERSION });
  assert.ok(first);

  await recomputeBodyAge({
    store: store.healthMetrics,
    userId,
    now: new Date('2026-08-24T13:00:00.000Z'),
    records,
  });
  const unchanged = await store.healthMetrics.readLatestBodyAgeResult({ userId, algorithmVersion: BODY_AGE_ALGORITHM_VERSION });
  assert.ok(unchanged);
  assert.equal(unchanged.inputFingerprint, first.inputFingerprint);

  const stored = await store.healthMetrics.listDailyVo2({ userId, fromCivilDate: '2026-07-28', toCivilDate: '2026-08-24' });
  await store.healthMetrics.upsertDailyVo2(stored.map((row) => ({
    ...row,
    vo2Max: row.civilDate === '2026-08-24' ? 27 : row.vo2Max,
    receivedAt: '2026-08-24T14:00:00.000Z',
  })));
  await recomputeBodyAge({
    store: store.healthMetrics,
    userId,
    now: new Date('2026-08-24T14:00:00.000Z'),
    records,
  });
  const changed = await store.healthMetrics.readLatestBodyAgeResult({ userId, algorithmVersion: BODY_AGE_ALGORITHM_VERSION });
  assert.ok(changed);
  assert.notEqual(changed.inputFingerprint, first.inputFingerprint);
});

test('recompute uses seven current snapshot RHR days with the observed-peak proxy when daily VO2 is insufficient', async () => {
  const store = createMemoryStore();
  await seedProfileAndDailyVo2(store, 6);
  await store.healthMetrics.recordObservedHrPeak({ userId, observedHrPeakBpm: 120, observedAt: '2026-08-24T11:00:00.000Z' });

  await recomputeBodyAge({ store: store.healthMetrics, userId, now: NOW, records: sevenRhr() });

  const result = await store.healthMetrics.readLatestBodyAgeResult({ userId, algorithmVersion: BODY_AGE_ALGORITHM_VERSION });
  assert.ok(result);
  assert.equal(result.estimate.route, 'observed_peak_ratio');
  assert.equal(result.estimate.status, 'observed_peak_ratio_provisional');
  assert.equal(typeof result.estimate.age, 'number');
  assert.notEqual(result.chronologicalAgeDeltaYears, null);
});

test('recompute persists safe profile-missing and stale states', async () => {
  const store = createMemoryStore();
  await store.users.insert(userId);

  await recomputeBodyAge({ store: store.healthMetrics, userId, now: NOW, records: emptyUserHealthRecords() });
  let result = await store.healthMetrics.readLatestBodyAgeResult({ userId, algorithmVersion: BODY_AGE_ALGORITHM_VERSION });
  assert.ok(result);
  assert.equal(result.estimate.status, 'profile_missing');
  assert.equal(result.profileRevision, 0);
  assert.equal(result.chronologicalAgeDeltaYears, null);

  await store.healthMetrics.updateBodyAgeProfile({ userId, birthDate: '1988-04-20', referenceSex: 'male' });
  await store.healthMetrics.upsertDailyVo2(Array.from({ length: 7 }, (_, offset) => ({
    userId,
    civilDate: addCivilDays('2026-08-10', -offset),
    vo2Max: 26.7,
    sourceFamily: 'google-wearables' as const,
    receivedAt: NOW.toISOString(),
    revision: 0,
    estimated: false,
  })));
  await recomputeBodyAge({ store: store.healthMetrics, userId, now: NOW, records: emptyUserHealthRecords() });
  result = await store.healthMetrics.readLatestBodyAgeResult({ userId, algorithmVersion: BODY_AGE_ALGORITHM_VERSION });
  assert.ok(result);
  assert.equal(result.estimate.status, 'stale');
  assert.equal(result.estimate.route, 'daily_vo2');
  assert.equal(result.estimate.age, null);
  assert.equal(result.chronologicalAgeDeltaYears, null);
  assert.equal(result.lastCalculatedCivilDate, '2026-08-24');
});

test('stale recompute retains the last usable calculation civil date across later hourly runs', async () => {
  const store = createMemoryStore();
  await seedProfileAndDailyVo2(store, 7, '2026-08-10');
  const freshNow = new Date('2026-08-10T12:00:00.000Z');
  await recomputeBodyAge({ store: store.healthMetrics, userId, now: freshNow, records: emptyUserHealthRecords() });
  const fresh = await store.healthMetrics.readLatestBodyAgeResult({ userId, algorithmVersion: BODY_AGE_ALGORITHM_VERSION });
  assert.ok(fresh);
  assert.equal(typeof fresh.estimate.age, 'number');
  assert.equal(fresh.lastCalculatedCivilDate, '2026-08-10');

  await recomputeBodyAge({
    store: store.healthMetrics,
    userId,
    now: new Date('2026-08-18T12:00:00.000Z'),
    records: emptyUserHealthRecords(),
  });
  const firstStale = await store.healthMetrics.readLatestBodyAgeResult({ userId, algorithmVersion: BODY_AGE_ALGORITHM_VERSION });
  assert.ok(firstStale);
  assert.equal(firstStale.estimate.status, 'stale');
  assert.equal(firstStale.lastCalculatedCivilDate, '2026-08-10');
  assert.equal(firstStale.estimate.latestInputCivilDate, '2026-08-10');

  await recomputeBodyAge({
    store: store.healthMetrics,
    userId,
    now: new Date('2026-08-19T12:00:00.000Z'),
    records: emptyUserHealthRecords(),
  });
  const laterStale = await store.healthMetrics.readLatestBodyAgeResult({ userId, algorithmVersion: BODY_AGE_ALGORITHM_VERSION });
  assert.ok(laterStale);
  assert.equal(laterStale.estimate.status, 'stale');
  assert.equal(laterStale.lastCalculatedCivilDate, '2026-08-10');
  assert.equal(laterStale.estimate.latestInputCivilDate, '2026-08-10');
  assert.equal(laterStale.computedAt, '2026-08-19T12:00:00.000Z');
});
