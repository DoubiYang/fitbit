import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDailyCardio, parseDailyHeartRateZones, parseDailyTimeInZone, parseMetricResult } from '../../src/domain/cardio-records';
import { BODY_AGE_REFERENCE_VERSION } from '../../src/domain/body-age';
import { parseSleepSession, type SleepSession } from '../../src/domain/health-records';
import { WHOOP_STYLE_METRIC_VERSION } from '../../src/domain/metric-types';
import { DemoHealthProvider } from '../../src/server/health/demo-provider';
import { BODY_AGE_ALGORITHM_VERSION, BODY_AGE_WINDOW_DAYS, recomputeBodyAge } from '../../src/server/health/body-age-recompute';
import { bodyAgeFingerprintContext, bodyAgeInputFingerprint } from '../../src/server/health/body-age-fingerprint';
import { emptyUserHealthRecords, type HealthProvider, type UserHealthRecords } from '../../src/server/health/provider';
import { createMemoryStore } from '../../src/server/db/memory-store';
import { buildHomepageTodayView, buildTodayView, type BodyAgeMetricView, type TodayView } from '../../src/server/dashboard/build-today';

function requiredBodyAge(view: TodayView): BodyAgeMetricView {
  const bodyAge = view.metrics.bodyAge;
  assert.ok(bodyAge, 'buildTodayView must always emit bodyAge');
  return bodyAge;
}

async function currentBodyAgeFingerprint(
  store: ReturnType<typeof createMemoryStore>,
  records = emptyUserHealthRecords(),
  now = new Date('2026-08-24T12:00:00.000Z'),
): Promise<string> {
  const profile = await store.healthMetrics.getBodyAgeProfile({ userId: 'u1' });
  assert.ok(profile, 'test fixture requires a profile');
  const timeZoneHistory = await store.healthMetrics.listTimeZoneHistory('u1');
  const context = bodyAgeFingerprintContext({ timeZoneHistory, now, windowDays: BODY_AGE_WINDOW_DAYS });
  const dailyVo2 = await store.healthMetrics.listDailyVo2({
    userId: 'u1', fromCivilDate: context.fromCivilDate, toCivilDate: context.asOfCivilDate,
  });
  return bodyAgeInputFingerprint({
    algorithmVersion: BODY_AGE_ALGORITHM_VERSION,
    windowDays: BODY_AGE_WINDOW_DAYS,
    userId: 'u1',
    profile,
    timeZoneHistory,
    now,
    dailyVo2,
    records,
  });
}

function dailyVo2(civilDate: string, vo2Max = 80) {
  return {
    userId: 'u1', civilDate, vo2Max, sourceFamily: 'google-wearables' as const,
    receivedAt: '2026-08-24T12:00:00.000Z', revision: 0, estimated: false,
  };
}

function assertNoTrainingPermission(text: string): void {
  assert.doesNotMatch(text, /可按原计划/);
  assert.doesNotMatch(text, /可以训练/);
  assert.doesNotMatch(text, /train as planned/i);
  assert.doesNotMatch(text, /训练许可/);
  assert.doesNotMatch(text, /安全加练/);
}

test('builds an evidence-complete view scoped to the requested user', async () => {
  const provider = new DemoHealthProvider();
  const view = await buildTodayView({
    provider,
    userId: 'demo_user',
    now: '2026-08-22T08:00:00.000Z',
    lastSuccessfulSyncAt: '2026-08-22T07:00:00.000Z',
    allowDefaultTimeZone: true,
  });

  assert.equal(view.userId, 'demo_user');
  assert.equal(view.localDate, '2026-08-22');
  assert.ok(view.primaryAction.evidence.length >= 2);
  assert.ok(view.primaryAction.evidence.every((evidence) => evidence.date.length === 10));
  assert.equal(JSON.stringify(view).includes('sourceRecordId'), false);
  assert.equal(JSON.stringify(view).includes('480'), false);
  assertNoTrainingPermission(view.primaryAction.text);
  assert.equal('training' in view.metrics, false);
  assert.ok(view.metrics.strain);
  assert.ok(view.metrics.recovery);
  assert.ok(view.metrics.sleepPerformance);
});

