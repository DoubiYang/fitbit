import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPrimarySleepCandidate,
  parseDailyHrv,
  parseDailyRhr,
  parseSleepSession,
  parseTrainingDay,
} from '../../src/domain/health-records';

const baseRecord = {
  userId: 'demo_user',
  source: 'google_health' as const,
  sourceRecordId: 'record-1',
};

test('preserves civil sleep date and UTC offset', () => {
  const sleep = parseSleepSession({
    ...baseRecord,
    id: 'sleep-1',
    startTime: '2026-08-21T15:30:00.000Z',
    endTime: '2026-08-21T23:00:00.000Z',
    civilEndDate: '2026-08-22',
    utcOffsetMinutes: 480,
    minutesAsleep: 405,
    timeInBedMinutes: 450,
    awakeMinutes: 45,
    awakeSegments: 2,
    isNap: false,
    processed: true,
  });

  assert.equal(sleep.civilEndDate, '2026-08-22');
  assert.equal(sleep.utcOffsetMinutes, 480);
});

test('never treats a nap as a primary-sleep candidate', () => {
  const nap = parseSleepSession({
    ...baseRecord,
    id: 'sleep-2',
    startTime: '2026-08-22T05:00:00.000Z',
    endTime: '2026-08-22T09:00:00.000Z',
    civilEndDate: '2026-08-22',
    utcOffsetMinutes: 480,
    minutesAsleep: 210,
    isNap: true,
    processed: true,
  });

  assert.equal(isPrimarySleepCandidate(nap), false);
});

test('rejects out-of-range daily HRV and resting heart rate', () => {
  assert.throws(() => parseDailyHrv({ ...baseRecord, date: '2026-08-22', valueMs: 0 }));
  assert.throws(() => parseDailyRhr({ ...baseRecord, date: '2026-08-22', valueBpm: 250 }));
});

test('requires opaque user identity and source identity for health records', () => {
  assert.throws(() =>
    parseDailyHrv({
      ...baseRecord,
      userId: '',
      date: '2026-08-22',
      valueMs: 42,
    }),
  );
  assert.throws(() =>
    parseDailyHrv({
      userId: 'demo_user',
      source: 'google_health',
      sourceRecordId: '',
      date: '2026-08-22',
      valueMs: 42,
    }),
  );
});

test('does not convert an unknown training day into zero load', () => {
  const unknownDay = parseTrainingDay({
    userId: 'demo_user',
    date: '2026-08-22',
    completeness: 'unknown',
    load: null,
  });

  assert.equal(unknownDay.completeness, 'unknown');
  assert.equal(unknownDay.load, null);
  assert.throws(() =>
    parseTrainingDay({
      userId: 'demo_user',
      date: '2026-08-22',
      completeness: 'unknown',
      load: 0,
    }),
  );
});
