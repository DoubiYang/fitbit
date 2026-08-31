import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyHeartRateZone,
  parseHeartRateMinuteAggregate,
  type ActivityLevelInterval,
  type HeartRateMinuteAggregate,
} from '../../src/domain/cardio-records';
import { assignActivityLevel, computeStrain, type AggregatedHeartRateMinute } from '../../src/domain/whoop-style-metrics';
import {
  mapActivityLevelIntervals,
  mapDailyHeartRateZones,
  mapExerciseInterval,
  mapHeartRatePageToMinutes,
  mapHeartRateSamples,
  mapTimeInZoneIntervals,
  sumDailyTimeInZone,
} from '../../src/server/health/cardio-map';
import { mapSleepSession, type GoogleDataPoint } from '../../src/server/health/map-records';

const userId = 'user-1';

const ZONE_JSON = `{
  "dailyHeartRateZones": {
    "date": { "year": 2026, "month": 8, "day": 22 },
    "heartRateZones": [
      { "heartRateZoneType": "LIGHT", "minBeatsPerMinute": "97", "maxBeatsPerMinute": "116" },
      { "heartRateZoneType": "MODERATE", "minBeatsPerMinute": "117", "maxBeatsPerMinute": "136" },
      { "heartRateZoneType": "VIGOROUS", "minBeatsPerMinute": "137", "maxBeatsPerMinute": "155" },
      { "heartRateZoneType": "PEAK", "minBeatsPerMinute": "156", "maxBeatsPerMinute": "200" }
    ]
  }
}`;

function parsePoints(json: string): GoogleDataPoint[] {
  return JSON.parse(json) as GoogleDataPoint[];
}

function parsePoint(json: string): GoogleDataPoint {
  return JSON.parse(json) as GoogleDataPoint;
}

function withActivityLevel(
  minutes: AggregatedHeartRateMinute[],
  intervals: ActivityLevelInterval[],
): HeartRateMinuteAggregate[] {
  return minutes.map((minute) =>
    parseHeartRateMinuteAggregate({
      userId: minute.userId,
      sourceFamily: minute.sourceFamily,
      minuteStartUtc: minute.minuteStartUtc,
      civilDate: minute.civilDate,
      utcOffsetMinutes: minute.utcOffsetMinutes,
      ianaTimeZone: minute.ianaTimeZone,
      localMinuteOfDay: minute.localMinuteOfDay,
      avgBpm: minute.avgBpm,
      minBpm: minute.minBpm,
      maxBpm: minute.maxBpm,
      sampleCount: minute.sampleCount,
      coverageSeconds: minute.coverageSeconds,
      activityLevel: assignActivityLevel(minute.minuteStartUtc, intervals),
    }),
  );
}

test('sorts a newest-first Google heart-rate page ascending before aggregating minutes', () => {
  const points = parsePoints(`[
    {"heartRate":{"sampleTime":{"physicalTime":"2026-08-31T16:00:20.000Z","utcOffset":"28800s","civilTime":{"date":{"year":2026,"month":9,"day":1}}},"beatsPerMinute":"82"}},
    {"heartRate":{"sampleTime":{"physicalTime":"2026-08-31T16:00:10.000Z","utcOffset":"28800s","civilTime":{"date":{"year":2026,"month":9,"day":1}}},"beatsPerMinute":"80"}},
    {"heartRate":{"sampleTime":{"physicalTime":"2026-08-31T16:00:00.000Z","utcOffset":"28800s","civilTime":{"date":{"year":2026,"month":9,"day":1}}},"beatsPerMinute":"78"}}
  ]`);
  const originalOrder = points.map((point) => point.heartRate?.sampleTime?.physicalTime);

  const minutes = mapHeartRatePageToMinutes({
    userId,
    points,
    closeAt: '2026-08-31T16:00:40.000Z',
  });

  assert.deepEqual(
    points.map((point) => point.heartRate?.sampleTime?.physicalTime),
    originalOrder,
  );
  assert.equal(minutes.length, 1);
  assert.equal(minutes[0]?.minuteStartUtc, '2026-08-31T16:00:00.000Z');
  assert.equal(minutes[0]?.coverageSeconds, 40);
  assert.equal(minutes[0]?.avgBpm, 80.5);
  assert.equal(minutes[0]?.sourceFamily, 'google-wearables');
  assert.equal(minutes[0]?.ianaTimeZone, null);
});

