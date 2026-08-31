import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseActivityLevelInterval,
  parseDailyCardio,
  parseDailyHeartRateZones,
  parseDailyTimeInZone,
  parseExerciseInterval,
  parseHeartRateMinuteAggregate,
  parseMetricResult,
  parseSleepGoal,
} from '../../src/domain/cardio-records';
import { WHOOP_STYLE_METRIC_VERSION } from '../../src/domain/metric-types';
import type { ConnectionRow } from '../../src/server/auth/types';
import { createMemoryStore } from '../../src/server/db/memory-store';
import {
  healthMetricsExposesRawSamplePersistence,
  SleepGoalConflictError,
  TimeZoneHistoryConflictError,
  type HealthMetricsWindowWrite,
} from '../../src/server/health/cardio-store';

const userA = 'user-a';
const userB = 'user-b';
const sourceFamily = 'google-wearables' as const;
const civilDate = '2026-08-22';
const connectionA = 'connection-a';
const connectionB = 'connection-b';
const now = new Date('2026-08-22T16:00:00.000Z');

const zones = {
  LIGHT: { minBeatsPerMinute: 97, maxBeatsPerMinute: 116 },
  MODERATE: { minBeatsPerMinute: 117, maxBeatsPerMinute: 136 },
  VIGOROUS: { minBeatsPerMinute: 137, maxBeatsPerMinute: 155 },
  PEAK: { minBeatsPerMinute: 156, maxBeatsPerMinute: 200 },
};

function connection(id: string, userId: string): ConnectionRow {
  return {
    id,
    userId,
    healthUserId: `health-${userId}`,
    legacyUserId: undefined,
    tokenEnvelopeCiphertext: Buffer.from('ciphertext'),
    tokenEnvelopeIv: Buffer.alloc(12),
    tokenEnvelopeAuthTag: Buffer.alloc(16),
    encryptionKeyVersion: 1,
    accessTokenExpiresAt: new Date('2026-08-22T17:00:00.000Z'),
    refreshTokenExpiresAt: new Date('2026-08-29T16:00:00.000Z'),
    grantedScopes: [],
    status: 'active',
    lastErrorCode: undefined,
    connectedAt: now,
    updatedAt: now,
    lastSuccessfulSyncAt: undefined,
  };
}

function minute(input: { userId: string; minuteStartUtc?: string; civilDate?: string; avgBpm?: number; ianaTimeZone?: string | null }) {
  return parseHeartRateMinuteAggregate({
    userId: input.userId,
    sourceFamily,
    minuteStartUtc: input.minuteStartUtc ?? '2026-08-22T12:00:00.000Z',
    civilDate: input.civilDate ?? civilDate,
    utcOffsetMinutes: 480,
    ianaTimeZone: input.ianaTimeZone === undefined ? null : input.ianaTimeZone,
    localMinuteOfDay: 1200,
    avgBpm: input.avgBpm ?? 110,
    minBpm: input.avgBpm ?? 110,
    maxBpm: input.avgBpm ?? 110,
    sampleCount: 8,
    coverageSeconds: 60,
    activityLevel: 'LIGHTLY_ACTIVE',
  });
}

function activity(input: { userId: string; startTime?: string; activityLevelType?: 'SEDENTARY' | 'LIGHTLY_ACTIVE' | 'VERY_ACTIVE' }) {
  const startTime = input.startTime ?? '2026-08-22T12:00:00.000Z';
  return parseActivityLevelInterval({
    userId: input.userId,
    sourceFamily,
    startTime,
    endTime: new Date(Date.parse(startTime) + 60_000).toISOString(),
    activityLevelType: input.activityLevelType ?? 'LIGHTLY_ACTIVE',
  });
}

function heartRateZones(input: { userId: string; date?: string; peakMax?: number }) {
  return parseDailyHeartRateZones({
    userId: input.userId,
    sourceFamily,
    date: input.date ?? civilDate,
    zones: {
      ...zones,
      PEAK: { minBeatsPerMinute: 156, maxBeatsPerMinute: input.peakMax ?? 200 },
    },
  });
}

function timeInZone(input: { userId: string; date?: string; light?: number }) {
  return parseDailyTimeInZone({
    userId: input.userId,
    sourceFamily,
    date: input.date ?? civilDate,
    minutes: { light: input.light ?? 400, moderate: 20, vigorous: 5, peak: 0 },
  });
}

