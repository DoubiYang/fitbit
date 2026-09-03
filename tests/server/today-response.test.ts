import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMetricResult } from '../../src/domain/cardio-records';
import { BODY_AGE_REFERENCE_VERSION } from '../../src/domain/body-age';
import { WHOOP_STYLE_METRIC_VERSION, type MetricCoverageState, type MetricSourceState } from '../../src/domain/metric-types';
import { loadConfig } from '../../src/server/config/env';
import { createMemoryStore } from '../../src/server/db/memory-store';
import { emptyUserHealthRecords } from '../../src/server/health/provider';
import { BODY_AGE_ALGORITHM_VERSION } from '../../src/server/health/body-age-recompute';
import { buildTodayResponse, buildTodayViewForUser } from '../../src/server/dashboard/today-response';

const coverage: MetricCoverageState = {
  knownContextMinutes: 600,
  rawHeartRateMinutes: 610,
  attributedMinutes: 24,
  lastKnownContextAt: '2026-08-24T11:50:00.000Z',
};

const source: MetricSourceState = {
  heartRateZones: true,
  activityLevel: true,
  exercise: false,
  sleep: true,
  hrv: true,
  rhr: true,
  sleepGoal: true,
  timeZone: 'unambiguous',
};

function oauthConfig() {
  const loaded = loadConfig({
    DATABASE_URL: 'postgresql://rhythm:x@db:5432/rhythm',
    GOOGLE_HEALTH_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_HEALTH_CLIENT_SECRET: 'client-secret',
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    SYNC_SECRET: 'test-sync-secret',
    APP_ORIGIN: 'http://localhost:3000',
  });
  assert.equal(loaded.kind, 'oauth');
  return loaded;
}

function result(input: {
  userId: string;
  civilDate: string;
  metricName: 'strain' | 'sleep_performance' | 'recovery';
  score: number | null;
  status?: 'complete' | 'provisional' | 'incomplete' | 'timezone_ambiguous' | 'unavailable' | null;
  quality?: 'unavailable' | 'provisional' | 'medium' | 'high' | null;
  reason?: string | null;
  evidenceLabel?: string;
}) {
  return parseMetricResult({
    userId: input.userId,
    civilDate: input.civilDate,
    metricName: input.metricName,
    metricVersion: WHOOP_STYLE_METRIC_VERSION,
    score: input.score,
    status: input.status ?? (input.metricName === 'strain' ? 'complete' : null),
    quality: input.quality ?? (input.metricName === 'recovery' ? 'medium' : null),
    reason: input.reason ?? null,
    evidence: [{ label: input.evidenceLabel ?? input.metricName, date: input.civilDate, value: input.score ?? 0 }],
    source,
    coverage,
  });
}

function assertNoTrainingPermission(text: string): void {
  assert.doesNotMatch(text, /可按原计划/);
  assert.doesNotMatch(text, /可以训练/);
  assert.doesNotMatch(text, /train as planned/i);
  assert.doesNotMatch(text, /训练许可/);
}

test('oauth today responses never fall back to demo_user', async () => {
  const response = await buildTodayResponse({ mode: 'oauth', id: '11111111-1111-1111-1111-111111111111' });
  const body = (await response.json()) as { userId: string };
  assert.equal(response.status, 200);
  assert.equal(body.userId, '11111111-1111-1111-1111-111111111111');
  assert.equal(JSON.stringify(body).includes('demo_user'), false);
});