test('preserves each sample utcOffset and derived civil date', () => {
  const points = parsePoints(`[
    {"heartRate":{"sampleTime":{"physicalTime":"2026-08-31T16:00:00.000Z","utcOffset":"28800s","civilTime":{"date":{"year":2026,"month":9,"day":1}}},"beatsPerMinute":"73"}}
  ]`);

  const minutes = mapHeartRatePageToMinutes({ userId, points, closeAt: '2026-08-31T16:00:30.000Z' });

  assert.equal(minutes[0]?.utcOffsetMinutes, 480);
  assert.equal(minutes[0]?.civilDate, '2026-09-01');
  assert.equal(minutes[0]?.localMinuteOfDay, 0);
});

test('keeps historical offsets when a later sample uses a different timezone', () => {
  const points = parsePoints(`[
    {"heartRate":{"sampleTime":{"physicalTime":"2026-08-31T16:30:00.000Z","utcOffset":"-25200s","civilTime":{"date":{"year":2026,"month":8,"day":31}}},"beatsPerMinute":"80"}},
    {"heartRate":{"sampleTime":{"physicalTime":"2026-08-30T15:30:00.000Z","utcOffset":"28800s","civilTime":{"date":{"year":2026,"month":8,"day":30}}},"beatsPerMinute":"72"}}
  ]`);

  const minutes = mapHeartRatePageToMinutes({ userId, points, closeAt: '2026-08-31T16:30:30.000Z' });
  const byMinute = new Map(minutes.map((minute) => [minute.minuteStartUtc, minute]));

  assert.equal(byMinute.get('2026-08-30T15:30:00.000Z')?.utcOffsetMinutes, 480);
  assert.equal(byMinute.get('2026-08-30T15:30:00.000Z')?.civilDate, '2026-08-30');
  assert.equal(byMinute.get('2026-08-31T16:30:00.000Z')?.utcOffsetMinutes, -420);
  assert.equal(byMinute.get('2026-08-31T16:30:00.000Z')?.civilDate, '2026-08-31');
  assert.notEqual(byMinute.get('2026-08-30T15:30:00.000Z')?.civilDate, byMinute.get('2026-08-31T16:30:00.000Z')?.civilDate);
});

test('skips malformed heart-rate points instead of guessing a timezone', () => {
  const points = parsePoints(`[
    {"heartRate":{"sampleTime":{"physicalTime":"2026-08-31T16:00:00.000Z","utcOffset":"28800s"},"beatsPerMinute":"73"}},
    {"heartRate":{"sampleTime":{"physicalTime":"2026-08-31T16:00:02.000Z"},"beatsPerMinute":"74"}},
    {"heartRate":{"sampleTime":{"physicalTime":"2026-08-31T16:00:04.000Z","utcOffset":"not-an-offset"},"beatsPerMinute":"75"}},
    {"heartRate":{"sampleTime":{"utcOffset":"28800s"},"beatsPerMinute":"76"}},
    {"heartRate":{"sampleTime":{"physicalTime":"not-a-timestamp","utcOffset":"28800s"},"beatsPerMinute":"77"}},
    {"heartRate":{"sampleTime":{"physicalTime":"2026-08-31T16:00:08.000Z","utcOffset":"28800s"}}},
    {"heartRate":{"sampleTime":{"physicalTime":"2026-08-31T16:00:10.000Z","utcOffset":"0s"},"beatsPerMinute":"78"}}
  ]`);

  const samples = mapHeartRateSamples(points);

  assert.deepEqual(
    samples.map((sample) => ({ physicalTime: sample.physicalTime, beatsPerMinute: sample.beatsPerMinute, utcOffsetMinutes: sample.utcOffsetMinutes })),
    [
      { physicalTime: '2026-08-31T16:00:00.000Z', beatsPerMinute: 73, utcOffsetMinutes: 480 },
      { physicalTime: '2026-08-31T16:00:10.000Z', beatsPerMinute: 78, utcOffsetMinutes: 0 },
    ],
  );
});

