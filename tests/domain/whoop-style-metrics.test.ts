import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseDailyHeartRateZones,
  parseExerciseInterval,
  parseHeartRateMinuteAggregate,
  parseSleepGoal,
  sleepGoalEffectiveCivilDate,
  type HeartRateMinuteAggregate,
} from '../../src/domain/cardio-records';
import { parseDailyHrv, parseDailyRhr, parseSleepSession } from '../../src/domain/health-records';
import { METRIC_VERSION, WHOOP_STYLE_METRIC_VERSION } from '../../src/domain/metric-types';
import {
  computeRecovery,
  computeSleepPerformance,
  computeStrain,
  metricsAffectedByStrainRecompute,
} from '../../src/domain/whoop-style-metrics';

const userId = 'demo_user';
const sourceFamily = 'google-wearables' as const;
const date = '2026-08-22';

const orderedZones = parseDailyHeartRateZones({
  userId,
  sourceFamily,
  date,
  zones: {
    LIGHT: { minBeatsPerMinute: 100, maxBeatsPerMinute: 119 },
    MODERATE: { minBeatsPerMinute: 120, maxBeatsPerMinute: 139 },
    VIGOROUS: { minBeatsPerMinute: 140, maxBeatsPerMinute: 159 },
    PEAK: { minBeatsPerMinute: 160, maxBeatsPerMinute: 200 },
  },
});

function expectedStrain(light: number, moderate: number, vigorous: number, peak: number) {
  const dose = 0.5 * light + moderate + 2 * vigorous + 3 * peak;
  const strain = Math.round(Math.min(21, 21 * (1 - Math.exp(-dose / 140))) * 10) / 10;
  return { dose, strain };
}

