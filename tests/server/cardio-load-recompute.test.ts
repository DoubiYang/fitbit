import assert from 'node:assert/strict';
import test from 'node:test';

import { parseActivityLevelInterval, parseDailyCardioLoad, parseHeartRateMinuteAggregate, parseHeartRateMinuteEvidence } from '../../src/domain/cardio-records';
import { parseDailyRhr, parseSleepSession } from '../../src/domain/health-records';
import { createMemoryStore } from '../../src/server/db/memory-store';
import { recomputeTrimpCardioLoad, recomputeTrimpWeeklyBaselines } from '../../src/server/health/cardio-load-recompute';
import { emptyUserHealthRecords } from '../../src/server/health/provider';

const userId = 'trimp-user';
const civilDate = '2026-08-22';
const now = new Date('2026-08-22T13:00:00.000Z');

function addCivilDays(date: string, days: number): string {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

function rhrRecords() {
  return ['2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21']
    .map((date) => parseDailyRhr({
      userId,
      source: 'google_health',
      sourceRecordId: `rhr-${date}`,
      date,
      valueBpm: 55,
    }));
}

async function seedStore() {
  const store = createMemoryStore();
  await store.users.insert(userId);
  await store.healthMetrics.updateBodyAgeProfile({ userId, birthDate: null, referenceSex: 'male' });
  await store.healthMetrics.insertTimeZoneHistory({
    userId,
    ianaTimeZone: 'UTC',
    effectiveAt: '2026-01-01T00:00:00.000Z',
    isBackfillAnchor: true,
  });
  await store.healthMetrics.upsertMinutes([parseHeartRateMinuteAggregate({
    userId,
    sourceFamily: 'google-wearables',
    minuteStartUtc: '2026-08-22T12:00:00.000Z',
    civilDate,
    utcOffsetMinutes: 0,
    ianaTimeZone: 'UTC',
    localMinuteOfDay: 720,
    avgBpm: 130,
    minBpm: 130,
    maxBpm: 180,
    sampleCount: 1,
    coverageSeconds: 60,
    activityLevel: 'unknown',
  })]);
  await store.healthMetrics.upsertHeartRateMinuteEvidence([parseHeartRateMinuteEvidence({
    userId,
    sourceFamily: 'google-wearables',
    minuteStartUtc: '2026-08-22T12:00:00.000Z',
    segments: [{ startOffsetMs: 0, endOffsetMs: 60_000, bpm: 130 }],
  })]);
  return store;
}

test('late activity evidence replays persisted BPM segments into daily TRIMP', async () => {
  const store = await seedStore();
  const records = { ...emptyUserHealthRecords(), dailyRhr: rhrRecords() };

  await recomputeTrimpCardioLoad({ store, userId, now, records, fromCivilDate: civilDate });
  const before = await store.healthMetrics.getDailyCardioLoad({ userId, civilDate });
  assert.equal(before?.dailyLoad, 0);
  assert.equal(before?.qualifiedSeconds, 0);
  assert.equal(before?.unverifiedElevatedHrSeconds, 60);

  await store.healthMetrics.upsertActivityLevelIntervals([parseActivityLevelInterval({
    userId,
    sourceFamily: 'google-wearables',
    startTime: '2026-08-22T12:00:00.000Z',
    endTime: '2026-08-22T12:01:00.000Z',
    activityLevelType: 'LIGHTLY_ACTIVE',
  })]);
  await recomputeTrimpCardioLoad({ store, userId, now, records, fromCivilDate: civilDate });

  const after = await store.healthMetrics.getDailyCardioLoad({ userId, civilDate });
  assert.equal(after?.status, 'scored');
  assert.ok((after?.dailyLoad ?? 0) > 0);
  assert.equal(after?.qualifiedSeconds, 60);
  assert.equal(after?.unverifiedElevatedHrSeconds, 0);
  assert.equal(after?.rhrBaseBpm, 55);
  assert.equal(after?.hrMaxEstBpm, 180);
  assert.deepEqual(after?.hrMaxProvenance, {
    filterRuleVersion: 'google-wearables-hrmax-v1',
    sourceFamily: 'google-wearables',
    minuteStartUtc: '2026-08-22T12:00:00.000Z',
    bpm: 180,
    coverageSeconds: 60,
    sampleCount: 1,
  });
  const capacity = await store.healthMetrics.getDailyLoadCapacity({ userId, civilDate });
  assert.equal(capacity?.actualLoad, after?.dailyLoad);
  assert.equal(capacity?.status, 'calibrating');
  assert.equal(capacity?.usableLoad, null);
  assert.equal(capacity?.utilization, null);
});

test('uses the highest eligible non-sleep peak from the full retained history', async () => {
  const store = await seedStore();
  await store.healthMetrics.upsertMinutes([
    parseHeartRateMinuteAggregate({
      userId, sourceFamily: 'google-wearables', minuteStartUtc: '2026-08-10T23:30:00.000Z', civilDate: '2026-08-10', utcOffsetMinutes: 0,
      ianaTimeZone: 'UTC', localMinuteOfDay: 1410, avgBpm: 220, minBpm: 220, maxBpm: 220, sampleCount: 1, coverageSeconds: 60, activityLevel: 'unknown',
    }),
    parseHeartRateMinuteAggregate({
      userId, sourceFamily: 'google-wearables', minuteStartUtc: '2026-08-11T12:00:00.000Z', civilDate: '2026-08-11', utcOffsetMinutes: 0,
      ianaTimeZone: 'UTC', localMinuteOfDay: 720, avgBpm: 190, minBpm: 190, maxBpm: 190, sampleCount: 1, coverageSeconds: 60, activityLevel: 'unknown',
    }),
  ]);
  const sleep = parseSleepSession({
    userId,
    source: 'google_health',
    sourceRecordId: 'sleep-11',
    id: 'sleep-11',
    startTime: '2026-08-10T22:00:00.000Z',
    endTime: '2026-08-11T06:00:00.000Z',
    civilEndDate: '2026-08-11',
    utcOffsetMinutes: 0,
    minutesAsleep: 420,
    timeInBedMinutes: 480,
    awakeMinutes: 60,
    isNap: false,
    processed: true,
  });
  const records = { ...emptyUserHealthRecords(), dailyRhr: rhrRecords(), sleepSessions: [sleep] };

  await recomputeTrimpCardioLoad({ store, userId, now, records, fromCivilDate: civilDate });

  const row = await store.healthMetrics.getDailyCardioLoad({ userId, civilDate });
  assert.equal(row?.hrMaxEstBpm, 190);
  assert.equal(row?.hrMaxProvenance?.minuteStartUtc, '2026-08-11T12:00:00.000Z');
});

test('a new eligible HRmax peak replays every retained v3 day, not only its arrival date', async () => {
  const store = await seedStore();
  await store.healthMetrics.upsertDailyCardioLoad(parseDailyCardioLoad({
    userId,
    civilDate: '2026-08-10',
    metricVersion: 'cardio-load-trimp-v3',
    status: 'insufficient_context',
    dailyLoad: null,
    qualifiedSeconds: 0,
    unverifiedElevatedHrSeconds: 0,
    rawHrCoverageSeconds: 0,
    awakeCoverageRatio: null,
    motionSource: 'none',
    qualityState: 'incomplete',
    rhrBaseBpm: null,
    hrMaxEstBpm: 180,
    hrMaxProvenance: {
      filterRuleVersion: 'google-wearables-hrmax-v1', sourceFamily: 'google-wearables', minuteStartUtc: '2026-08-22T12:00:00.000Z', bpm: 180, coverageSeconds: 60, sampleCount: 1,
    },
    inputFingerprint: `sha256:${'c'.repeat(64)}`,
    calculationContext: { test: true },
  }));
  await store.healthMetrics.upsertMinutes([parseHeartRateMinuteAggregate({
    userId, sourceFamily: 'google-wearables', minuteStartUtc: '2026-08-22T12:30:00.000Z', civilDate, utcOffsetMinutes: 0,
    ianaTimeZone: 'UTC', localMinuteOfDay: 750, avgBpm: 200, minBpm: 200, maxBpm: 200, sampleCount: 1, coverageSeconds: 60, activityLevel: 'unknown',
  })]);

  await recomputeTrimpCardioLoad({
    store,
    userId,
    now,
    records: { ...emptyUserHealthRecords(), dailyRhr: rhrRecords() },
    fromCivilDate: civilDate,
  });

  assert.equal((await store.healthMetrics.getDailyCardioLoad({ userId, civilDate: '2026-08-10' }))?.hrMaxEstBpm, 200);
});

test('does not turn a past low-coverage day into a zero load', async () => {
  const store = await seedStore();
  const records = { ...emptyUserHealthRecords(), dailyRhr: rhrRecords() };

  await recomputeTrimpCardioLoad({
    store,
    userId,
    now: new Date('2026-08-23T13:00:00.000Z'),
    records,
    fromCivilDate: civilDate,
  });

  const row = await store.healthMetrics.getDailyCardioLoad({ userId, civilDate });
  assert.equal(row?.status, 'insufficient_context');
  assert.equal(row?.dailyLoad, null);
  assert.equal(row?.qualityState, 'incomplete');
});

test('builds a weekly baseline only after four contiguous complete qualified weeks', async () => {
  const store = await seedStore();
  const firstWeekStart = '2026-07-06';
  for (let index = 0; index < 28; index += 1) {
    const date = addCivilDays(firstWeekStart, index);
    await store.healthMetrics.upsertDailyCardioLoad(parseDailyCardioLoad({
      userId,
      civilDate: date,
      metricVersion: 'cardio-load-trimp-v3',
      status: 'scored',
      dailyLoad: 10,
      qualifiedSeconds: 3600,
      unverifiedElevatedHrSeconds: 0,
      rawHrCoverageSeconds: 43_200,
      awakeCoverageRatio: 0.8,
      motionSource: 'activity_level',
      qualityState: 'qualified',
      rhrBaseBpm: 55,
      hrMaxEstBpm: 180,
      hrMaxProvenance: {
        filterRuleVersion: 'google-wearables-hrmax-v1', sourceFamily: 'google-wearables', minuteStartUtc: `${date}T12:00:00.000Z`, bpm: 180, coverageSeconds: 60, sampleCount: 1,
      },
      inputFingerprint: `sha256:${'a'.repeat(64)}`,
      calculationContext: { test: true },
    }));
  }

  await recomputeTrimpWeeklyBaselines({
    store,
    userId,
    timeZone: 'UTC',
    now: new Date('2026-08-03T12:00:00.000Z'),
    fromCivilDate: firstWeekStart,
  });

  const baseline = await store.healthMetrics.getWeeklyCardioBaseline({ userId, weekStart: '2026-08-03' });
  assert.equal(baseline?.status, 'stable');
  assert.equal(baseline?.weeklyLoad, null);
  assert.equal(baseline?.weekToDateLoad, 0);
  assert.equal(baseline?.rm4, 70);
  assert.equal(baseline?.ewma4, 70);
  assert.equal(baseline?.baseline, 70);
});

test('a current-day replay retains the weekly baseline by reading prior retained weeks', async () => {
  const store = await seedStore();
  const firstWeekStart = '2026-07-06';
  for (let index = 0; index < 28; index += 1) {
    const date = addCivilDays(firstWeekStart, index);
    await store.healthMetrics.upsertDailyCardioLoad(parseDailyCardioLoad({
      userId,
      civilDate: date,
      metricVersion: 'cardio-load-trimp-v3',
      status: 'scored',
      dailyLoad: 10,
      qualifiedSeconds: 3600,
      unverifiedElevatedHrSeconds: 0,
      rawHrCoverageSeconds: 43_200,
      awakeCoverageRatio: 0.8,
      motionSource: 'activity_level',
      qualityState: 'qualified',
      rhrBaseBpm: 55,
      hrMaxEstBpm: 180,
      hrMaxProvenance: {
        filterRuleVersion: 'google-wearables-hrmax-v1', sourceFamily: 'google-wearables', minuteStartUtc: `${date}T12:00:00.000Z`, bpm: 180, coverageSeconds: 60, sampleCount: 1,
      },
      inputFingerprint: `sha256:${'b'.repeat(64)}`,
      calculationContext: { test: true },
    }));
  }
  const startOfCurrentWeek = new Date('2026-08-03T12:00:00.000Z');
  await recomputeTrimpWeeklyBaselines({
    store, userId, timeZone: 'UTC', now: startOfCurrentWeek, fromCivilDate: firstWeekStart,
  });

  await recomputeTrimpWeeklyBaselines({
    store, userId, timeZone: 'UTC', now: startOfCurrentWeek, fromCivilDate: '2026-08-03',
  });

  const baseline = await store.healthMetrics.getWeeklyCardioBaseline({ userId, weekStart: '2026-08-03' });
  assert.equal(baseline?.status, 'stable');
  assert.equal(baseline?.baseline, 70);
});