test('missing activity-level coverage becomes unknown rather than sedentary rest', () => {
  const points = parsePoints(`[
    {"heartRate":{"sampleTime":{"physicalTime":"2026-08-22T12:00:00.000Z","utcOffset":"0s"},"beatsPerMinute":"110"}}
  ]`);
  const minutes = mapHeartRatePageToMinutes({ userId, points, closeAt: '2026-08-22T12:01:00.000Z' });
  const intervals = mapActivityLevelIntervals([], userId);
  const attributed = withActivityLevel(minutes, intervals);
  const zones = mapDailyHeartRateZones(parsePoint(ZONE_JSON), userId);

  assert.equal(assignActivityLevel(minutes[0]?.minuteStartUtc ?? '', intervals), 'unknown');
  assert.equal(attributed[0]?.activityLevel, 'unknown');

  const strain = computeStrain({
    userId,
    date: '2026-08-22',
    minutes: attributed,
    zones,
    sleepSessions: [],
    exerciseIntervals: [],
    activityLevelIntervals: intervals,
    timezoneUnambiguous: true,
    isCurrentDay: false,
  });

  assert.equal(strain.coverage.knownContextMinutes, 0);
  assert.equal(strain.coverage.attributedMinutes, 0);
  assert.equal(strain.dose, 0);
});

test('sleep overlap excludes mapped LIGHTLY_ACTIVE minutes from strain dose', () => {
  const heartRatePoints = parsePoints(`[
    {"heartRate":{"sampleTime":{"physicalTime":"2026-08-22T12:00:00.000Z","utcOffset":"0s"},"beatsPerMinute":"110"}}
  ]`);
  const activityPoints = parsePoints(`[
    {"activityLevel":{"interval":{"startTime":"2026-08-22T12:00:00.000Z","endTime":"2026-08-22T12:01:00.000Z"},"activityLevelType":"LIGHTLY_ACTIVE"}}
  ]`);
  const sleep = mapSleepSession(
    parsePoint(`{
      "sleep": {
        "interval": {
          "startTime": "2026-08-22T11:30:00.000Z",
          "endTime": "2026-08-22T12:30:00.000Z",
          "endUtcOffset": "0s",
          "civilEndTime": { "date": { "year": 2026, "month": 8, "day": 22 } }
        },
        "metadata": { "nap": true, "processed": true },
        "summary": { "minutesAsleep": "400" }
      }
    }`),
    userId,
  );
  const minutes = mapHeartRatePageToMinutes({ userId, points: heartRatePoints, closeAt: '2026-08-22T12:01:00.000Z' });
  const intervals = mapActivityLevelIntervals(activityPoints, userId);
  const attributed = withActivityLevel(minutes, intervals);
  const zones = mapDailyHeartRateZones(parsePoint(ZONE_JSON), userId);

  assert.equal(intervals[0]?.activityLevelType, 'LIGHTLY_ACTIVE');
  assert.equal(Date.parse(intervals[0]?.endTime ?? '') - Date.parse(intervals[0]?.startTime ?? ''), 60_000);
  assert.equal(attributed[0]?.activityLevel, 'LIGHTLY_ACTIVE');
  assert.ok(sleep);

  const withoutSleep = computeStrain({
    userId,
    date: '2026-08-22',
    minutes: attributed,
    zones,
    sleepSessions: [],
    exerciseIntervals: [],
    activityLevelIntervals: intervals,
    timezoneUnambiguous: true,
    isCurrentDay: false,
  });
  const withSleep = computeStrain({
    userId,
    date: '2026-08-22',
    minutes: attributed,
    zones,
    sleepSessions: sleep ? [sleep] : [],
    exerciseIntervals: [],
    activityLevelIntervals: intervals,
    timezoneUnambiguous: true,
    isCurrentDay: false,
  });

  assert.ok((withoutSleep.dose ?? 0) > 0);
  assert.equal(withSleep.dose, 0);
  assert.equal(withSleep.zoneMinutes.light, 0);
});