test('returns a data state instead of a training instruction with insufficient records', async () => {
  const provider: HealthProvider = {
    capabilities: { mode: 'demo', canSync: false },
    async listRecords(): Promise<UserHealthRecords> {
      return emptyUserHealthRecords();
    },
  };
  const view = await buildTodayView({
    provider,
    userId: 'demo_user',
    now: '2026-08-22T08:00:00.000Z',
    lastSuccessfulSyncAt: '2026-08-22T07:00:00.000Z',
    allowDefaultTimeZone: true,
  });

  assert.equal(view.primaryAction.kind, 'data_state');
  assert.equal('trainingPrescription' in view.primaryAction, false);
  assert.equal(view.metrics.recovery.score, null);
  assertNoTrainingPermission(view.primaryAction.text);
});

test('raw dashboard metrics ignore manual HRV and RHR records', async () => {
  const baselineDates = ['2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22'];
  const provider: HealthProvider = {
    capabilities: { mode: 'oauth', canSync: true },
    async listRecords(): Promise<UserHealthRecords> {
      return {
        ...emptyUserHealthRecords(),
        dailyHrv: [
          ...baselineDates.map((date, index) => ({
            userId: 'u1', source: 'manual' as const, sourceRecordId: `manual-hrv-${date}`, date, valueMs: 42 + index,
          })),
          { userId: 'u1', source: 'manual', sourceRecordId: 'manual-hrv-23', date: '2026-08-23', valueMs: 60 },
        ],
        dailyRhr: [
          ...baselineDates.map((date, index) => ({
            userId: 'u1', source: 'manual' as const, sourceRecordId: `manual-rhr-${date}`, date, valueBpm: 50 + (index % 3),
          })),
          { userId: 'u1', source: 'manual', sourceRecordId: 'manual-rhr-23', date: '2026-08-23', valueBpm: 52 },
        ],
      };
    },
  };

  const view = await buildTodayView({
    provider,
    userId: 'u1',
    now: '2026-08-23T12:00:00.000Z',
    lastSuccessfulSyncAt: '2026-08-23T11:00:00.000Z',
    timeZone: 'UTC',
  });

  assert.equal(view.metrics.recovery.score, null);
  assert.equal(view.metrics.recovery.quality, 'unavailable');
});

test('demo today still uses the documented Asia/Shanghai fallback', async () => {
  const view = await buildTodayView({
    provider: {
      capabilities: { mode: 'demo', canSync: false },
      async listRecords(): Promise<UserHealthRecords> {
        return emptyUserHealthRecords();
      },
    },
    userId: 'demo_user',
    now: '2026-08-23T23:00:00.000Z',
    lastSuccessfulSyncAt: '2026-08-23T22:00:00.000Z',
    allowDefaultTimeZone: true,
  });
  assert.equal(view.localDate, '2026-08-24');
});

test('oauth today uses stored IANA rather than Asia/Shanghai', async () => {
  const view = await buildTodayView({
    provider: {
      capabilities: { mode: 'oauth', canSync: true },
      async listRecords(): Promise<UserHealthRecords> {
        return emptyUserHealthRecords();
      },
    },
    userId: 'u1',
    now: '2026-08-23T23:00:00.000Z',
    lastSuccessfulSyncAt: '2026-08-23T22:00:00.000Z',
    timeZone: 'America/Los_Angeles',
  });
  assert.equal(view.localDate, '2026-08-23');
});

test('oauth today without IANA does not fall back to Asia/Shanghai', async () => {
  const view = await buildTodayView({
    provider: {
      capabilities: { mode: 'oauth', canSync: true },
      async listRecords(): Promise<UserHealthRecords> {
        return emptyUserHealthRecords();
      },
    },
    userId: 'u1',
    now: '2026-08-23T23:00:00.000Z',
    lastSuccessfulSyncAt: '2026-08-23T22:00:00.000Z',
  });
  assert.equal(view.localDate, '2026-08-23');
});

