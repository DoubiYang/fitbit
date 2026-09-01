import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDailyCardio, parseDailyHeartRateZones, parseDailyTimeInZone } from '../../src/domain/cardio-records';
import { parseSleepSession, type SleepSession } from '../../src/domain/health-records';
import { WHOOP_STYLE_METRIC_VERSION } from '../../src/domain/metric-types';
import { DemoHealthProvider } from '../../src/server/health/demo-provider';
import { emptyUserHealthRecords, type HealthProvider, type UserHealthRecords } from '../../src/server/health/provider';
import { createMemoryStore } from '../../src/server/db/memory-store';
import { buildTodayView } from '../../src/server/dashboard/build-today';

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