test('an exercise interval overlapping sedentary or unknown heart-rate minutes still attributes dose', () => {
  const heartRatePoints = parsePoints(`[
    {"heartRate":{"sampleTime":{"physicalTime":"2026-08-22T12:00:00.000Z","utcOffset":"0s"},"beatsPerMinute":"110"}}
  ]`);
  const sedentaryPoints = parsePoints(`[
    {"activityLevel":{"interval":{"startTime":"2026-08-22T12:00:00.000Z","endTime":"2026-08-22T12:01:00.000Z"},"activityLevelType":"SEDENTARY"}}
  ]`);
  const exercise = mapExerciseInterval(
    parsePoint(`{
      "exercise": {
        "interval": {
          "startTime": "2026-08-22T12:00:00.000Z",
          "endTime": "2026-08-22T12:01:00.000Z",
          "startUtcOffset": "0s",
          "civilStartTime": { "date": { "year": 2026, "month": 8, "day": 22 } }
        }
      }
    }`),
    userId,
  );
  const minutes = mapHeartRatePageToMinutes({ userId, points: heartRatePoints, closeAt: '2026-08-22T12:01:00.000Z' });
  const sedentary = mapActivityLevelIntervals(sedentaryPoints, userId);
  const unknown = mapActivityLevelIntervals([], userId);
  const zones = mapDailyHeartRateZones(parsePoint(ZONE_JSON), userId);

  assert.ok(exercise);
  assert.equal(exercise?.sourceFamily, 'google-wearables');
  assert.equal(exercise?.civilDate, '2026-08-22');
  assert.equal(exercise?.utcOffsetMinutes, 0);

  const sedentaryMinutes = withActivityLevel(minutes, sedentary);
  const unknownMinutes = withActivityLevel(minutes, unknown);
  assert.equal(sedentaryMinutes[0]?.activityLevel, 'SEDENTARY');
  assert.equal(unknownMinutes[0]?.activityLevel, 'unknown');

  const sedentaryWithoutExercise = computeStrain({
    userId,
    date: '2026-08-22',
    minutes: sedentaryMinutes,
    zones,
    sleepSessions: [],
    exerciseIntervals: [],
    activityLevelIntervals: sedentary,
    timezoneUnambiguous: true,
    isCurrentDay: false,
  });
  const sedentaryWithExercise = computeStrain({
    userId,
    date: '2026-08-22',
    minutes: sedentaryMinutes,
    zones,
    sleepSessions: [],
    exerciseIntervals: exercise ? [exercise] : [],
    activityLevelIntervals: sedentary,
    timezoneUnambiguous: true,
    isCurrentDay: false,
  });
  const unknownWithExercise = computeStrain({
    userId,
    date: '2026-08-22',
    minutes: unknownMinutes,
    zones,
    sleepSessions: [],
    exerciseIntervals: exercise ? [exercise] : [],
    activityLevelIntervals: unknown,
    timezoneUnambiguous: true,
    isCurrentDay: false,
  });

  assert.equal(sedentaryWithoutExercise.dose, 0);
  assert.ok((sedentaryWithExercise.dose ?? 0) > 0);
  assert.ok((unknownWithExercise.dose ?? 0) > 0);
});

test('maps Google daily zones as inclusive [min, max] with a 1 bpm gap', () => {
  const zones = mapDailyHeartRateZones(parsePoint(ZONE_JSON), userId);

  assert.ok(zones);
  assert.equal(zones?.sourceFamily, 'google-wearables');
  assert.equal(zones?.date, '2026-08-22');
  assert.equal(zones?.zones.LIGHT.maxBeatsPerMinute, 116);
  assert.equal(zones?.zones.MODERATE.minBeatsPerMinute, 117);
  assert.equal(zones?.zones.LIGHT.maxBeatsPerMinute + 1, zones?.zones.MODERATE.minBeatsPerMinute);
  assert.equal(classifyHeartRateZone(116, zones!), 'light');
  assert.equal(classifyHeartRateZone(117, zones!), 'moderate');
  assert.equal(classifyHeartRateZone(155, zones!), 'vigorous');
  assert.equal(classifyHeartRateZone(156, zones!), 'peak');
  assert.equal(classifyHeartRateZone(116.5, zones!), null);
});