function exercise(input: { userId: string; sourceRecordId?: string; startTime?: string }) {
  const startTime = input.startTime ?? '2026-08-22T13:00:00.000Z';
  return parseExerciseInterval({
    userId: input.userId,
    sourceFamily,
    sourceRecordId: input.sourceRecordId ?? 'exercise-1',
    startTime,
    endTime: new Date(Date.parse(startTime) + 30 * 60_000).toISOString(),
    utcOffsetMinutes: 480,
    civilDate,
  });
}

function cardio(input: { userId: string; date?: string; strain?: number | null; status?: 'complete' | 'provisional' | 'unavailable' }) {
  const status = input.status ?? 'complete';
  return parseDailyCardio({
    userId: input.userId,
    date: input.date ?? civilDate,
    status,
    strain: input.strain === undefined ? (status === 'unavailable' ? null : 8.4) : input.strain,
    dose: status === 'unavailable' ? null : 70,
    zoneMinutes: { light: 12, moderate: 8, vigorous: 4, peak: 0 },
    knownContextMinutes: 600,
    rawCoverageMinutes: 610,
    attributedMinutes: 24,
    metricVersion: WHOOP_STYLE_METRIC_VERSION,
  });
}

function metricResult(input: { userId: string; civilDate?: string; score?: number | null }) {
  return parseMetricResult({
    userId: input.userId,
    civilDate: input.civilDate ?? civilDate,
    metricName: 'strain',
    metricVersion: WHOOP_STYLE_METRIC_VERSION,
    score: input.score === undefined ? 8.4 : input.score,
    status: input.score === null ? 'unavailable' : 'complete',
    quality: null,
    reason: input.score === null ? 'insufficient_coverage' : null,
    evidence: [{ label: 'dose', date: input.civilDate ?? civilDate, value: 70 }],
    source: {
      heartRateZones: true,
      activityLevel: true,
      exercise: true,
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

async function seedUsers(store: ReturnType<typeof createMemoryStore>) {
  await store.users.insert(userA);
  await store.users.insert(userB);
  await store.connections.insert(connection(connectionA, userA));
  await store.connections.insert(connection(connectionB, userB));
}

function windowWrite(overrides: Partial<HealthMetricsWindowWrite> = {}): HealthMetricsWindowWrite {
  return {
    userId: userA,
    connectionId: connectionA,
    dataType: 'heart-rate',
    minutes: [minute({ userId: userA })],
    dailyCardio: [cardio({ userId: userA })],
    metricResults: [metricResult({ userId: userA })],
    cursor: {
      successfulWatermark: now,
      lastErrorCode: undefined,
      retryCount: 0,
      nextAttemptAt: undefined,
    },
    ...overrides,
  };
}

test('accepts minute aggregates and has no raw sample persistence operation', async () => {
  const store = createMemoryStore();
  await seedUsers(store);

  await store.healthMetrics.upsertMinutes([minute({ userId: userA })]);
  const stored = await store.healthMetrics.listMinutesByCivilDate({ userId: userA, civilDate });

  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.avgBpm, 110);
  assert.equal(healthMetricsExposesRawSamplePersistence(store.healthMetrics), false);
  assert.equal('insertHeartRateSamples' in store.healthMetrics, false);
  assert.equal('upsertHeartRateSamples' in store.healthMetrics, false);
  assert.equal('saveRawSamples' in store.healthMetrics, false);
});

test('isolates every health-metric collection by user', async () => {
  const store = createMemoryStore();
  await seedUsers(store);

  await store.healthMetrics.upsertMinutes([minute({ userId: userA }), minute({ userId: userB, avgBpm: 90 })]);
  await store.healthMetrics.upsertActivityLevelIntervals([
    activity({ userId: userA }),
    activity({ userId: userB, activityLevelType: 'SEDENTARY' }),
  ]);
  await store.healthMetrics.replaceHeartRateZones(heartRateZones({ userId: userA }));
  await store.healthMetrics.replaceHeartRateZones(heartRateZones({ userId: userB, peakMax: 190 }));
  await store.healthMetrics.replaceTimeInZone(timeInZone({ userId: userA, light: 400 }));
  await store.healthMetrics.replaceTimeInZone(timeInZone({ userId: userB, light: 10 }));
  await store.healthMetrics.upsertExerciseIntervals([exercise({ userId: userA }), exercise({ userId: userB })]);
  await store.healthMetrics.upsertDailyCardio(cardio({ userId: userA, strain: 8.4 }));
  await store.healthMetrics.upsertDailyCardio(cardio({ userId: userB, strain: 3.1 }));
  await store.healthMetrics.upsertMetricResult(metricResult({ userId: userA, score: 8.4 }));
  await store.healthMetrics.upsertMetricResult(metricResult({ userId: userB, score: 3.1 }));
  await store.healthMetrics.insertSleepGoal(parseSleepGoal({ userId: userA, goalMinutes: 480, effectiveCivilDate: '2026-08-23' }));
  await store.healthMetrics.insertSleepGoal(parseSleepGoal({ userId: userB, goalMinutes: 420, effectiveCivilDate: '2026-08-23' }));
  await store.healthMetrics.insertTimeZoneHistory({
    userId: userA,
    ianaTimeZone: 'Asia/Shanghai',
    effectiveAt: '2026-08-01T00:00:00.000Z',
    isBackfillAnchor: true,
  });
  await store.healthMetrics.insertTimeZoneHistory({
    userId: userB,
    ianaTimeZone: 'America/Los_Angeles',
    effectiveAt: '2026-08-01T00:00:00.000Z',
    isBackfillAnchor: true,
  });

  assert.deepEqual(
    (await store.healthMetrics.listMinutesByCivilDate({ userId: userA, civilDate })).map((row) => row.avgBpm),
    [110],
  );
  assert.equal((await store.healthMetrics.getHeartRateZones({ userId: userA, civilDate }))?.zones.PEAK.maxBeatsPerMinute, 200);
  assert.equal((await store.healthMetrics.getTimeInZone({ userId: userA, civilDate }))?.minutes.light, 400);
  assert.equal((await store.healthMetrics.getDailyCardio({ userId: userA, civilDate }))?.strain, 8.4);
  assert.equal((await store.healthMetrics.getMetricResult({ userId: userA, civilDate, metricName: 'strain' }))?.score, 8.4);
  assert.equal((await store.healthMetrics.lookupSleepGoal({ userId: userA, civilDate: '2026-08-23' }))?.goalMinutes, 480);
  assert.equal((await store.healthMetrics.lookupTimeZoneHistory({ userId: userA, at: '2026-08-22T00:00:00.000Z' }))?.ianaTimeZone, 'Asia/Shanghai');
  assert.equal((await store.healthMetrics.listActivityLevelIntervalsInRange({ userId: userA, fromUtc: '2026-08-22T00:00:00.000Z' }))[0]?.activityLevelType, 'LIGHTLY_ACTIVE');
  assert.equal((await store.healthMetrics.getHeartRateZones({ userId: userB, civilDate }))?.zones.PEAK.maxBeatsPerMinute, 190);
  assert.equal((await store.healthMetrics.lookupSleepGoal({ userId: userB, civilDate: '2026-08-23' }))?.goalMinutes, 420);
});

test('upserts minutes by user, source family, and UTC minute', async () => {
  const store = createMemoryStore();
  await seedUsers(store);

  await store.healthMetrics.upsertMinutes([
    minute({ userId: userA, minuteStartUtc: '2026-08-22T12:00:00.000Z', avgBpm: 100 }),
    minute({ userId: userA, minuteStartUtc: '2026-08-22T12:01:00.000Z', avgBpm: 120 }),
  ]);
  await store.healthMetrics.upsertMinutes([
    minute({ userId: userA, minuteStartUtc: '2026-08-22T12:00:00.000Z', avgBpm: 108 }),
  ]);

  const stored = await store.healthMetrics.listMinutesByCivilDate({ userId: userA, civilDate });
  assert.equal(stored.length, 2);
  assert.equal(stored.find((row) => row.minuteStartUtc === '2026-08-22T12:00:00.000Z')?.avgBpm, 108);
  assert.equal(stored.find((row) => row.minuteStartUtc === '2026-08-22T12:01:00.000Z')?.avgBpm, 120);
});

test('upserts activity-level intervals by user, source family, and interval start UTC', async () => {
  const store = createMemoryStore();
  await seedUsers(store);

  await store.healthMetrics.upsertActivityLevelIntervals([
    activity({ userId: userA, startTime: '2026-08-22T12:00:00.000Z', activityLevelType: 'SEDENTARY' }),
    activity({ userId: userA, startTime: '2026-08-22T12:01:00.000Z', activityLevelType: 'LIGHTLY_ACTIVE' }),
  ]);
  await store.healthMetrics.upsertActivityLevelIntervals([
    activity({ userId: userA, startTime: '2026-08-22T12:00:00.000Z', activityLevelType: 'VERY_ACTIVE' }),
  ]);

  const stored = await store.healthMetrics.listActivityLevelIntervalsInRange({
    userId: userA,
    fromUtc: '2026-08-22T12:00:00.000Z',
    toUtcExclusive: '2026-08-22T12:02:00.000Z',
  });
  assert.equal(stored.length, 2);
  assert.equal(stored.find((row) => row.startTime === '2026-08-22T12:00:00.000Z')?.activityLevelType, 'VERY_ACTIVE');
  assert.equal(stored.find((row) => row.startTime === '2026-08-22T12:01:00.000Z')?.activityLevelType, 'LIGHTLY_ACTIVE');
});

test('replaces daily heart-rate zones by local date without touching other days', async () => {
  const store = createMemoryStore();
  await seedUsers(store);

  await store.healthMetrics.replaceHeartRateZones(heartRateZones({ userId: userA, date: '2026-08-22', peakMax: 198 }));
  await store.healthMetrics.replaceHeartRateZones(heartRateZones({ userId: userA, date: '2026-08-23', peakMax: 190 }));
  await store.healthMetrics.replaceHeartRateZones(heartRateZones({ userId: userA, date: '2026-08-22', peakMax: 201 }));

  assert.equal((await store.healthMetrics.getHeartRateZones({ userId: userA, civilDate: '2026-08-22' }))?.zones.PEAK.maxBeatsPerMinute, 201);
  assert.equal((await store.healthMetrics.getHeartRateZones({ userId: userA, civilDate: '2026-08-23' }))?.zones.PEAK.maxBeatsPerMinute, 190);
});

test('updates a cursor in the same transaction as a metric write and rolls both back together', async () => {
  const store = createMemoryStore();
  await seedUsers(store);

  await assert.rejects(
    store.withTransaction(async (tx) => {
      await tx.healthMetrics.upsertMinutes([minute({ userId: userA })]);
      await tx.healthMetrics.replaceHeartRateZones(heartRateZones({ userId: userA }));
      await tx.healthMetrics.upsertDailyCardio(cardio({ userId: userA }));
      await tx.healthMetrics.upsertMetricResult(metricResult({ userId: userA }));
      await tx.healthMetrics.updateCursor({
        connectionId: connectionA,
        dataType: 'heart-rate',
        successfulWatermark: now,
        lastErrorCode: undefined,
        retryCount: 0,
        nextAttemptAt: undefined,
      });
      throw new Error('force rollback');
    }),
    /force rollback/u,
  );

  assert.equal((await store.healthMetrics.listMinutesByCivilDate({ userId: userA, civilDate })).length, 0);
  assert.equal(await store.healthMetrics.getHeartRateZones({ userId: userA, civilDate }), undefined);
  assert.equal(await store.healthMetrics.getDailyCardio({ userId: userA, civilDate }), undefined);
  assert.equal(await store.healthMetrics.getMetricResult({ userId: userA, civilDate, metricName: 'strain' }), undefined);
  assert.equal(await store.healthMetrics.readCursor({ connectionId: connectionA, dataType: 'heart-rate' }), undefined);

  await store.healthMetrics.ingestWindow(windowWrite());

  assert.equal((await store.healthMetrics.listMinutesByCivilDate({ userId: userA, civilDate }))[0]?.avgBpm, 110);
  assert.equal((await store.healthMetrics.readCursor({ connectionId: connectionA, dataType: 'heart-rate' }))?.successfulWatermark?.toISOString(), now.toISOString());
  assert.equal((await store.healthMetrics.getDailyCardio({ userId: userA, civilDate }))?.strain, 8.4);
  assert.equal((await store.healthMetrics.getMetricResult({ userId: userA, civilDate, metricName: 'strain' }))?.score, 8.4);
});

test('looks up historical sleep goals and time zones without rewriting earlier rows', async () => {
  const store = createMemoryStore();
  await seedUsers(store);

  await store.healthMetrics.insertSleepGoal(parseSleepGoal({ userId: userA, goalMinutes: 480, effectiveCivilDate: '2026-08-23' }));
  await store.healthMetrics.insertSleepGoal(parseSleepGoal({ userId: userA, goalMinutes: 420, effectiveCivilDate: '2026-08-26' }));
  await assert.rejects(
    store.healthMetrics.insertSleepGoal(parseSleepGoal({ userId: userA, goalMinutes: 390, effectiveCivilDate: '2026-08-23' })),
    SleepGoalConflictError,
  );

  assert.equal(await store.healthMetrics.lookupSleepGoal({ userId: userA, civilDate: '2026-08-22' }), undefined);
  assert.equal((await store.healthMetrics.lookupSleepGoal({ userId: userA, civilDate: '2026-08-23' }))?.goalMinutes, 480);
  assert.equal((await store.healthMetrics.lookupSleepGoal({ userId: userA, civilDate: '2026-08-25' }))?.goalMinutes, 480);
  assert.equal((await store.healthMetrics.lookupSleepGoal({ userId: userA, civilDate: '2026-08-26' }))?.goalMinutes, 420);

  await store.healthMetrics.insertTimeZoneHistory({
    userId: userA,
    ianaTimeZone: 'Asia/Shanghai',
    effectiveAt: '2026-08-01T00:00:00.000Z',
    isBackfillAnchor: true,
  });
  await store.healthMetrics.insertTimeZoneHistory({
    userId: userA,
    ianaTimeZone: 'America/Los_Angeles',
    effectiveAt: '2026-08-20T12:00:00.000Z',
    isBackfillAnchor: false,
  });
  await assert.rejects(
    store.healthMetrics.insertTimeZoneHistory({
      userId: userA,
      ianaTimeZone: 'Europe/Paris',
      effectiveAt: '2026-08-01T00:00:00.000Z',
      isBackfillAnchor: false,
    }),
    TimeZoneHistoryConflictError,
  );

  assert.equal((await store.healthMetrics.lookupTimeZoneHistory({ userId: userA, at: '2026-08-10T00:00:00.000Z' }))?.ianaTimeZone, 'Asia/Shanghai');
  assert.equal((await store.healthMetrics.lookupTimeZoneHistory({ userId: userA, at: '2026-08-20T11:59:59.000Z' }))?.ianaTimeZone, 'Asia/Shanghai');
  assert.equal((await store.healthMetrics.lookupTimeZoneHistory({ userId: userA, at: '2026-08-20T12:00:00.000Z' }))?.ianaTimeZone, 'America/Los_Angeles');
  assert.deepEqual(
    (await store.healthMetrics.listTimeZoneHistory(userA)).map((row) => row.ianaTimeZone),
    ['Asia/Shanghai', 'America/Los_Angeles'],
  );
});

test('reindexes stored minutes in a UTC range without changing API offsets', async () => {
  const store = createMemoryStore();
  await seedUsers(store);
  await store.healthMetrics.upsertMinutes([
    minute({ userId: userA, minuteStartUtc: '2026-08-21T16:00:00.000Z', civilDate: '2026-08-22' }),
    minute({ userId: userA, minuteStartUtc: '2026-08-22T16:00:00.000Z', civilDate: '2026-08-23' }),
  ]);

  const inRange = await store.healthMetrics.listMinutesInRange({
    userId: userA,
    fromUtc: '2026-08-21T00:00:00.000Z',
    toUtcExclusive: '2026-08-22T00:00:00.000Z',
  });
  assert.equal(inRange.length, 1);
  assert.equal(inRange[0]?.minuteStartUtc, '2026-08-21T16:00:00.000Z');

  const updated = await store.healthMetrics.updateMinuteLocalAssociation({
    userId: userA,
    sourceFamily,
    minuteStartUtc: '2026-08-21T16:00:00.000Z',
    civilDate: '2026-08-22',
    ianaTimeZone: 'Asia/Shanghai',
    localMinuteOfDay: 0,
  });
  const after = await store.healthMetrics.listMinutesInRange({
    userId: userA,
    fromUtc: '2026-08-21T16:00:00.000Z',
    toUtcExclusive: '2026-08-21T16:01:00.000Z',
  });

  assert.equal(updated, true);
  assert.equal(after[0]?.ianaTimeZone, 'Asia/Shanghai');
  assert.equal(after[0]?.utcOffsetMinutes, 480);
  assert.equal(after[0]?.localMinuteOfDay, 0);
  assert.equal(
    (await store.healthMetrics.listMinutesInRange({ userId: userA, fromUtc: '2026-08-22T16:00:00.000Z' }))[0]?.ianaTimeZone,
    null,
  );
});

test('schedules a cursor retry without moving the successful watermark', async () => {
  const store = createMemoryStore();
  await seedUsers(store);
  const retryAt = new Date('2026-08-22T16:30:00.000Z');

  await store.healthMetrics.updateCursor({
    connectionId: connectionA,
    dataType: 'heart-rate',
    successfulWatermark: now,
    lastErrorCode: undefined,
    retryCount: 0,
    nextAttemptAt: undefined,
  });
  await store.healthMetrics.scheduleCursor({
    connectionId: connectionA,
    dataType: 'heart-rate',
    lastErrorCode: 'rate_limited',
    retryCount: 1,
    nextAttemptAt: retryAt,
  });

  const cursor = await store.healthMetrics.readCursor({ connectionId: connectionA, dataType: 'heart-rate' });
  assert.equal(cursor?.successfulWatermark?.toISOString(), now.toISOString());
  assert.equal(cursor?.lastErrorCode, 'rate_limited');
  assert.equal(cursor?.retryCount, 1);
  assert.deepEqual(
    (await store.healthMetrics.listDueCursors({ now: retryAt })).map((row) => row.connectionId),
    [connectionA],
  );
});

test('deleteForUser removes that user\'s minutes, intervals, daily rows, cursors, results, goals, and time zones', async () => {
  const store = createMemoryStore();
  await seedUsers(store);

  await store.healthMetrics.ingestWindow(windowWrite({
    activityLevelIntervals: [activity({ userId: userA })],
    heartRateZones: [heartRateZones({ userId: userA })],
    timeInZone: [timeInZone({ userId: userA })],
    exerciseIntervals: [exercise({ userId: userA })],
  }));
  await store.healthMetrics.insertSleepGoal(parseSleepGoal({ userId: userA, goalMinutes: 480, effectiveCivilDate: '2026-08-23' }));
  await store.healthMetrics.insertTimeZoneHistory({
    userId: userA,
    ianaTimeZone: 'Asia/Shanghai',
    effectiveAt: '2026-08-01T00:00:00.000Z',
    isBackfillAnchor: true,
  });
  await store.healthMetrics.upsertMinutes([minute({ userId: userB, avgBpm: 90 })]);
  await store.healthMetrics.insertSleepGoal(parseSleepGoal({ userId: userB, goalMinutes: 420, effectiveCivilDate: '2026-08-23' }));

  await store.healthMetrics.deleteForUser(userA);

  assert.equal((await store.healthMetrics.listMinutesByCivilDate({ userId: userA, civilDate })).length, 0);
  assert.equal((await store.healthMetrics.listActivityLevelIntervalsInRange({ userId: userA, fromUtc: '2026-08-22T00:00:00.000Z' })).length, 0);
  assert.equal(await store.healthMetrics.getHeartRateZones({ userId: userA, civilDate }), undefined);
  assert.equal(await store.healthMetrics.getTimeInZone({ userId: userA, civilDate }), undefined);
  assert.equal((await store.healthMetrics.listExerciseIntervalsInRange({ userId: userA, fromUtc: '2026-08-22T00:00:00.000Z' })).length, 0);
  assert.equal(await store.healthMetrics.getDailyCardio({ userId: userA, civilDate }), undefined);
  assert.equal((await store.healthMetrics.listMetricResults({ userId: userA, civilDate })).length, 0);
  assert.equal(await store.healthMetrics.readCursor({ connectionId: connectionA, dataType: 'heart-rate' }), undefined);
  assert.equal(await store.healthMetrics.lookupSleepGoal({ userId: userA, civilDate: '2026-08-23' }), undefined);
  assert.equal(await store.healthMetrics.lookupTimeZoneHistory({ userId: userA, at: '2026-08-22T00:00:00.000Z' }), undefined);
  assert.equal((await store.healthMetrics.listMinutesByCivilDate({ userId: userB, civilDate }))[0]?.avgBpm, 90);
  assert.equal((await store.healthMetrics.lookupSleepGoal({ userId: userB, civilDate: '2026-08-23' }))?.goalMinutes, 420);
});
