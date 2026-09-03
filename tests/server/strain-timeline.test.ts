import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseActivityLevelInterval,
  parseDailyCardio,
  parseDailyHeartRateZones,
  parseHeartRateMinuteAggregate,
  parseMetricResult,
} from '../../src/domain/cardio-records';
import { parseSleepSession } from '../../src/domain/health-records';
import { WHOOP_STYLE_METRIC_VERSION } from '../../src/domain/metric-types';
import { createMemoryStore } from '../../src/server/db/memory-store';
import { buildVerifiedStrainTimeline } from '../../src/server/dashboard/strain-timeline';
import {
  strainCalculationContext,
  strainInputFingerprint,
  strainLocalDayBounds,
  stableStrainLocalDayBounds,
  type StrainCalculationContext,
} from '../../src/server/health/strain-provenance';

const userId = 'timeline-user';
const civilDate = '2026-03-08';
const now = '2026-03-09T01:00:00.000Z';
const zones = parseDailyHeartRateZones({
  userId,
  sourceFamily: 'google-wearables',
  date: civilDate,
  zones: {
    LIGHT: { minBeatsPerMinute: 90, maxBeatsPerMinute: 119 },
    MODERATE: { minBeatsPerMinute: 120, maxBeatsPerMinute: 139 },
    VIGOROUS: { minBeatsPerMinute: 140, maxBeatsPerMinute: 159 },
    PEAK: { minBeatsPerMinute: 160, maxBeatsPerMinute: 200 },
  },
});

async function seed(input: {
  civilDate?: string;
  context?: StrainCalculationContext;
  minuteStartUtc?: string;
  now?: string;
  utcOffsetMinutes?: number;
} = {}) {
  const targetDate = input.civilDate ?? civilDate;
  const targetNow = input.now ?? now;
  const minuteStartUtc = input.minuteStartUtc ?? '2026-03-08T13:00:00.000Z';
  const utcOffsetMinutes = input.utcOffsetMinutes ?? -240;
  const targetZones = parseDailyHeartRateZones({ ...zones, date: targetDate });
  const store = createMemoryStore();
  const history = [{
    userId,
    ianaTimeZone: 'America/New_York',
    effectiveAt: '1970-01-01T00:00:00.000Z',
    isBackfillAnchor: true,
  }];
  await store.healthMetrics.insertTimeZoneHistory(history[0]!);
  const minutes = [parseHeartRateMinuteAggregate({
    userId,
    sourceFamily: 'google-wearables',
    minuteStartUtc,
    civilDate: targetDate,
    utcOffsetMinutes,
    ianaTimeZone: 'America/New_York',
    localMinuteOfDay: 9 * 60,
    avgBpm: 125,
    minBpm: 125,
    maxBpm: 125,
    sampleCount: 1,
    coverageSeconds: 60,
    activityLevel: 'LIGHTLY_ACTIVE',
  })];
  const activity = [parseActivityLevelInterval({
    userId,
    sourceFamily: 'google-wearables',
    startTime: minuteStartUtc,
    endTime: new Date(Date.parse(minuteStartUtc) + 60_000).toISOString(),
    activityLevelType: 'LIGHTLY_ACTIVE',
  })];
  const sleepSessions = [parseSleepSession({
    userId,
    source: 'google_health',
    sourceRecordId: `sleep-${targetDate}`,
    id: `sleep-${targetDate}`,
    startTime: new Date(Date.parse(minuteStartUtc) - 7 * 60 * 60_000).toISOString(),
    endTime: new Date(Date.parse(minuteStartUtc) - 30 * 60_000).toISOString(),
    civilEndDate: targetDate,
    utcOffsetMinutes,
    minutesAsleep: 390,
    timeInBedMinutes: 420,
    awakeMinutes: 30,
    isNap: false,
    processed: true,
  })];
  const context = input.context ?? strainCalculationContext({
    civilDate: targetDate,
    isCurrentDay: false,
    now: targetNow,
    timeZoneHistory: history,
    timeZoneUnambiguous: true,
  });
  const fingerprint = strainInputFingerprint({
    userId,
    context,
    minutes,
    zones: targetZones,
    sleepSessions,
    exerciseIntervals: [],
    activityLevelIntervals: activity,
  });
  const provenance = { provenanceVersion: 1 as const, inputFingerprint: fingerprint, calculationContext: context };
  await store.healthMetrics.upsertMinutes(minutes);
  await store.healthMetrics.upsertActivityLevelIntervals(activity);
  await store.healthMetrics.replaceHeartRateZones(targetZones);
  await store.healthMetrics.upsertDailyCardio(parseDailyCardio({
    userId,
    date: targetDate,
    status: 'complete',
    strain: 2.1,
    dose: 2,
    zoneMinutes: { light: 0, moderate: 1, vigorous: 0, peak: 0 },
    knownContextMinutes: 1,
    rawCoverageMinutes: 1,
    attributedMinutes: 1,
    metricVersion: WHOOP_STYLE_METRIC_VERSION,
    provenance,
  }));
  await store.healthMetrics.upsertMetricResult(parseMetricResult({
    userId,
    civilDate: targetDate,
    metricName: 'strain',
    metricVersion: WHOOP_STYLE_METRIC_VERSION,
    score: 2.1,
    status: 'complete',
    quality: null,
    reason: null,
    evidence: [],
    source: {
      heartRateZones: true, activityLevel: true, exercise: false, sleep: true,
      hrv: false, rhr: false, sleepGoal: false, timeZone: 'unambiguous',
    },
    coverage: { knownContextMinutes: 1, rawHeartRateMinutes: 1, attributedMinutes: 1, lastKnownContextAt: minutes[0]!.minuteStartUtc },
    provenance,
  }));
  return { store, sleepSessions };
}

