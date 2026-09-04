import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeUsableLoad,
  computeWeeklyBuildBaseline,
  computeDailyTrimp,
  deriveQualifiedHeartRate,
  isQualifiedDay,
} from '../../src/domain/cardio-load-trimp';
import { CARDIO_LOAD_TRIMP_VERSION } from '../../src/domain/metric-types';

const at = (value: string) => `2026-09-04T${value}Z`;

test('uses an explicit version rather than overloading the legacy Strain version', () => {
  assert.equal(CARDIO_LOAD_TRIMP_VERSION, 'cardio-load-trimp-v3');
});

test('counts exactly thirty qualified seconds as half a minute of HRR-TRIMP', () => {
  const qualified = deriveQualifiedHeartRate({
    segments: [{ start: at('09:00:00'), end: at('09:01:00'), bpm: 100 }],
    activityIntervals: [{ start: at('09:00:15'), end: at('09:00:45') }],
    exerciseIntervals: [],
    sleepIntervals: [],
  });

  assert.equal(qualified.qualifiedSeconds, 30);
  assert.equal(qualified.avgBpm, 100);

  const result = computeDailyTrimp({
    sex: 'female',
    rhrBaseBpm: 50,
    hrMaxEstBpm: 150,
    qualified,
  });

  assert.equal(result.status, 'scored');
  assert.ok(result.dailyLoad !== null);
  assert.ok(Math.abs(result.dailyLoad - 0.369) < 0.002);
});

test('drops a qualifying intersection that is shorter than thirty seconds', () => {
  const qualified = deriveQualifiedHeartRate({
    segments: [{ start: at('09:00:00'), end: at('09:01:00'), bpm: 100 }],
    activityIntervals: [{ start: at('09:00:15'), end: at('09:00:44.999') }],
    exerciseIntervals: [],
    sleepIntervals: [],
  });

  assert.equal(qualified.qualifiedSeconds, 0);
  assert.equal(qualified.avgBpm, null);
});

test('counts separate qualified intersections when their total within one minute reaches thirty seconds', () => {
  const qualified = deriveQualifiedHeartRate({
    segments: [{ start: at('09:00:00'), end: at('09:01:00'), bpm: 100 }],
    activityIntervals: [
      { start: at('09:00:00'), end: at('09:00:20') },
      { start: at('09:00:40'), end: at('09:01:00') },
    ],
    exerciseIntervals: [],
    sleepIntervals: [],
  });

  assert.equal(qualified.qualifiedSeconds, 40);
  assert.equal(qualified.avgBpm, 100);
  const result = computeDailyTrimp({ sex: 'female', rhrBaseBpm: 50, hrMaxEstBpm: 150, qualified });
  assert.ok(result.dailyLoad !== null && Math.abs(result.dailyLoad - 0.492) < 0.002);
});

test('does not double count overlapping derived heart-rate evidence', () => {
  const qualified = deriveQualifiedHeartRate({
    segments: [
      { start: at('09:00:00'), end: at('09:00:40'), bpm: 100 },
      { start: at('09:00:20'), end: at('09:01:00'), bpm: 100 },
    ],
    activityIntervals: [{ start: at('09:00:00'), end: at('09:01:00') }],
    exerciseIntervals: [],
    sleepIntervals: [],
  });

  assert.equal(qualified.qualifiedSeconds, 60);
  const result = computeDailyTrimp({ sex: 'female', rhrBaseBpm: 50, hrMaxEstBpm: 150, qualified });
  assert.ok(result.dailyLoad !== null && Math.abs(result.dailyLoad - 0.738) < 0.002);
});

test('uses only the qualifying intersection when finding BPM', () => {
  const qualified = deriveQualifiedHeartRate({
    segments: [
      { start: at('09:00:00'), end: at('09:00:30'), bpm: 90 },
      { start: at('09:00:30'), end: at('09:01:00'), bpm: 130 },
    ],
    activityIntervals: [{ start: at('09:00:30'), end: at('09:01:00') }],
    exerciseIntervals: [],
    sleepIntervals: [],
  });

  assert.equal(qualified.qualifiedSeconds, 30);
  assert.equal(qualified.avgBpm, 130);
});