test('today response serializes only the body-age dashboard allowlist', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.healthMetrics.updateBodyAgeProfile({ userId: 'u1', birthDate: '1988-04-20', referenceSex: 'female' });
  await store.healthMetrics.recordObservedHrPeak({ userId: 'u1', observedHrPeakBpm: 181, observedAt: '2026-08-24T10:00:00.000Z' });
  await store.healthMetrics.writeBodyAgeResult({
    userId: 'u1', algorithmVersion: BODY_AGE_ALGORITHM_VERSION,
    estimate: {
      age: 45, coverageDays: 7, latestInputCivilDate: '2026-08-24', route: 'daily_vo2',
      status: 'daily_vo2_provisional', referenceVersion: BODY_AGE_REFERENCE_VERSION,
      disclaimer: 'non_medical_non_calibrated_estimate',
      dataGaps: { dailyVo2DaysNeeded: 0, rhrDaysNeeded: 0, observedHrPeakRequired: false },
    },
    lastCalculatedCivilDate: '2026-08-24', referenceHash: 'sha256:reference-hash', inputFingerprint: 'sha256:fingerprint',
    profileRevision: 1, chronologicalAgeDeltaYears: 7, windowDays: 28,
    exclusionCounts: {
      invalidDailyVo2: 0, futureDailyVo2: 0, untrustedDailyVo2: 0,
      invalidDailyRhr: 0, futureDailyRhr: 0, untrustedDailyRhr: 0,
    },
    computedAt: '2026-08-24T12:00:00.000Z',
  });

  const response = await buildTodayResponse({ mode: 'oauth', id: 'u1' }, '2026-08-24T12:00:00.000Z', {
    config: oauthConfig(), store,
    snapshotForUser: async () => ({ syncedAt: new Date('2026-08-24T11:00:00.000Z'), records: emptyUserHealthRecords() }),
  });
  const body = await response.json() as { metrics: { bodyAge: Record<string, unknown> } };
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body.metrics.bodyAge).sort(), [
    'age', 'chronologicalAgeDeltaYears', 'coverageDays', 'dataGaps', 'disclaimer', 'edge',
    'label', 'lastCalculatedCivilDate', 'latestInputCivilDate', 'referenceVersion', 'route', 'status',
  ]);
  const serialized = JSON.stringify(body);
  for (const forbidden of [
    'birthDate', 'vo2Max', 'valueBpm', 'observedHrPeakBpm', 'sourceFamily', 'receivedAt', 'revision',
    'inputFingerprint', 'referenceHash', 'computedAt', 'oauth', 'token', 'scopes', 'accessToken', 'refreshToken',
    'providerPayload', 'googleRecord', 'raw',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(serialized.includes('1988-04-20'), false);
  assert.equal(serialized.includes('181'), false);
});

test('oauth today view reads stored v2 metrics and does not fetch live google records', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.healthMetrics.insertTimeZoneHistory({
    userId: 'u1',
    ianaTimeZone: 'UTC',
    effectiveAt: '2026-08-01T00:00:00.000Z',
    isBackfillAnchor: true,
  });
  await store.healthMetrics.upsertMetricResult(result({
    userId: 'u1',
    civilDate: '2026-08-24',
    metricName: 'strain',
    score: 8.4,
    status: 'complete',
    evidenceLabel: '剂量',
  }));
  await store.healthMetrics.upsertMetricResult(result({
    userId: 'u1',
    civilDate: '2026-08-24',
    metricName: 'recovery',
    score: 72,
    quality: 'high',
    evidenceLabel: 'HRV',
  }));
  await store.healthMetrics.upsertMetricResult(result({
    userId: 'u1',
    civilDate: '2026-08-24',
    metricName: 'sleep_performance',
    score: 88,
    evidenceLabel: '实际睡眠',
  }));

  let snapshotReads = 0;
  let googleReads = 0;
  const view = await buildTodayViewForUser({ mode: 'oauth', id: 'u1' }, '2026-08-24T12:00:00.000Z', {
    config: oauthConfig(),
    store,
    google: {
      async exchangeCode() {
        googleReads += 1;
        throw new Error('must not call Google');
      },
      async getIdentity() {
        googleReads += 1;
        throw new Error('must not call Google');
      },
      async revoke() {
        googleReads += 1;
      },
    },
    snapshotForUser: async (userId) => {
      snapshotReads += 1;
      assert.equal(userId, 'u1');
      return { syncedAt: new Date('2026-08-24T06:00:00.000Z'), records: emptyUserHealthRecords() };
    },
  });

  assert.equal(snapshotReads, 1);
  assert.equal(googleReads, 0);
  assert.equal(view?.userId, 'u1');
  assert.equal(view?.localDate, '2026-08-24');
  assert.equal(view?.metrics.strain.score, 8.4);
  assert.equal(view?.metrics.strain.status, 'complete');
  assert.equal(view?.metrics.recovery.score, 72);
  assert.equal(view?.metrics.recovery.quality, 'high');
  assert.equal(view?.metrics.sleepPerformance.score, 88);
  assert.equal(view?.metrics.strain.coverage?.knownContextMinutes, 600);
  assert.ok(view?.metrics.strain.evidence?.every((item) => item.date === '2026-08-24'));
});

test('oauth today view stays empty when no snapshot or metrics have been synced yet', async () => {
  const view = await buildTodayViewForUser({ mode: 'oauth', id: 'u1' }, '2026-08-24T12:00:00.000Z', {
    config: oauthConfig(),
    store: createMemoryStore(),
    snapshotForUser: async () => undefined,
  });
  assert.equal(view?.userId, 'u1');
  assert.equal(view?.metrics.recovery.score, null);
  assert.equal(view?.metrics.sleepPerformance.score, null);
  assert.equal(view?.primaryAction.kind, 'data_state');
});