function addCivilDays(civilDate: string, days: number): string {
  const next = new Date(`${civilDate}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function minute(overrides: Partial<HeartRateMinuteAggregate> & { localMinuteOfDay: number }): HeartRateMinuteAggregate {
  const { localMinuteOfDay, minuteStartUtc, ...rest } = overrides;
  return parseHeartRateMinuteAggregate({
    userId,
    sourceFamily,
    civilDate: date,
    utcOffsetMinutes: 0,
    ianaTimeZone: 'UTC',
    avgBpm: 70,
    minBpm: 70,
    maxBpm: 70,
    sampleCount: 10,
    coverageSeconds: 60,
    activityLevel: 'SEDENTARY',
    localMinuteOfDay,
    minuteStartUtc: minuteStartUtc ?? new Date(Date.parse(`${date}T00:00:00.000Z`) + localMinuteOfDay * 60_000).toISOString(),
    ...rest,
  });
}

function fillDay(options: {
  activityLevel?: HeartRateMinuteAggregate['activityLevel'];
  avgBpm?: number;
  ianaTimeZone?: string | null;
} = {}): HeartRateMinuteAggregate[] {
  return Array.from({ length: 1440 }, (_, localMinuteOfDay) =>
    minute({
      localMinuteOfDay,
      activityLevel: options.activityLevel ?? 'SEDENTARY',
      avgBpm: options.avgBpm ?? 70,
      minBpm: options.avgBpm ?? 70,
      maxBpm: options.avgBpm ?? 70,
      ianaTimeZone: options.ianaTimeZone === undefined ? 'UTC' : options.ianaTimeZone,
    }),
  );
}

function sleepOn(
  civilEndDate: string,
  overrides: Partial<{
    id: string;
    minutesAsleep: number;
    isNap: boolean;
    processed: boolean;
    startTime: string;
    endTime: string;
  }> = {},
) {
  return parseSleepSession({
    userId,
    source: 'google_health',
    sourceRecordId: `source-${civilEndDate}-${overrides.id ?? 'main'}`,
    id: overrides.id ?? `sleep-${civilEndDate}`,
    startTime: overrides.startTime ?? `${civilEndDate}T00:00:00.000Z`,
    endTime: overrides.endTime ?? `${civilEndDate}T08:00:00.000Z`,
    civilEndDate,
    utcOffsetMinutes: 0,
    minutesAsleep: overrides.minutesAsleep ?? 420,
    timeInBedMinutes: Math.max(450, overrides.minutesAsleep ?? 420),
    awakeMinutes: 30,
    awakeSegments: 1,
    isNap: overrides.isNap ?? false,
    processed: overrides.isNap ? (overrides.processed ?? true) : (overrides.processed ?? true),
  });
}

function priorField<T>(
  targetDate: string,
  count: number,
  build: (fieldDate: string, index: number) => T,
): T[] {
  return Array.from({ length: count }, (_, index) => build(addCivilDays(targetDate, -(index + 1)), index));
}

test('strain uses the frozen whoop-style-v2 dose curve', () => {
  const light = 20;
  const moderate = 10;
  const vigorous = 5;
  const peak = 2;
  const minutes = [
    ...Array.from({ length: light }, (_, index) => minute({ localMinuteOfDay: 600 + index, avgBpm: 110, minBpm: 110, maxBpm: 110, activityLevel: 'LIGHTLY_ACTIVE' })),
    ...Array.from({ length: moderate }, (_, index) => minute({ localMinuteOfDay: 700 + index, avgBpm: 130, minBpm: 130, maxBpm: 130, activityLevel: 'MODERATELY_ACTIVE' })),
    ...Array.from({ length: vigorous }, (_, index) => minute({ localMinuteOfDay: 800 + index, avgBpm: 150, minBpm: 150, maxBpm: 150, activityLevel: 'VERY_ACTIVE' })),
    ...Array.from({ length: peak }, (_, index) => minute({ localMinuteOfDay: 900 + index, avgBpm: 170, minBpm: 170, maxBpm: 170, activityLevel: 'VERY_ACTIVE' })),
  ];
  const expected = expectedStrain(light, moderate, vigorous, peak);
  const result = computeStrain({
    userId,
    date,
    minutes,
    zones: orderedZones,
    sleepSessions: [],
    exerciseIntervals: [],
    timezoneUnambiguous: true,
    isCurrentDay: false,
  });

  assert.equal(result.dose, expected.dose);
  assert.equal(result.score, expected.strain);
  assert.equal(result.metricVersion, WHOOP_STYLE_METRIC_VERSION);
  assert.equal(result.status, 'provisional');
  assert.ok(result.evidence.length > 0);
  assert.equal(result.source.heartRateZones, true);
  assert.equal(result.coverage.attributedMinutes, light + moderate + vigorous + peak);
  assert.equal(result.reason, null);
});

test('unknown context cannot complete a day or yield zero strain', () => {
  const result = computeStrain({
    userId,
    date,
    minutes: fillDay({ activityLevel: 'unknown', avgBpm: 70 }),
    zones: orderedZones,
    sleepSessions: [],
    exerciseIntervals: [],
    timezoneUnambiguous: true,
    isCurrentDay: false,
  });

  assert.notEqual(result.status, 'complete');
  assert.equal(result.score, null);
  assert.equal(result.kind, 'no_score');
  assert.ok(result.reason);
  assert.equal(result.coverage.knownContextMinutes, 0);
});

test('a fully known sedentary day yields 0.0 strain', () => {
  const result = computeStrain({
    userId,
    date,
    minutes: fillDay(),
    zones: orderedZones,
    sleepSessions: [],
    exerciseIntervals: [],
    timezoneUnambiguous: true,
    isCurrentDay: false,
  });

  assert.equal(result.status, 'complete');
  assert.equal(result.kind, 'score');
  assert.equal(result.score, 0.0);
  assert.equal(result.dose, 0);
  assert.equal(result.coverage.knownContextMinutes, 1440);
  assert.equal(result.metricVersion, 'whoop-style-v2');
});

test('a past incomplete day with attributed activity yields labeled provisional strain, not 0.0', () => {
  const result = computeStrain({
    userId,
    date,
    minutes: Array.from({ length: 40 }, (_, index) =>
      minute({
        localMinuteOfDay: 600 + index,
        avgBpm: 130,
        minBpm: 130,
        maxBpm: 130,
        activityLevel: 'MODERATELY_ACTIVE',
      }),
    ),
    zones: orderedZones,
    sleepSessions: [],
    exerciseIntervals: [],
    timezoneUnambiguous: true,
    isCurrentDay: false,
  });
  const expected = expectedStrain(0, 40, 0, 0);

  assert.equal(result.status, 'provisional');
  assert.equal(result.kind, 'score');
  assert.equal(result.score, expected.strain);
  assert.notEqual(result.score, 0);
  assert.notEqual(result.score, 0.0);
  assert.ok((result.score ?? 0) > 0);
});

test('current days stay in progress and exercise-only coverage can still be provisional', () => {
  const now = '2026-08-22T18:00:00.000Z';
  const inProgress = computeStrain({
    userId,
    date,
    minutes: fillDay(),
    zones: orderedZones,
    sleepSessions: [],
    exerciseIntervals: [],
    timezoneUnambiguous: true,
    isCurrentDay: true,
    now,
  });
  assert.equal(inProgress.status, 'provisional');
  assert.notEqual(inProgress.status, 'complete');

  const exerciseOnly = computeStrain({
    userId,
    date,
    minutes: [
      minute({
        localMinuteOfDay: 17 * 60 + 30,
        avgBpm: 150,
        minBpm: 150,
        maxBpm: 150,
        activityLevel: 'unknown',
      }),
    ],
    zones: orderedZones,
    sleepSessions: [],
    exerciseIntervals: [
      parseExerciseInterval({
        userId,
        sourceFamily,
        sourceRecordId: 'run-1',
        startTime: '2026-08-22T17:30:00.000Z',
        endTime: '2026-08-22T17:31:00.000Z',
        utcOffsetMinutes: 0,
        civilDate: date,
      }),
    ],
    timezoneUnambiguous: true,
    isCurrentDay: true,
    now,
  });
  assert.equal(exerciseOnly.status, 'provisional');
  assert.ok((exerciseOnly.score ?? 0) > 0);
  assert.equal(exerciseOnly.source.exercise, true);
  assert.equal(exerciseOnly.source.activityLevel, false);
});

test('sleep performance selects a confirmed goal, T+1 effective date, and no hardcoded 480-minute target', () => {
  const settingDate = '2026-08-20';
  const goal = parseSleepGoal({
    userId,
    goalMinutes: 390,
    effectiveCivilDate: sleepGoalEffectiveCivilDate(settingDate),
  });
  assert.equal(goal.effectiveCivilDate, '2026-08-21');

  const before = computeSleepPerformance({
    targetDate: '2026-08-20',
    sessions: [sleepOn('2026-08-20', { minutesAsleep: 390 })],
    goals: [goal],
    previousDayStrain: undefined,
  });
  assert.equal(before.kind, 'no_score');
  assert.equal(before.reason, 'sleep_goal_missing');
  assert.equal(before.metricVersion, WHOOP_STYLE_METRIC_VERSION);

  const debtDays = ['2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20'].map((civilEndDate) =>
    sleepOn(civilEndDate, { minutesAsleep: 390 }),
  );
  const scored = computeSleepPerformance({
    targetDate: '2026-08-21',
    sessions: [...debtDays, sleepOn('2026-08-21', { minutesAsleep: 390 })],
    goals: [goal],
    previousDayStrain: { status: 'complete', score: 0 },
  });
  assert.equal(scored.kind, 'score');
  assert.equal(scored.goalMinutes, 390);
  assert.equal(scored.needMinutes, 390);
  assert.equal(scored.score, 100);
  assert.notEqual(scored.needMinutes, 480);
  assert.notEqual(scored.score, Math.round(Math.min(100, (100 * 390) / 480)));
});

test('sleep debt walks 7 calendar days, counts a missing non-nap day as 0, and still includes a 179-minute night', () => {
  const goal = parseSleepGoal({
    userId,
    goalMinutes: 400,
    effectiveCivilDate: '2026-08-01',
  });
  const windowSessions = [
    sleepOn('2026-08-15', { minutesAsleep: 400 }),
    sleepOn('2026-08-16', { minutesAsleep: 90, isNap: true }),
    sleepOn('2026-08-17', { minutesAsleep: 179 }),
    sleepOn('2026-08-18', { minutesAsleep: 400 }),
    sleepOn('2026-08-19', { minutesAsleep: 400 }),
    sleepOn('2026-08-20', { minutesAsleep: 400 }),
    sleepOn('2026-08-21', { minutesAsleep: 400 }),
  ];
  const result = computeSleepPerformance({
    targetDate: date,
    sessions: [...windowSessions, sleepOn(date, { minutesAsleep: 400 })],
    goals: [goal],
    previousDayStrain: { status: 'complete', score: 0 },
  });

  assert.equal(result.debtMinutes, 400 + (400 - 179));
  assert.equal(result.sleepHistoryIncomplete, true);
  assert.equal(result.debtCompensationMinutes, 60);
  assert.equal(result.needMinutes, 460);
  assert.ok(result.evidence.some((item) => item.date === '2026-08-17' && item.value === 179));
  assert.ok(result.evidence.some((item) => item.date === '2026-08-16' && item.value === 0));
});

test('sleep target selection prefers the longest processed non-nap primary sleep', () => {
  const goal = parseSleepGoal({ userId, goalMinutes: 420, effectiveCivilDate: '2026-08-01' });
  const result = computeSleepPerformance({
    targetDate: date,
    sessions: [
      sleepOn(date, { id: 'nap', minutesAsleep: 500, isNap: true }),
      sleepOn(date, { id: 'short', minutesAsleep: 200 }),
      sleepOn(date, { id: 'unprocessed', minutesAsleep: 420, processed: false, startTime: `${date}T01:00:00.000Z` }),
      sleepOn(date, { id: 'processed', minutesAsleep: 420, processed: true, startTime: `${date}T02:00:00.000Z` }),
    ],
    goals: [goal],
    previousDayStrain: { status: 'incomplete', score: null },
  });

  assert.equal(result.minutesAsleep, 420);
  assert.equal(result.strainCompensationMinutes, 0);
  assert.ok(result.evidence.some((item) => item.value === 'processed' || String(item.value).includes('processed')));
});

test('complete previous-day strain cascades into the next local day sleep need and recovery', () => {
  assert.deepEqual(metricsAffectedByStrainRecompute('2026-08-21'), {
    strainDate: '2026-08-21',
    sleepPerformanceDate: date,
    recoveryDate: date,
  });

  const goal = parseSleepGoal({ userId, goalMinutes: 420, effectiveCivilDate: '2026-08-01' });
  const history = priorField(date, 7, (civilEndDate) => sleepOn(civilEndDate, { minutesAsleep: 420 }));
  const withStrain = computeSleepPerformance({
    targetDate: date,
    sessions: [...history, sleepOn(date, { minutesAsleep: 420 })],
    goals: [goal],
    previousDayStrain: { status: 'complete', score: 15 },
  });
  const withoutCompleteStrain = computeSleepPerformance({
    targetDate: date,
    sessions: [...history, sleepOn(date, { minutesAsleep: 420 })],
    goals: [goal],
    previousDayStrain: { status: 'provisional', score: 15 },
  });

  assert.equal(withStrain.strainCompensationMinutes, 25);
  assert.equal(withStrain.needMinutes, 445);
  assert.equal(withoutCompleteStrain.strainCompensationMinutes, 0);
  assert.equal(withoutCompleteStrain.needMinutes, 420);

  const recovery = computeRecovery({
    targetDate: date,
    hrv: parseDailyHrv({ userId, source: 'google_health', sourceRecordId: 'hrv-today', date, valueMs: 50 }),
    rhr: parseDailyRhr({ userId, source: 'google_health', sourceRecordId: 'rhr-today', date, valueBpm: 55 }),
    historicalHrv: priorField(date, 28, (fieldDate, index) =>
      parseDailyHrv({ userId, source: 'google_health', sourceRecordId: `hrv-${index}`, date: fieldDate, valueMs: 50 }),
    ),
    historicalRhr: priorField(date, 28, (fieldDate, index) =>
      parseDailyRhr({ userId, source: 'google_health', sourceRecordId: `rhr-${index}`, date: fieldDate, valueBpm: 55 }),
    ),
    sleep: withStrain,
    now: '2026-08-22T08:00:00.000Z',
    lastSuccessfulSyncAt: '2026-08-22T07:00:00.000Z',
  });
  assert.equal(recovery.kind, 'score');
  assert.equal(recovery.metricVersion, WHOOP_STYLE_METRIC_VERSION);
  assert.equal(recovery.quality, 'high');
  assert.equal(recovery.components.sleep?.value, withStrain.score);
});

test('recovery scores 7/28-day HRV and RHR MAD windows with a 2 ms HRV floor and even-n median', () => {
  const historicalHrv = [40, 42, 44, 46, 48, 50, 52, 54].map((valueMs, index) =>
    parseDailyHrv({
      userId,
      source: 'google_health',
      sourceRecordId: `hrv-${index}`,
      date: addCivilDays(date, -(index + 1)),
      valueMs,
    }),
  );
  const historicalRhr = [58, 59, 60, 61, 62, 63, 64, 65].map((valueBpm, index) =>
    parseDailyRhr({
      userId,
      source: 'google_health',
      sourceRecordId: `rhr-${index}`,
      date: addCivilDays(date, -(index + 1)),
      valueBpm,
    }),
  );
  const result = computeRecovery({
    targetDate: date,
    hrv: parseDailyHrv({ userId, source: 'google_health', sourceRecordId: 'hrv-today', date, valueMs: 47 }),
    rhr: parseDailyRhr({ userId, source: 'google_health', sourceRecordId: 'rhr-today', date, valueBpm: 61.5 }),
    historicalHrv,
    historicalRhr,
    sleep: {
      kind: 'no_score',
      score: null,
      reason: 'sleep_goal_missing',
      minutesAsleep: null,
      goalMinutes: null,
      needMinutes: null,
      debtMinutes: 0,
      debtCompensationMinutes: 0,
      strainCompensationMinutes: 0,
      sleepHistoryIncomplete: false,
      source: {
        heartRateZones: false,
        activityLevel: false,
        exercise: false,
        sleep: true,
        hrv: false,
        rhr: false,
        sleepGoal: false,
        timeZone: 'unambiguous',
      },
      coverage: { knownContextMinutes: 0, rawHeartRateMinutes: 0, attributedMinutes: 0, lastKnownContextAt: null },
      evidence: [],
      metricVersion: WHOOP_STYLE_METRIC_VERSION,
    },
    now: '2026-08-22T08:00:00.000Z',
    lastSuccessfulSyncAt: '2026-08-22T07:00:00.000Z',
  });

  function median(values: number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  }

  const hrvValues = [40, 42, 44, 46, 48, 50, 52, 54];
  const rhrValues = [58, 59, 60, 61, 62, 63, 64, 65];
  const hrvMedian = median(hrvValues);
  const hrvScale = Math.max(1.4826 * median(hrvValues.map((value) => Math.abs(value - hrvMedian))), 2);
  const hrvSub = Math.min(100, Math.max(0, 50 + (15 * (47 - hrvMedian)) / hrvScale));
  const rhrMedian = median(rhrValues);
  const rhrScale = Math.max(1.4826 * median(rhrValues.map((value) => Math.abs(value - rhrMedian))), 3);
  const rhrSub = Math.min(100, Math.max(0, 50 - (15 * (61.5 - rhrMedian)) / rhrScale));
  const expected = Math.round((0.4 * hrvSub + 0.3 * rhrSub) / 0.7);

  assert.equal(result.kind, 'score');
  assert.equal(result.score, expected);
  assert.equal(result.quality, 'provisional');
  assert.equal(result.components.hrv?.baseline, 47);
  assert.equal(result.reason, null);
  assert.equal(METRIC_VERSION, 'p1-v1');
});

test('HRV plus RHR recovery can score without sleep, and a 36-hour stale sync stays provisional rather than unavailable', () => {
  const identicalHrv = priorField(date, 8, (fieldDate, index) =>
    parseDailyHrv({ userId, source: 'google_health', sourceRecordId: `hrv-${index}`, date: fieldDate, valueMs: 50 }),
  );
  const identicalRhr = priorField(date, 8, (fieldDate, index) =>
    parseDailyRhr({ userId, source: 'google_health', sourceRecordId: `rhr-${index}`, date: fieldDate, valueBpm: 60 }),
  );
  const withoutSleep = computeRecovery({
    targetDate: date,
    hrv: parseDailyHrv({ userId, source: 'google_health', sourceRecordId: 'hrv-today', date, valueMs: 52 }),
    rhr: parseDailyRhr({ userId, source: 'google_health', sourceRecordId: 'rhr-today', date, valueBpm: 60 }),
    historicalHrv: identicalHrv,
    historicalRhr: identicalRhr,
    sleep: undefined,
    now: '2026-08-22T08:00:00.000Z',
    lastSuccessfulSyncAt: '2026-08-22T07:00:00.000Z',
  });
  assert.equal(withoutSleep.kind, 'score');
  assert.equal(withoutSleep.score, Math.round((0.4 * 65 + 0.3 * 50) / 0.7));
  assert.equal(withoutSleep.quality, 'provisional');
  assert.equal(withoutSleep.components.sleep, undefined);

  const stale = computeRecovery({
    targetDate: date,
    hrv: parseDailyHrv({ userId, source: 'google_health', sourceRecordId: 'hrv-today', date, valueMs: 50 }),
    rhr: parseDailyRhr({ userId, source: 'google_health', sourceRecordId: 'rhr-today', date, valueBpm: 55 }),
    historicalHrv: priorField(date, 28, (fieldDate, index) =>
      parseDailyHrv({ userId, source: 'google_health', sourceRecordId: `hrv-${index}`, date: fieldDate, valueMs: 50 }),
    ),
    historicalRhr: priorField(date, 28, (fieldDate, index) =>
      parseDailyRhr({ userId, source: 'google_health', sourceRecordId: `rhr-${index}`, date: fieldDate, valueBpm: 55 }),
    ),
    sleep: {
      kind: 'score',
      score: 100,
      reason: null,
      minutesAsleep: 420,
      goalMinutes: 420,
      needMinutes: 420,
      debtMinutes: 0,
      debtCompensationMinutes: 0,
      strainCompensationMinutes: 0,
      sleepHistoryIncomplete: false,
      source: {
        heartRateZones: false,
        activityLevel: false,
        exercise: false,
        sleep: true,
        hrv: false,
        rhr: false,
        sleepGoal: true,
        timeZone: 'unambiguous',
      },
      coverage: { knownContextMinutes: 0, rawHeartRateMinutes: 0, attributedMinutes: 0, lastKnownContextAt: null },
      evidence: [],
      metricVersion: WHOOP_STYLE_METRIC_VERSION,
    },
    now: '2026-08-24T08:00:00.000Z',
    lastSuccessfulSyncAt: '2026-08-22T19:00:00.000Z',
  });
  assert.equal(stale.kind, 'score');
  assert.equal(stale.quality, 'provisional');
  assert.notEqual(stale.quality, 'unavailable');
  assert.notEqual(stale.score, null);

  const insufficient = computeRecovery({
    targetDate: date,
    hrv: parseDailyHrv({ userId, source: 'google_health', sourceRecordId: 'hrv-today', date, valueMs: 50 }),
    rhr: undefined,
    historicalHrv: identicalHrv,
    historicalRhr: [],
    sleep: undefined,
    now: '2026-08-22T08:00:00.000Z',
    lastSuccessfulSyncAt: '2026-08-22T07:00:00.000Z',
  });
  assert.equal(insufficient.kind, 'no_score');
  assert.equal(insufficient.quality, 'unavailable');
  assert.equal(insufficient.reason, 'insufficient_recovery_components');
});
