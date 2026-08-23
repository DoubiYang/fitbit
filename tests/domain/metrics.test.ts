import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDailyHrv, parseDailyRhr, parseSleepSession } from '../../src/domain/health-records';
import {
  computeRecoverySignal,
  computeSessionLoad,
  computeSleepCompleteness,
  computeTrainingBalance,
  selectPrimarySleepSession,
} from '../../src/domain/metrics';

const userId = 'demo_user';

function dateBefore(targetDate: string, days: number): string {
  const target = new Date(`${targetDate}T00:00:00.000Z`);
  target.setUTCDate(target.getUTCDate() - days);
  return target.toISOString().slice(0, 10);
}

function sleepOn(
  civilEndDate: string,
  overrides: Partial<{
    id: string;
    minutesAsleep: number;
    timeInBedMinutes: number;
    awakeMinutes: number;
    awakeSegments: number;
    isNap: boolean;
    processed: boolean;
    startTime: string;
  }> = {},
) {
  return parseSleepSession({
    userId,
    source: 'google_health',
    sourceRecordId: `source-${civilEndDate}-${overrides.id ?? 'main'}`,
    id: overrides.id ?? `sleep-${civilEndDate}`,
    startTime: overrides.startTime ?? `${civilEndDate}T15:00:00.000Z`,
    endTime: `${civilEndDate}T23:00:00.000Z`,
    civilEndDate,
    utcOffsetMinutes: 480,
    minutesAsleep: overrides.minutesAsleep ?? 420,
    timeInBedMinutes: overrides.timeInBedMinutes ?? 450,
    awakeMinutes: overrides.awakeMinutes ?? 30,
    awakeSegments: overrides.awakeSegments ?? 2,
    isNap: overrides.isNap ?? false,
    processed: overrides.processed ?? true,
  });
}

function priorSleeps(targetDate: string, count: number) {
  return Array.from({ length: count }, (_, index) => sleepOn(dateBefore(targetDate, index + 1)));
}

function priorHrv(targetDate: string, count: number, valueMs = 50) {
  return Array.from({ length: count }, (_, index) =>
    parseDailyHrv({
      userId,
      source: 'google_health',
      sourceRecordId: `hrv-${index}`,
      date: dateBefore(targetDate, index + 1),
      valueMs,
    }),
  );
}

function priorRhr(targetDate: string, count: number, valueBpm = 55) {
  return Array.from({ length: count }, (_, index) =>
    parseDailyRhr({
      userId,
      source: 'google_health',
      sourceRecordId: `rhr-${index}`,
      date: dateBefore(targetDate, index + 1),
      valueBpm,
    }),
  );
}

test('selects the processed primary sleep after duration ties', () => {
  const targetDate = '2026-08-22';
  const selected = selectPrimarySleepSession(
    [
      sleepOn(targetDate, { id: 'nap', minutesAsleep: 500, timeInBedMinutes: 510, isNap: true }),
      sleepOn(targetDate, { id: 'short', minutesAsleep: 390 }),
      sleepOn(targetDate, { id: 'unprocessed', minutesAsleep: 420, processed: false }),
      sleepOn(targetDate, { id: 'processed', minutesAsleep: 420, processed: true }),
    ],
    targetDate,
  );

  assert.equal(selected?.id, 'processed');
});

test('returns a calibrating partial sleep score before regularity has 14 historical sleeps', () => {
  const targetDate = '2026-08-22';
  const result = computeSleepCompleteness({
    target: sleepOn(targetDate),
    historicalPrimarySleeps: priorSleeps(targetDate, 13),
    sleepGoalMinutes: 480,
  });

  assert.equal(result.kind, 'score');
  assert.equal(result.quality, 'calibrating');
  assert.equal(result.components.regularity, undefined);
  assert.ok((result.score ?? 0) > 0);
});

test('withholds sleep score when the user has not confirmed a sleep goal', () => {
  const result = computeSleepCompleteness({
    target: sleepOn('2026-08-22'),
    historicalPrimarySleeps: priorSleeps('2026-08-22', 14),
    sleepGoalMinutes: undefined,
  });

  assert.equal(result.kind, 'no_score');
  assert.equal(result.reason, 'sleep_goal_missing');
});

test('excludes the target day from recovery baselines and uses available components', () => {
  const targetDate = '2026-08-22';
  const sleep = computeSleepCompleteness({
    target: sleepOn(targetDate),
    historicalPrimarySleeps: priorSleeps(targetDate, 14),
    sleepGoalMinutes: 480,
  });
  const result = computeRecoverySignal({
    targetDate,
    hrv: parseDailyHrv({
      userId,
      source: 'google_health',
      sourceRecordId: 'today-hrv',
      date: targetDate,
      valueMs: 200,
    }),
    rhr: parseDailyRhr({
      userId,
      source: 'google_health',
      sourceRecordId: 'today-rhr',
      date: targetDate,
      valueBpm: 58,
    }),
    historicalHrv: priorHrv(targetDate, 14),
    historicalRhr: priorRhr(targetDate, 14),
    sleep,
    now: '2026-08-22T08:00:00.000Z',
    lastSuccessfulSyncAt: '2026-08-22T07:00:00.000Z',
  });

  assert.equal(result.kind, 'score');
  assert.equal(result.components.hrv?.baseline, 50);
  assert.equal(result.quality, 'medium');
});

test('does not fabricate recovery when fewer than two components are usable', () => {
  const targetDate = '2026-08-22';
  const sleep = computeSleepCompleteness({
    target: sleepOn(targetDate),
    historicalPrimarySleeps: priorSleeps(targetDate, 13),
    sleepGoalMinutes: 480,
  });
  const result = computeRecoverySignal({
    targetDate,
    hrv: parseDailyHrv({
      userId,
      source: 'google_health',
      sourceRecordId: 'today-hrv',
      date: targetDate,
      valueMs: 50,
    }),
    rhr: undefined,
    historicalHrv: priorHrv(targetDate, 13),
    historicalRhr: [],
    sleep,
    now: '2026-08-22T08:00:00.000Z',
    lastSuccessfulSyncAt: '2026-08-22T07:00:00.000Z',
  });

  assert.equal(result.kind, 'no_score');
  assert.equal(result.reason, 'insufficient_recovery_components');
});

test('prefers zone summaries for session load and withholds an immature balance ratio', () => {
  const sessionLoad = computeSessionLoad({
    id: 'exercise-1',
    durationMinutes: 45,
    zoneMinutes: { light: 10, moderate: 10, vigorous: 5, peak: 0 },
  });

  assert.equal(sessionLoad.source, 'zone_summary');
  assert.equal(sessionLoad.load, 60);

  const targetDate = '2026-08-22';
  const balance = computeTrainingBalance(
    Array.from({ length: 12 }, (_, index) => ({
      userId,
      date: dateBefore(targetDate, index),
      completeness: 'complete' as const,
      load: index % 2 === 0 ? 30 : 0,
    })),
    targetDate,
  );

  assert.equal(balance.kind, 'no_score');
  assert.equal(balance.reason, 'training_baseline_calibrating');
});