test('today body age hides a result whose profile revision no longer matches', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.healthMetrics.updateBodyAgeProfile({ userId: 'u1', birthDate: '1988-04-20', referenceSex: 'male' });
  await store.healthMetrics.writeBodyAgeResult({
    userId: 'u1',
    algorithmVersion: BODY_AGE_ALGORITHM_VERSION,
    estimate: {
      age: 42,
      coverageDays: 21,
      latestInputCivilDate: '2026-08-22',
      route: 'daily_vo2',
      status: 'daily_vo2_stable',
      referenceVersion: BODY_AGE_REFERENCE_VERSION,
      disclaimer: 'non_medical_non_calibrated_estimate',
      dataGaps: { dailyVo2DaysNeeded: 0, rhrDaysNeeded: 0, observedHrPeakRequired: false },
    },
    lastCalculatedCivilDate: '2026-08-22',
    referenceHash: 'sha256:reference',
    inputFingerprint: 'sha256:inputs',
    profileRevision: 1,
    chronologicalAgeDeltaYears: -2,
    windowDays: 28,
    exclusionCounts: {
      invalidDailyVo2: 0, futureDailyVo2: 0, untrustedDailyVo2: 0,
      invalidDailyRhr: 0, futureDailyRhr: 0, untrustedDailyRhr: 0,
    },
    computedAt: '2026-08-22T12:00:00.000Z',
  });
  await store.healthMetrics.updateBodyAgeProfile({ userId: 'u1', birthDate: '1988-04-20', referenceSex: 'female' });

  const view = await buildTodayView({
    provider: { capabilities: { mode: 'oauth', canSync: true }, async listRecords() { return emptyUserHealthRecords(); } },
    userId: 'u1', now: '2026-08-24T12:00:00.000Z', lastSuccessfulSyncAt: '2026-08-24T11:00:00.000Z',
    timeZone: 'UTC', healthMetrics: store.healthMetrics,
  });

  assert.deepEqual(requiredBodyAge(view), {
    label: '身体年龄', age: null, edge: null, status: 'data_updating', route: null,
    coverageDays: 0, latestInputCivilDate: null, lastCalculatedCivilDate: null,
    referenceVersion: BODY_AGE_REFERENCE_VERSION, chronologicalAgeDeltaYears: null,
    dataGaps: { dailyVo2DaysNeeded: 7, rhrDaysNeeded: 7, observedHrPeakRequired: true },
    disclaimer: 'non_medical_non_calibrated_estimate',
  });
});

test('today body age hides a result when the current input fingerprint no longer matches', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.healthMetrics.updateBodyAgeProfile({ userId: 'u1', birthDate: '1988-04-20', referenceSex: 'male' });
  await store.healthMetrics.upsertDailyVo2(Array.from({ length: 7 }, (_, offset) => dailyVo2(
    `2026-08-${String(24 - offset).padStart(2, '0')}`,
    26.7,
  )));
  const records: UserHealthRecords = {
    ...emptyUserHealthRecords(),
    dailyRhr: [{
      userId: 'u1', source: 'google_health', sourceRecordId: 'rhr-2026-08-24', date: '2026-08-24', valueBpm: 60,
    }],
  };
  await recomputeBodyAge({
    store: store.healthMetrics,
    userId: 'u1',
    now: new Date('2026-08-24T12:00:00.000Z'),
    records,
  });
  const provider: HealthProvider = {
    capabilities: { mode: 'oauth', canSync: true },
    async listRecords() { return records; },
  };
  const beforeChange = await buildTodayView({
    provider,
    userId: 'u1', now: '2026-08-24T12:00:00.000Z', lastSuccessfulSyncAt: '2026-08-24T11:00:00.000Z',
    timeZone: 'UTC', healthMetrics: store.healthMetrics,
  });
  assert.equal(requiredBodyAge(beforeChange).status, 'daily_vo2_provisional');
  await store.healthMetrics.upsertDailyVo2([{
    ...dailyVo2('2026-08-24', 27), receivedAt: '2026-08-24T13:00:00.000Z', revision: 1,
  }]);

  const view = await buildTodayView({
    provider,
    userId: 'u1', now: '2026-08-24T12:00:00.000Z', lastSuccessfulSyncAt: '2026-08-24T11:00:00.000Z',
    timeZone: 'UTC', healthMetrics: store.healthMetrics,
  });

  const bodyAge = requiredBodyAge(view);
  assert.equal(bodyAge.status, 'data_updating');
  assert.equal(bodyAge.age, null);
  assert.equal(bodyAge.edge, null);
  assert.equal(bodyAge.route, null);
  assert.equal(bodyAge.chronologicalAgeDeltaYears, null);
});