test('allows exercise to override a sleep interval for qualifying load', () => {
  const qualified = deriveQualifiedHeartRate({
    segments: [{ start: at('09:00:00'), end: at('09:01:00'), bpm: 100 }],
    activityIntervals: [],
    exerciseIntervals: [{ start: at('09:00:30'), end: at('09:01:00') }],
    sleepIntervals: [{ start: at('09:00:00'), end: at('09:01:00') }],
  });

  assert.equal(qualified.qualifiedSeconds, 30);
  assert.equal(qualified.avgBpm, 100);
});

test('sums the non-linear TRIMP contribution of each qualified BPM segment', () => {
  const qualified = deriveQualifiedHeartRate({
    segments: [
      { start: at('09:00:00'), end: at('09:00:30'), bpm: 90 },
      { start: at('09:00:30'), end: at('09:01:00'), bpm: 130 },
    ],
    activityIntervals: [{ start: at('09:00:00'), end: at('09:01:00') }],
    exerciseIntervals: [],
    sleepIntervals: [],
  });

  const result = computeDailyTrimp({
    sex: 'female',
    rhrBaseBpm: 50,
    hrMaxEstBpm: 150,
    qualified,
  });

  assert.equal(result.status, 'scored');
  assert.ok(result.dailyLoad !== null);
  assert.ok(Math.abs(result.dailyLoad - 1.223) < 0.003);
});

test('applies the HRR threshold and sex-specific Banister constant', () => {
  const justAtThreshold = deriveQualifiedHeartRate({
    segments: [{ start: at('09:00:00'), end: at('09:01:00'), bpm: 80 }],
    activityIntervals: [{ start: at('09:00:00'), end: at('09:01:00') }],
    exerciseIntervals: [],
    sleepIntervals: [],
  });
  const belowThreshold = deriveQualifiedHeartRate({
    segments: [{ start: at('09:00:00'), end: at('09:01:00'), bpm: 79.9 }],
    activityIntervals: [{ start: at('09:00:00'), end: at('09:01:00') }],
    exerciseIntervals: [],
    sleepIntervals: [],
  });

  const female = computeDailyTrimp({ sex: 'female', rhrBaseBpm: 50, hrMaxEstBpm: 150, qualified: justAtThreshold });
  const male = computeDailyTrimp({ sex: 'male', rhrBaseBpm: 50, hrMaxEstBpm: 150, qualified: justAtThreshold });
  const under = computeDailyTrimp({ sex: 'female', rhrBaseBpm: 50, hrMaxEstBpm: 150, qualified: belowThreshold });

  assert.ok(female.dailyLoad !== null && male.dailyLoad !== null);
  assert.ok(male.dailyLoad > female.dailyLoad);
  assert.equal(under.dailyLoad, 0);
});

test('rejects an invalid HR reserve instead of manufacturing a daily score', () => {
  const qualified = deriveQualifiedHeartRate({
    segments: [{ start: at('09:00:00'), end: at('09:01:00'), bpm: 100 }],
    activityIntervals: [{ start: at('09:00:00'), end: at('09:01:00') }],
    exerciseIntervals: [],
    sleepIntervals: [],
  });

  assert.deepEqual(
    computeDailyTrimp({ sex: 'female', rhrBaseBpm: 70, hrMaxEstBpm: 70, qualified }),
    { status: 'invalid_hr_reserve', dailyLoad: null },
  );
});

test('marks a day qualified only when HR covers the waking window without a gap over four hours', () => {
  const result = isQualifiedDay({
    ianaTimeZone: 'UTC',
    localDayStart: at('00:00:00'),
    localDayEnd: at('23:59:59.999'),
    previousMainSleepEnd: at('06:00:00'),
    nextMainSleepStart: at('22:00:00'),
    observedIntervals: [{ start: at('06:00:00'), end: at('18:00:00') }],
  });

  assert.equal(result.status, 'qualified');
  assert.equal(result.hrCoverageSeconds, 12 * 60 * 60);
  assert.equal(result.awakeCoverageRatio, 0.75);
});