test('rejects daily zone maps that are incomplete or share a boundary', () => {
  const sharedBoundary = mapDailyHeartRateZones(
    parsePoint(`{
      "dailyHeartRateZones": {
        "date": { "year": 2026, "month": 8, "day": 22 },
        "heartRateZones": [
          { "heartRateZoneType": "LIGHT", "minBeatsPerMinute": "97", "maxBeatsPerMinute": "117" },
          { "heartRateZoneType": "MODERATE", "minBeatsPerMinute": "117", "maxBeatsPerMinute": "136" },
          { "heartRateZoneType": "VIGOROUS", "minBeatsPerMinute": "137", "maxBeatsPerMinute": "155" },
          { "heartRateZoneType": "PEAK", "minBeatsPerMinute": "156", "maxBeatsPerMinute": "200" }
        ]
      }
    }`),
    userId,
  );
  const incomplete = mapDailyHeartRateZones(
    parsePoint(`{
      "dailyHeartRateZones": {
        "date": { "year": 2026, "month": 8, "day": 22 },
        "heartRateZones": [
          { "heartRateZoneType": "LIGHT", "minBeatsPerMinute": "97", "maxBeatsPerMinute": "116" },
          { "heartRateZoneType": "MODERATE", "minBeatsPerMinute": "117", "maxBeatsPerMinute": "136" },
          { "heartRateZoneType": "VIGOROUS", "minBeatsPerMinute": "137", "maxBeatsPerMinute": "155" }
        ]
      }
    }`),
    userId,
  );

  assert.equal(sharedBoundary, undefined);
  assert.equal(incomplete, undefined);
});

test('sums 60-second time-in-zone intervals by civil date from start plus utcOffset', () => {
  const intervals = mapTimeInZoneIntervals(
    parsePoints(`[
      {"timeInHeartRateZone":{"interval":{"startTime":"2026-08-31T16:00:00.000Z","endTime":"2026-08-31T16:01:00.000Z","startUtcOffset":"28800s"},"heartRateZoneType":"LIGHT","duration":"999s"}},
      {"timeInHeartRateZone":{"interval":{"startTime":"2026-08-31T16:01:00.000Z","endTime":"2026-08-31T16:02:00.000Z","startUtcOffset":"28800s"},"heartRateZoneType":"LIGHT"}},
      {"timeInHeartRateZone":{"interval":{"startTime":"2026-08-31T16:02:00.000Z","endTime":"2026-08-31T16:03:00.000Z","startUtcOffset":"28800s"},"heartRateZoneType":"MODERATE"}}
    ]`),
  );
  const summaries = sumDailyTimeInZone(userId, intervals);

  assert.equal(intervals.length, 3);
  assert.equal(Date.parse(intervals[0]?.endTime ?? '') - Date.parse(intervals[0]?.startTime ?? ''), 60_000);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.date, '2026-09-01');
  assert.equal(summaries[0]?.sourceFamily, 'google-wearables');
  assert.equal(summaries[0]?.minutes.light, 2);
  assert.equal(summaries[0]?.minutes.moderate, 1);
  assert.equal(summaries[0]?.minutes.vigorous, 0);
  assert.equal(summaries[0]?.minutes.peak, 0);
});

test('rejects time-in-zone and exercise points that are missing a parseable utcOffset', () => {
  const timeInZone = mapTimeInZoneIntervals(
    parsePoints(`[
      {"timeInHeartRateZone":{"interval":{"startTime":"2026-08-31T16:00:00.000Z","endTime":"2026-08-31T16:01:00.000Z"},"heartRateZoneType":"LIGHT"}}
    ]`),
  );
  const exercise = mapExerciseInterval(
    parsePoint(`{
      "exercise": {
        "interval": {
          "startTime": "2026-08-22T12:00:00.000Z",
          "endTime": "2026-08-22T12:01:00.000Z",
          "civilStartTime": { "date": { "year": 2026, "month": 8, "day": 22 } }
        }
      }
    }`),
    userId,
  );

  assert.deepEqual(timeInZone, []);
  assert.equal(exercise, undefined);
});