test('today body age never exposes a stored estimate while profile fields are incomplete', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.healthMetrics.writeBodyAgeResult({
    userId: 'u1', algorithmVersion: BODY_AGE_ALGORITHM_VERSION,
    estimate: {
      age: 42, coverageDays: 21, latestInputCivilDate: '2026-08-22', route: 'daily_vo2',
      status: 'daily_vo2_stable', referenceVersion: BODY_AGE_REFERENCE_VERSION,
      disclaimer: 'non_medical_non_calibrated_estimate',
      dataGaps: { dailyVo2DaysNeeded: 0, rhrDaysNeeded: 0, observedHrPeakRequired: false },
    },
    lastCalculatedCivilDate: '2026-08-22', referenceHash: 'sha256:reference', inputFingerprint: 'sha256:inputs',
    profileRevision: 0, chronologicalAgeDeltaYears: -2, windowDays: 28,
    exclusionCounts: {
      invalidDailyVo2: 0, futureDailyVo2: 0, untrustedDailyVo2: 0,
      invalidDailyRhr: 0, futureDailyRhr: 0, untrustedDailyRhr: 0,
    },
    computedAt: '2026-08-22T12:00:00.000Z',
  });

  const view = await buildTodayView({
    provider: { capabilities: { mode: 'oauth', canSync: true }, async listRecords() { return emptyUserHealthRecords(); } },
    userId: 'u1', now: '2026-08-24T12:00:00.000Z', lastSuccessfulSyncAt: '2026-08-24T11:00:00.000Z',
    timeZone: 'UTC', healthMetrics: store.healthMetrics,
  });

  const bodyAge = requiredBodyAge(view);
  assert.equal(bodyAge.status, 'profile_missing');
  assert.equal(bodyAge.age, null);
  assert.equal(bodyAge.edge, null);
  assert.equal(bodyAge.route, null);
  assert.equal(bodyAge.chronologicalAgeDeltaYears, null);
});

test('today body age uses a generic accumulating state until the first current result exists', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.healthMetrics.updateBodyAgeProfile({ userId: 'u1', birthDate: '1988-04-20', referenceSex: 'male' });

  const view = await buildTodayView({
    provider: { capabilities: { mode: 'oauth', canSync: true }, async listRecords() { return emptyUserHealthRecords(); } },
    userId: 'u1', now: '2026-08-24T12:00:00.000Z', lastSuccessfulSyncAt: '2026-08-24T11:00:00.000Z',
    timeZone: 'UTC', healthMetrics: store.healthMetrics,
  });

  const bodyAge = requiredBodyAge(view);
  assert.equal(bodyAge.status, 'data_accumulating');
  assert.equal(bodyAge.age, null);
  assert.equal(bodyAge.route, null);
  assert.deepEqual(bodyAge.dataGaps, {
    dailyVo2DaysNeeded: 7, rhrDaysNeeded: 7, observedHrPeakRequired: true,
  });
});