test('oauth today view stays stale until a complete snapshot sync is recorded', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');

  const view = await buildTodayViewForUser({ mode: 'oauth', id: 'u1' }, '2026-08-24T12:00:00.000Z', {
    config: oauthConfig(),
    store,
    snapshotForUser: async () => ({
      syncedAt: new Date('2026-08-24T11:59:00.000Z'),
      records: emptyUserHealthRecords(),
    }),
  });

  assert.equal(view?.freshness, 'stale');
});

test('unauthenticated today is 401 and unconfigured is 503', async () => {
  const unauthenticated = await buildTodayResponse({ mode: 'unauthenticated' });
  const unconfigured = await buildTodayResponse({ mode: 'unconfigured' });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unconfigured.status, 503);
  assert.equal(JSON.stringify(await unauthenticated.json()).includes('demo_user'), false);
  assert.equal(JSON.stringify(await unconfigured.json()).includes('demo_user'), false);
});

test('high recovery produces a factual trend explanation rather than permission to train', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.healthMetrics.insertTimeZoneHistory({
    userId: 'u1',
    ianaTimeZone: 'UTC',
    effectiveAt: '2026-08-01T00:00:00.000Z',
    isBackfillAnchor: true,
  });
  await store.healthMetrics.upsertMetricResult(result({
    userId: 'u1',
    civilDate: '2026-08-24',
    metricName: 'recovery',
    score: 81,
    quality: 'high',
    evidenceLabel: 'HRV',
  }));
  await store.healthMetrics.upsertMetricResult(result({
    userId: 'u1',
    civilDate: '2026-08-24',
    metricName: 'strain',
    score: 9.1,
    status: 'complete',
  }));

  const view = await buildTodayViewForUser({ mode: 'oauth', id: 'u1' }, '2026-08-24T12:00:00.000Z', {
    config: oauthConfig(),
    store,
    snapshotForUser: async () => ({ syncedAt: new Date('2026-08-24T06:00:00.000Z'), records: emptyUserHealthRecords() }),
  });

  assert.equal(view?.primaryAction.kind, 'recommendation');
  assert.match(view?.primaryAction.text ?? '', /个人常态/);
  assertNoTrainingPermission(view?.primaryAction.text ?? '');
  assert.equal(view?.metrics.recovery.quality, 'high');
  assert.ok(view?.primaryAction.evidence.every((item) => item.date === '2026-08-24'));
});

test('provisional and unavailable recovery produce a data-quality explanation', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.users.insert('u2');
  await store.healthMetrics.insertTimeZoneHistory({
    userId: 'u1',
    ianaTimeZone: 'UTC',
    effectiveAt: '2026-08-01T00:00:00.000Z',
    isBackfillAnchor: true,
  });
  await store.healthMetrics.upsertMetricResult(result({
    userId: 'u1',
    civilDate: '2026-08-24',
    metricName: 'recovery',
    score: 60,
    quality: 'provisional',
    evidenceLabel: 'HRV',
  }));
  await store.healthMetrics.upsertMetricResult(result({
    userId: 'u2',
    civilDate: '2026-08-24',
    metricName: 'recovery',
    score: 99,
    quality: 'high',
    evidenceLabel: 'other-user-hrv',
  }));

  const provisional = await buildTodayViewForUser({ mode: 'oauth', id: 'u1' }, '2026-08-24T12:00:00.000Z', {
    config: oauthConfig(),
    store,
    snapshotForUser: async () => ({ syncedAt: new Date('2026-08-24T06:00:00.000Z'), records: emptyUserHealthRecords() }),
  });
  assert.equal(provisional?.primaryAction.kind, 'data_state');
  assert.match(provisional?.primaryAction.text ?? '', /数据/);
  assertNoTrainingPermission(provisional?.primaryAction.text ?? '');
  assert.equal(JSON.stringify(provisional).includes('other-user-hrv'), false);
  assert.ok(provisional?.primaryAction.evidence.every((item) => item.date === '2026-08-24'));

  const unavailable = await buildTodayViewForUser({ mode: 'oauth', id: 'u3' }, '2026-08-24T12:00:00.000Z', {
    config: oauthConfig(),
    store,
    snapshotForUser: async () => undefined,
  });
  assert.equal(unavailable?.primaryAction.kind, 'data_state');
  assert.match(unavailable?.primaryAction.text ?? '', /数据/);
  assertNoTrainingPermission(unavailable?.primaryAction.text ?? '');
});