test('does not qualify a day with a waking HR gap longer than four hours', () => {
  const result = isQualifiedDay({
    ianaTimeZone: 'UTC',
    localDayStart: at('00:00:00'),
    localDayEnd: at('23:59:59.999'),
    previousMainSleepEnd: at('06:00:00'),
    nextMainSleepStart: at('22:00:00'),
    observedIntervals: [{ start: at('06:00:00'), end: at('17:59:59') }],
  });

  assert.equal(result.status, 'insufficient_coverage');
  assert.equal(result.reason, 'waking_gap_exceeds_four_hours');
});

test('does not qualify a day when awake coverage is below seventy percent', () => {
  const result = isQualifiedDay({
    ianaTimeZone: 'UTC',
    localDayStart: at('00:00:00'),
    localDayEnd: at('23:59:59.999'),
    previousMainSleepEnd: at('05:00:00'),
    nextMainSleepStart: at('23:00:00'),
    observedIntervals: [
      { start: at('05:00:00'), end: at('09:00:00') },
      { start: at('12:00:00'), end: at('16:00:00') },
      { start: at('19:00:00'), end: at('23:00:00') },
    ],
  });

  assert.equal(result.status, 'insufficient_coverage');
  assert.equal(result.reason, 'awake_coverage_not_met');
});

test('keeps raw-day coverage separate from waking coverage', () => {
  const result = isQualifiedDay({
    ianaTimeZone: 'UTC',
    localDayStart: at('00:00:00'),
    localDayEnd: at('23:59:59.999'),
    previousMainSleepEnd: at('06:00:00'),
    nextMainSleepStart: at('22:00:00'),
    observedIntervals: [{ start: at('00:00:00'), end: at('12:00:00') }],
  });

  assert.equal(result.hrCoverageSeconds, 12 * 60 * 60);
  assert.equal(result.status, 'insufficient_coverage');
  assert.equal(result.reason, 'waking_gap_exceeds_four_hours');
});

test('uses four continuous complete weeks for the higher RM4 or EWMA build baseline', () => {
  const result = computeWeeklyBuildBaseline({
    targetWeekStart: '2026-09-07',
    completedWeeks: [
      { weekStart: '2026-08-10', qualifiedDayCount: 7, weeklyLoad: 10 },
      { weekStart: '2026-08-17', qualifiedDayCount: 7, weeklyLoad: 20 },
      { weekStart: '2026-08-24', qualifiedDayCount: 7, weeklyLoad: 30 },
      { weekStart: '2026-08-31', qualifiedDayCount: 7, weeklyLoad: 40 },
    ],
    priorStableBaseline: null,
    priorWeekEwma: null,
  });

  assert.deepEqual(result, {
    status: 'stable',
    rm4: 25,
    ewma4: 25,
    baseline: 25,
    reason: null,
  });
});

test('freezes a prior stable weekly baseline rather than joining across a missing week', () => {
  const result = computeWeeklyBuildBaseline({
    targetWeekStart: '2026-09-07',
    completedWeeks: [
      { weekStart: '2026-08-10', qualifiedDayCount: 7, weeklyLoad: 10 },
      { weekStart: '2026-08-17', qualifiedDayCount: 7, weeklyLoad: 20 },
      { weekStart: '2026-08-31', qualifiedDayCount: 7, weeklyLoad: 40 },
    ],
    priorStableBaseline: 31.5,
    priorWeekEwma: 31.5,
  });

  assert.deepEqual(result, {
    status: 'frozen',
    rm4: null,
    ewma4: null,
    baseline: 31.5,
    reason: 'four_continuous_qualified_weeks_required',
  });
});

test('updates EWMA only after the first four-week baseline has been established', () => {
  const result = computeWeeklyBuildBaseline({
    targetWeekStart: '2026-09-14',
    completedWeeks: [
      { weekStart: '2026-08-17', qualifiedDayCount: 7, weeklyLoad: 20 },
      { weekStart: '2026-08-24', qualifiedDayCount: 7, weeklyLoad: 30 },
      { weekStart: '2026-08-31', qualifiedDayCount: 7, weeklyLoad: 40 },
      { weekStart: '2026-09-07', qualifiedDayCount: 7, weeklyLoad: 50 },
    ],
    priorStableBaseline: 25,
    priorWeekEwma: 25,
  });

  assert.deepEqual(result, {
    status: 'stable',
    rm4: 35,
    ewma4: 35,
    baseline: 35,
    reason: null,
  });
});