test('today body age sends an allowlisted view and never gives a boundary a chronological delta', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.healthMetrics.updateBodyAgeProfile({ userId: 'u1', birthDate: '1988-04-20', referenceSex: 'male' });
  await store.healthMetrics.upsertDailyVo2(Array.from({ length: 7 }, (_, offset) => dailyVo2(`2026-08-${String(24 - offset).padStart(2, '0')}`)));
  const inputFingerprint = await currentBodyAgeFingerprint(store);
  await store.healthMetrics.writeBodyAgeResult({
    userId: 'u1',
    algorithmVersion: BODY_AGE_ALGORITHM_VERSION,
    estimate: {
      age: 'below_reference_min', coverageDays: 28, latestInputCivilDate: '2026-08-22', route: 'daily_vo2',
      status: 'daily_vo2_stable', referenceVersion: BODY_AGE_REFERENCE_VERSION,
      disclaimer: 'non_medical_non_calibrated_estimate',
      dataGaps: { dailyVo2DaysNeeded: 0, rhrDaysNeeded: 0, observedHrPeakRequired: false },
    },
    lastCalculatedCivilDate: '2026-08-22', referenceHash: 'sha256:reference', inputFingerprint,
    profileRevision: 1, chronologicalAgeDeltaYears: null, windowDays: 28,
    exclusionCounts: {
      invalidDailyVo2: 0, futureDailyVo2: 0, untrustedDailyVo2: 0,
      invalidDailyRhr: 0, futureDailyRhr: 0, untrustedDailyRhr: 0,
    },
    computedAt: '2026-08-22T12:00:00.000Z',
  });

  const view = await buildTodayView({
    provider: { capabilities: { mode: 'oauth', canSync: true }, async listRecords() { return emptyUserHealthRecords(); } },
    userId: 'u1', now: '2026-08-24T12:00:00.000Z', lastSuccessfulSyncAt: '2026-08-24T11:00:00.000Z',
    timeZone: 'UTC', healthMetrics: store.healthMetrics,
  });

  const bodyAge = requiredBodyAge(view);
  assert.equal(bodyAge.age, null);
  assert.equal(bodyAge.edge, 'below_reference_min');
  assert.equal(bodyAge.chronologicalAgeDeltaYears, null);
  assert.equal(bodyAge.route, 'daily_vo2');
  assert.equal(bodyAge.status, 'daily_vo2_stable');
  assert.deepEqual(Object.keys(bodyAge).sort(), [
    'age', 'chronologicalAgeDeltaYears', 'coverageDays', 'dataGaps', 'disclaimer', 'edge',
    'label', 'lastCalculatedCivilDate', 'latestInputCivilDate', 'referenceVersion', 'route', 'status',
  ]);
});

test('today body age preserves a stale result without upgrading it to a fresh number', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.healthMetrics.updateBodyAgeProfile({ userId: 'u1', birthDate: '1988-04-20', referenceSex: 'male' });
  await store.healthMetrics.upsertDailyVo2(Array.from({ length: 7 }, (_, offset) => dailyVo2(`2026-08-${String(10 - offset).padStart(2, '0')}`, 26.7)));
  const inputFingerprint = await currentBodyAgeFingerprint(store);
  await store.healthMetrics.writeBodyAgeResult({
    userId: 'u1', algorithmVersion: BODY_AGE_ALGORITHM_VERSION,
    estimate: {
      age: null, coverageDays: 7, latestInputCivilDate: '2026-08-10', route: 'daily_vo2', status: 'stale',
      referenceVersion: BODY_AGE_REFERENCE_VERSION, disclaimer: 'non_medical_non_calibrated_estimate',
      dataGaps: { dailyVo2DaysNeeded: 0, rhrDaysNeeded: 0, observedHrPeakRequired: false },
    },
    lastCalculatedCivilDate: '2026-08-10', referenceHash: 'sha256:reference', inputFingerprint,
    profileRevision: 1, chronologicalAgeDeltaYears: null, windowDays: 28,
    exclusionCounts: {
      invalidDailyVo2: 0, futureDailyVo2: 0, untrustedDailyVo2: 0,
      invalidDailyRhr: 0, futureDailyRhr: 0, untrustedDailyRhr: 0,
    },
    computedAt: '2026-08-10T12:00:00.000Z',
  });

  const view = await buildTodayView({
    provider: { capabilities: { mode: 'oauth', canSync: true }, async listRecords() { return emptyUserHealthRecords(); } },
    userId: 'u1', now: '2026-08-24T12:00:00.000Z', lastSuccessfulSyncAt: '2026-08-24T11:00:00.000Z',
    timeZone: 'UTC', healthMetrics: store.healthMetrics,
  });

  assert.equal(view.freshness, 'fresh');
  const bodyAge = requiredBodyAge(view);
  assert.equal(bodyAge.status, 'stale');
  assert.equal(bodyAge.age, null);
  assert.equal(bodyAge.edge, null);
  assert.equal(bodyAge.route, 'daily_vo2');
  assert.equal(bodyAge.lastCalculatedCivilDate, '2026-08-10');
  assert.equal(bodyAge.chronologicalAgeDeltaYears, null);
});

