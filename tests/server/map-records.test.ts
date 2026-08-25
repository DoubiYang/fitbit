import assert from 'node:assert/strict';
import test from 'node:test';

import { mapDailyHrv, mapDailyRhr, mapSleepSession, mapTrainingDays } from '../../src/server/health/map-records';

const userId = 'user-1';

test('does not treat a sleep interval without actual asleep minutes as a sleep record', () => {
  const session = mapSleepSession(
    {
      dataPointName: 'users/1/dataTypes/sleep/dataPoints/abc',
      sleep: {
        type: 'STAGES',
        interval: {
          startTime: '2026-08-23T17:35:00Z',
          endTime: '2026-08-24T01:08:00Z',
          endUtcOffset: '28800s',
        },
        stages: [{ type: 'AWAKE' }, { type: 'LIGHT' }],
      },
    },
    userId,
  );
  assert.equal(session, undefined);
});

test('maps a staged sleep session into the owned sleep record', () => {
  const session = mapSleepSession(
    {
      name: 'users/1/dataTypes/sleep/dataPoints/abc',
      sleep: {
        type: 'STAGES',
        interval: {
          startTime: '2026-08-23T21:00:00Z',
          endTime: '2026-08-24T05:30:00Z',
          endUtcOffset: '28800s',
          civilEndTime: { date: { year: 2026, month: 8, day: 24 } },
        },
        metadata: { nap: false, processed: true },
        stages: [{ type: 'LIGHT' }, { type: 'AWAKE' }, { type: 'DEEP' }],
        summary: { minutesAsleep: '420', minutesInSleepPeriod: '510', minutesAwake: '90' },
      },
    },
    userId,
  );
  assert.equal(session?.civilEndDate, '2026-08-24');
  assert.equal(session?.minutesAsleep, 420);
  assert.equal(session?.utcOffsetMinutes, 480);
  assert.equal(session?.processed, true);
  assert.equal(session?.isNap, false);
  assert.equal(session?.awakeSegments, 1);
});

test('uses Google sleep nap and processing metadata instead of inferring them from duration and type', () => {
  const session = mapSleepSession(
    {
      name: 'users/1/dataTypes/sleep/dataPoints/metadata',
      sleep: {
        type: 'STAGES',
        interval: {
          startTime: '2026-08-23T21:00:00Z',
          endTime: '2026-08-24T05:30:00Z',
          endUtcOffset: '28800s',
          civilEndTime: { date: { year: 2026, month: 8, day: 24 } },
        },
        metadata: { nap: true, processed: false },
        summary: { minutesAsleep: '420' },
      },
    },
    userId,
  );

  assert.equal(session?.isNap, true);
  assert.equal(session?.processed, false);
});

test('maps daily HRV and RHR values', () => {
  const hrv = mapDailyHrv(
    {
      name: 'users/1/dataTypes/daily-heart-rate-variability/dataPoints/a',
      dailyHeartRateVariability: { date: { year: 2026, month: 8, day: 24 }, averageHeartRateVariabilityMilliseconds: 48 },
    },
    userId,
  );
  const rhr = mapDailyRhr(
    {
      name: 'users/1/dataTypes/daily-resting-heart-rate/dataPoints/b',
      dailyRestingHeartRate: { date: { year: 2026, month: 8, day: 24 }, beatsPerMinute: '56' },
    },
    userId,
  );
  assert.equal(hrv?.valueMs, 48);
  assert.equal(rhr?.valueBpm, 56);
});

test('sums exercise zone load by civil start date', () => {
  const days = mapTrainingDays(
    [
      {
        name: 'ex-1',
        exercise: {
          interval: {
            startTime: '2026-08-24T01:00:00Z',
            endTime: '2026-08-24T01:40:00Z',
            civilStartTime: { date: { year: 2026, month: 8, day: 24 } },
          },
          metricsSummary: { heartRateZoneDurations: { lightTime: '600s', moderateTime: '1200s', vigorousTime: '300s', peakTime: '0s' } },
        },
      },
    ],
    userId,
  );
  assert.equal(days.length, 1);
  assert.equal(days[0]?.date, '2026-08-24');
  assert.equal(days[0]?.completeness, 'complete');
  assert.ok((days[0]?.load ?? 0) > 0);
});

test('marks successful exercise query coverage with no sessions as confirmed zero load', () => {
  const days = mapTrainingDays([], userId, ['2026-08-23', '2026-08-24']);

  assert.deepEqual(
    days.map((day) => ({ date: day.date, completeness: day.completeness, load: day.load })),
    [
      { date: '2026-08-23', completeness: 'complete', load: 0 },
      { date: '2026-08-24', completeness: 'complete', load: 0 },
    ],
  );
});

test('keeps a date unknown when a successful exercise query contains an unscorable session', () => {
  const days = mapTrainingDays(
    [
      {
        name: 'ex-unscorable',
        exercise: {
          interval: {
            startTime: '2026-08-24T01:00:00Z',
            endTime: '2026-08-24T01:40:00Z',
            civilStartTime: { date: { year: 2026, month: 8, day: 24 } },
          },
        },
      },
    ],
    userId,
    ['2026-08-24'],
  );

  assert.deepEqual(days.map((day) => ({ date: day.date, completeness: day.completeness, load: day.load })), [
    { date: '2026-08-24', completeness: 'unknown', load: null },
  ]);
});