test('returns a DST-correct, safe 15-minute timeline only for a reproducible strain result', async () => {
  const { store, sleepSessions } = await seed();
  const timeline = await buildVerifiedStrainTimeline({ store: store.healthMetrics, userId, civilDate, now, sleepSessions });

  assert.ok(timeline);
  assert.equal(timeline.buckets.length, 92);
  assert.equal(timeline.buckets.some((bucket) => bucket.intensity === 2), true);
  assert.equal(timeline.buckets.every((bucket) => !('bpm' in bucket)), true);
  assert.equal(JSON.stringify(timeline).includes('125'), false);
  assert.equal(timeline.buckets.some((bucket) => bucket.observedHeartRateMinutes > 0), true);
});

test('returns all 100 fall-back buckets and labels the repeated local hour with its UTC offsets', async () => {
  const fallDate = '2026-11-01';
  const fallNow = '2026-11-02T06:00:00.000Z';
  const { store, sleepSessions } = await seed({
    civilDate: fallDate,
    now: fallNow,
    minuteStartUtc: '2026-11-01T14:00:00.000Z',
    utcOffsetMinutes: -300,
  });
  const timeline = await buildVerifiedStrainTimeline({
    store: store.healthMetrics, userId, civilDate: fallDate, now: fallNow, sleepSessions,
  });
  assert.ok(timeline);
  assert.equal(timeline.buckets.length, 100);
  const repeatedOneAm = timeline.buckets.filter((bucket) => bucket.label.endsWith('01:00'));
  assert.equal(new Set(repeatedOneAm.map((bucket) => bucket.label)).size, 2);
  assert.equal(repeatedOneAm.some((bucket) => bucket.label.includes('UTC-4')), true);
  assert.equal(repeatedOneAm.some((bucket) => bucket.label.includes('UTC-5')), true);
});

test('fails closed when either saved provenance context does not match', async () => {
  const wrongContext = strainCalculationContext({
    civilDate,
    isCurrentDay: false,
    now: '2026-03-09T02:00:00.000Z',
    timeZoneHistory: [{ userId, ianaTimeZone: 'America/New_York', effectiveAt: '1970-01-01T00:00:00.000Z', isBackfillAnchor: true }],
    timeZoneUnambiguous: true,
  });
  const { store, sleepSessions } = await seed({ context: wrongContext });
  const timeline = await buildVerifiedStrainTimeline({ store: store.healthMetrics, userId, civilDate, now, sleepSessions });
  assert.equal(timeline, undefined);
});

test('fails closed when the persisted strain did not include replayable sleep context', async () => {
  const { store } = await seed();
  const timeline = await buildVerifiedStrainTimeline({ store: store.healthMetrics, userId, civilDate, now, sleepSessions: [] });
  assert.equal(timeline, undefined);
});

test('keeps future current-day buckets empty and exposes only the saved observed-through instant', async () => {
  const observedThrough = '2026-03-08T14:00:00.000Z';
  const context = strainCalculationContext({
    civilDate,
    isCurrentDay: true,
    now: observedThrough,
    timeZoneHistory: [{ userId, ianaTimeZone: 'America/New_York', effectiveAt: '1970-01-01T00:00:00.000Z', isBackfillAnchor: true }],
    timeZoneUnambiguous: true,
  });
  const { store, sleepSessions } = await seed({ context, minuteStartUtc: observedThrough });
  const timeline = await buildVerifiedStrainTimeline({
    store: store.healthMetrics, userId, civilDate, now: observedThrough, sleepSessions,
  });
  assert.ok(timeline);
  assert.equal(timeline.observedThrough, observedThrough);
  assert.equal(timeline.buckets.find((bucket) => bucket.start === observedThrough)?.intensity, 2);
  assert.equal(
    timeline.buckets.filter((bucket) => Date.parse(bucket.start) > Date.parse(observedThrough)).every((bucket) => bucket.intensity === null),
    true,
  );
});

test('uses actual 23-hour and 25-hour IANA local-day bounds for DST buckets', () => {
  const history = [{ userId, ianaTimeZone: 'America/New_York', effectiveAt: '1970-01-01T00:00:00.000Z', isBackfillAnchor: true }];
  assert.equal(strainLocalDayBounds({ civilDate: '2026-03-08', timeZoneHistory: history })?.localDayLengthMinutes, 92 * 15);
  assert.equal(strainLocalDayBounds({ civilDate: '2026-11-01', timeZoneHistory: history })?.localDayLengthMinutes, 100 * 15);
});

test('fails closed when a stored IANA history change falls inside one civil day', () => {
  const minute = parseHeartRateMinuteAggregate({
    userId,
    sourceFamily: 'google-wearables',
    minuteStartUtc: '2026-03-08T13:00:00.000Z',
    civilDate,
    utcOffsetMinutes: -240,
    ianaTimeZone: null,
    localMinuteOfDay: 540,
    avgBpm: 125,
    minBpm: 125,
    maxBpm: 125,
    sampleCount: 1,
    coverageSeconds: 60,
    activityLevel: 'LIGHTLY_ACTIVE',
  });
  const bounds = stableStrainLocalDayBounds({
    civilDate,
    minutes: [minute],
    timeZoneHistory: [
      { userId, ianaTimeZone: 'America/New_York', effectiveAt: '1970-01-01T00:00:00.000Z', isBackfillAnchor: true },
      { userId, ianaTimeZone: 'America/Chicago', effectiveAt: '2026-03-08T18:00:00.000Z', isBackfillAnchor: false },
    ],
  });
  assert.equal(bounds, undefined);
});