test('demo body age remains a safe profile-missing default without a metrics store', async () => {
  const view = await buildTodayView({
    provider: { capabilities: { mode: 'demo', canSync: false }, async listRecords() { return emptyUserHealthRecords(); } },
    userId: 'demo_user', now: '2026-08-24T12:00:00.000Z', lastSuccessfulSyncAt: '2026-08-24T12:00:00.000Z',
    allowDefaultTimeZone: true,
  });
  const bodyAge = requiredBodyAge(view);
  assert.equal(bodyAge.status, 'profile_missing');
  assert.equal(bodyAge.age, null);
  assert.equal(bodyAge.route, null);
});

test('does not allow provider records for another user into the view', async () => {
  const otherUserSleep = parseSleepSession({
    userId: 'another_user',
    source: 'google_health',
    sourceRecordId: 'other-sleep',
    id: 'other-sleep',
    startTime: '2026-08-21T15:00:00.000Z',
    endTime: '2026-08-21T23:00:00.000Z',
    civilEndDate: '2026-08-22',
    utcOffsetMinutes: 480,
    minutesAsleep: 480,
    isNap: false,
    processed: true,
  });
  const provider = recordsForOtherUser(otherUserSleep);
  const view = await buildTodayView({
    provider,
    userId: 'demo_user',
    now: '2026-08-22T08:00:00.000Z',
    lastSuccessfulSyncAt: '2026-08-22T07:00:00.000Z',
    allowDefaultTimeZone: true,
  });

  assert.equal(view.primaryAction.kind, 'data_state');
  assert.equal(view.metrics.sleepPerformance.score, null);
  assert.equal(JSON.stringify(view).includes('another_user'), false);
});

test('store-backed today view passes Google zone thresholds and all-day zone time through without inventing values', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.healthMetrics.replaceHeartRateZones(parseDailyHeartRateZones({
    userId: 'u1',
    sourceFamily: 'google-wearables',
    date: '2026-08-22',
    zones: {
      LIGHT: { minBeatsPerMinute: 97, maxBeatsPerMinute: 116 },
      MODERATE: { minBeatsPerMinute: 117, maxBeatsPerMinute: 136 },
      VIGOROUS: { minBeatsPerMinute: 137, maxBeatsPerMinute: 155 },
      PEAK: { minBeatsPerMinute: 156, maxBeatsPerMinute: 200 },
    },
  }));
  await store.healthMetrics.replaceTimeInZone(parseDailyTimeInZone({
    userId: 'u1',
    sourceFamily: 'google-wearables',
    date: '2026-08-22',
    minutes: { light: 400, moderate: 20, vigorous: 5, peak: 1 },
  }));
  await store.healthMetrics.upsertDailyCardio(parseDailyCardio({
    userId: 'u1',
    date: '2026-08-22',
    status: 'complete',
    strain: 8.4,
    dose: 18.5,
    zoneMinutes: { light: 10, moderate: 8, vigorous: 4, peak: 2 },
    knownContextMinutes: 600,
    rawCoverageMinutes: 610,
    attributedMinutes: 24,
    metricVersion: WHOOP_STYLE_METRIC_VERSION,
  }));

  const view = await buildTodayView({
    provider: {
      capabilities: { mode: 'oauth', canSync: true },
      async listRecords(): Promise<UserHealthRecords> {
        return emptyUserHealthRecords();
      },
    },
    userId: 'u1',
    now: '2026-08-22T08:00:00.000Z',
    lastSuccessfulSyncAt: '2026-08-22T07:00:00.000Z',
    timeZone: 'UTC',
    healthMetrics: store.healthMetrics,
  });

  assert.equal(view.metrics.strain.heartRateZones?.LIGHT.minBeatsPerMinute, 97);
  assert.equal(view.metrics.strain.heartRateZones?.PEAK.maxBeatsPerMinute, 200);
  assert.equal(view.metrics.strain.timeInZone?.light, 400);
  assert.equal(view.metrics.strain.activityZoneMinutes?.light, 10);
  assert.equal(view.metrics.strain.dose, 18.5);
});