test('maps activity-level pages by interval start without requiring a data-point name', () => {
  const intervals = mapActivityLevelIntervals(
    parsePoints(`[
      {"activityLevel":{"interval":{"startTime":"2026-08-22T12:00:00.000Z","endTime":"2026-08-22T12:01:00.000Z"},"activityLevelType":"LIGHTLY_ACTIVE"}},
      {"activityLevel":{"interval":{"startTime":"2026-08-22T12:00:00.000Z","endTime":"2026-08-22T12:01:00.000Z"},"activityLevelType":"SEDENTARY"}},
      {"activityLevel":{"interval":{"startTime":"2026-08-22T12:01:00.000Z","endTime":"2026-08-22T12:02:00.000Z"},"activityLevelType":"VERY_ACTIVE"}}
    ]`),
    userId,
  );

  assert.equal(intervals.length, 2);
  assert.equal(intervals[0]?.startTime, '2026-08-22T12:00:00.000Z');
  assert.equal(intervals[0]?.activityLevelType, 'LIGHTLY_ACTIVE');
  assert.equal(intervals[1]?.activityLevelType, 'VERY_ACTIVE');
  assert.equal(intervals[0]?.sourceFamily, 'google-wearables');
});

test('skips heart-rate samples whose BPM is outside 1-250 instead of clamping', () => {
  const points = parsePoints(`[
    {"heartRate":{"sampleTime":{"physicalTime":"2026-08-22T12:00:06.000Z","utcOffset":"0s"},"beatsPerMinute":"0"}},
    {"heartRate":{"sampleTime":{"physicalTime":"2026-08-22T12:00:04.000Z","utcOffset":"0s"},"beatsPerMinute":"999"}},
    {"heartRate":{"sampleTime":{"physicalTime":"2026-08-22T12:00:02.000Z","utcOffset":"0s"},"beatsPerMinute":"-5"}},
    {"heartRate":{"sampleTime":{"physicalTime":"2026-08-22T12:00:00.000Z","utcOffset":"0s"},"beatsPerMinute":"80"}}
  ]`);

  const samples = mapHeartRateSamples(points);
  const minutes = mapHeartRatePageToMinutes({ userId, points, closeAt: '2026-08-22T12:00:30.000Z' });

  assert.deepEqual(
    samples.map((sample) => ({ physicalTime: sample.physicalTime, beatsPerMinute: sample.beatsPerMinute })),
    [{ physicalTime: '2026-08-22T12:00:00.000Z', beatsPerMinute: 80 }],
  );
  assert.equal(minutes.length, 1);
  assert.equal(minutes[0]?.avgBpm, 80);
  assert.equal(minutes[0]?.minBpm, 80);
  assert.equal(minutes[0]?.maxBpm, 80);
});

test('maps unnamed exercise points with a stable sourceRecordId fallback', () => {
  const startTime = '2026-08-22T12:00:00.000Z';
  const exercise = mapExerciseInterval(
    parsePoint(`{
      "exercise": {
        "interval": {
          "startTime": "${startTime}",
          "endTime": "2026-08-22T12:01:00.000Z",
          "startUtcOffset": "0s",
          "civilStartTime": { "date": { "year": 2026, "month": 8, "day": 22 } }
        }
      }
    }`),
    userId,
  );

  assert.ok(exercise);
  assert.equal(exercise?.sourceRecordId, `${userId}:${startTime}`);
  assert.equal(exercise?.startTime, startTime);
});

test('forwards an optional lookahead sample so a later page can close the last hold', () => {
  const points = parsePoints(`[
    {"heartRate":{"sampleTime":{"physicalTime":"2026-08-22T12:00:00.000Z","utcOffset":"0s"},"beatsPerMinute":"90"}}
  ]`);
  const minutes = mapHeartRatePageToMinutes({
    userId,
    points,
    lookaheadSample: { physicalTime: '2026-08-22T12:00:30.000Z', beatsPerMinute: 92, utcOffsetMinutes: 0 },
  });

  assert.equal(minutes[0]?.coverageSeconds, 30);
});