function priorHistory() {
  return Array.from({ length: 28 }, (_, index) => {
    const day = String(index + 1).padStart(2, '0');
    if (index < 10) {
      return { civilDate: `2026-08-${day}`, dailyLoad: 10, qualifiedDay: true, recoveryScore: 20, recoveryQuality: 'high' as const };
    }
    if (index < 19) {
      return { civilDate: `2026-08-${day}`, dailyLoad: 20, qualifiedDay: true, recoveryScore: 60, recoveryQuality: 'medium' as const };
    }
    return { civilDate: `2026-08-${day}`, dailyLoad: 30, qualifiedDay: true, recoveryScore: 90, recoveryQuality: 'high' as const };
  });
}

test('uses a reliable low-recovery tier without adding a made-up penalty', () => {
  const result = computeUsableLoad({
    targetCivilDate: '2026-09-04',
    targetRecovery: { score: 20, quality: 'high' },
    history: priorHistory(),
  });

  assert.deepEqual(result, {
    status: 'scored',
    usableLoad: 10,
    recoveryTier: 'low',
    tierSampleCount: 10,
    globalP90: 30,
    tierP80: 10,
    reason: null,
  });
});

test('does not adapt usable load when the current recovery data is provisional', () => {
  const result = computeUsableLoad({
    targetCivilDate: '2026-09-04',
    targetRecovery: { score: 20, quality: 'provisional' },
    history: priorHistory(),
  });

  assert.deepEqual(result, {
    status: 'calibrating',
    usableLoad: null,
    recoveryTier: null,
    tierSampleCount: 0,
    globalP90: 30,
    tierP80: null,
    reason: 'target_recovery_not_high_quality',
  });
});

test('uses the global cap without a forced recovery penalty when recovery terciles collapse', () => {
  const history = Array.from({ length: 28 }, (_, index) => ({
    civilDate: `2026-08-${String(index + 1).padStart(2, '0')}`,
    dailyLoad: index + 1,
    qualifiedDay: true,
    recoveryScore: 50,
    recoveryQuality: 'high' as const,
  }));

  const result = computeUsableLoad({
    targetCivilDate: '2026-09-04',
    targetRecovery: { score: 50, quality: 'high' },
    history,
  });

  assert.deepEqual(result, {
    status: 'calibrating',
    usableLoad: 26,
    recoveryTier: 'unadjusted',
    tierSampleCount: 28,
    globalP90: 26,
    tierP80: null,
    reason: 'recovery_tiers_indistinguishable',
  });
});

test('marks a global P90 fallback as calibrating when the matching recovery tier has fewer than seven samples', () => {
  const history = Array.from({ length: 28 }, (_, index) => ({
    civilDate: `2026-08-${String(index + 1).padStart(2, '0')}`,
    dailyLoad: index + 1,
    qualifiedDay: true,
    recoveryScore: index < 10 ? 10 : index < 22 ? 50 : 90,
    recoveryQuality: 'high' as const,
  }));

  const result = computeUsableLoad({
    targetCivilDate: '2026-09-04',
    targetRecovery: { score: 90, quality: 'high' },
    history,
  });

  assert.equal(result.status, 'calibrating');
  assert.equal(result.recoveryTier, 'high');
  assert.equal(result.tierSampleCount, 6);
  assert.equal(result.usableLoad, result.globalP90);
  assert.equal(result.reason, 'recovery_tier_insufficient');
});

test('keeps usable load in calibration until twenty-eight strict prior qualified days exist', () => {
  const result = computeUsableLoad({
    targetCivilDate: '2026-09-04',
    targetRecovery: { score: 20, quality: 'high' },
    history: priorHistory().slice(0, 27),
  });

  assert.equal(result.status, 'calibrating');
  assert.equal(result.reason, 'insufficient_historical_days');
  assert.equal(result.usableLoad, null);
});