test('stored incomplete sleep history keeps homepage recovery explicitly provisional', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  const source = {
    heartRateZones: false, activityLevel: false, exercise: false, sleep: true,
    hrv: true, rhr: true, sleepGoal: true, timeZone: 'unambiguous' as const,
  };
  const coverage = { knownContextMinutes: 0, rawHeartRateMinutes: 0, attributedMinutes: 0, lastKnownContextAt: null };
  await store.healthMetrics.upsertMetricResult(parseMetricResult({
    userId: 'u1', civilDate: '2026-08-22', metricName: 'sleep_performance',
    metricVersion: WHOOP_STYLE_METRIC_VERSION, score: 88, status: null, quality: null, reason: null,
    evidence: [], source, coverage, qualityFlags: ['sleep_history_incomplete'],
  }));
  await store.healthMetrics.upsertMetricResult(parseMetricResult({
    userId: 'u1', civilDate: '2026-08-22', metricName: 'recovery',
    metricVersion: WHOOP_STYLE_METRIC_VERSION, score: 77, status: null, quality: 'high', reason: null,
    evidence: [], source, coverage,
  }));

  const view = await buildTodayView({
    provider: { capabilities: { mode: 'oauth', canSync: true }, async listRecords() { return emptyUserHealthRecords(); } },
    userId: 'u1', now: '2026-08-22T12:00:00.000Z', lastSuccessfulSyncAt: '2026-08-22T11:00:00.000Z',
    timeZone: 'UTC', healthMetrics: store.healthMetrics,
  });
  assert.equal(view.metrics.recovery.quality, 'provisional');
  assert.match(view.metrics.recovery.detail, /数据质量为临时/);
});

test('stale homepage data never presents a personal-baseline recommendation or timeline', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  const source = {
    heartRateZones: false, activityLevel: false, exercise: false, sleep: true,
    hrv: true, rhr: true, sleepGoal: true, timeZone: 'unambiguous' as const,
  };
  const coverage = { knownContextMinutes: 0, rawHeartRateMinutes: 0, attributedMinutes: 0, lastKnownContextAt: null };
  await store.healthMetrics.upsertMetricResult(parseMetricResult({
    userId: 'u1', civilDate: '2026-08-22', metricName: 'recovery',
    metricVersion: WHOOP_STYLE_METRIC_VERSION, score: 81, status: null, quality: 'high', reason: null,
    evidence: [], source, coverage,
  }));

  let recordReads = 0;
  const view = await buildHomepageTodayView({
    provider: {
      capabilities: { mode: 'oauth', canSync: true },
      async listRecords() {
        recordReads += 1;
        return emptyUserHealthRecords();
      },
    },
    userId: 'u1', now: '2026-08-22T12:00:00.000Z', lastSuccessfulSyncAt: '2026-08-20T23:59:00.000Z',
    timeZone: 'UTC', healthMetrics: store.healthMetrics,
  });

  assert.equal(view.freshness, 'stale');
  assert.equal(view.primaryAction.kind, 'data_state');
  assert.doesNotMatch(view.primaryAction.text, /个人常态/);
  assert.equal(view.metrics.recovery.score, null);
  assert.equal(view.metrics.recovery.quality, 'unavailable');
  assert.doesNotMatch(view.metrics.recovery.detail, /个人常态/);
  assert.equal(view.metrics.strain.score, null);
  assert.equal(view.metrics.strain.status, 'unavailable');
  assert.equal(view.metrics.strain.timeline, undefined);
  assert.equal(recordReads, 1);
});

function recordsForOtherUser(sleepSession: SleepSession): HealthProvider {
  return {
    capabilities: { mode: 'demo', canSync: false },
    async listRecords(): Promise<UserHealthRecords> {
      return {
        sleepSessions: [sleepSession],
        dailyHrv: [],
        dailyRhr: [],
        trainingDays: [],
      };
    },
  };
}
