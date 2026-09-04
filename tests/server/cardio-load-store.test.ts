import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseCardioLoadBootstrap,
  parseDailyCardioLoad,
  parseDailyLoadCapacity,
  parseHeartRateMinuteEvidence,
  parseWeeklyCardioBaseline,
} from '../../src/domain/cardio-records';
import { CARDIO_LOAD_TRIMP_VERSION } from '../../src/domain/metric-types';
import { createMemoryStore } from '../../src/server/db/memory-store';

const userId = '11111111-1111-1111-1111-111111111111';
const otherUserId = '33333333-3333-3333-3333-333333333333';
const connectionId = '22222222-2222-2222-2222-222222222222';
const civilDate = '2026-09-04';

function connection() {
  return {
    id: connectionId,
    userId,
    healthUserId: 'health-user',
    legacyUserId: undefined,
    tokenEnvelopeCiphertext: Buffer.from('ciphertext'),
    tokenEnvelopeIv: Buffer.alloc(12),
    tokenEnvelopeAuthTag: Buffer.alloc(16),
    encryptionKeyVersion: 1,
    accessTokenExpiresAt: new Date('2026-09-04T12:00:00.000Z'),
    refreshTokenExpiresAt: new Date('2026-09-11T12:00:00.000Z'),
    grantedScopes: [],
    status: 'active' as const,
    lastErrorCode: undefined,
    connectedAt: new Date('2026-09-04T10:00:00.000Z'),
    updatedAt: new Date('2026-09-04T10:00:00.000Z'),
    lastSuccessfulSyncAt: undefined,
  };
}

function evidence() {
  return parseHeartRateMinuteEvidence({
    userId,
    sourceFamily: 'google-wearables',
    minuteStartUtc: '2026-09-04T09:00:00.000Z',
    segments: [
      { startOffsetMs: 0, endOffsetMs: 20_000, bpm: 100 },
      { startOffsetMs: 40_000, endOffsetMs: 60_000, bpm: 100 },
    ],
  });
}

function dailyLoad() {
  return parseDailyCardioLoad({
    userId,
    civilDate,
    metricVersion: CARDIO_LOAD_TRIMP_VERSION,
    status: 'scored',
    dailyLoad: 12.4,
    qualifiedSeconds: 3600,
    unverifiedElevatedHrSeconds: 120,
    rawHrCoverageSeconds: 43_200,
    awakeCoverageRatio: 0.8,
    motionSource: 'both',
    qualityState: 'qualified',
    rhrBaseBpm: 55,
    hrMaxEstBpm: 175,
    hrMaxProvenance: {
      filterRuleVersion: 'google-wearables-hrmax-v1',
      sourceFamily: 'google-wearables', minuteStartUtc: '2026-09-03T12:00:00.000Z', bpm: 175, coverageSeconds: 60, sampleCount: 1,
    },
    inputFingerprint: `sha256:${'a'.repeat(64)}`,
    calculationContext: { ianaTimeZone: 'Asia/Shanghai' },
  });
}

test('requires HRmax estimate and versioned peak provenance to agree', () => {
  const row = dailyLoad();

  assert.throws(() => parseDailyCardioLoad({ ...row, hrMaxProvenance: null }));
  assert.throws(() => parseDailyCardioLoad({ ...row, hrMaxEstBpm: 174 }));
  assert.throws(() => parseDailyCardioLoad({
    ...row,
    hrMaxProvenance: { ...row.hrMaxProvenance!, filterRuleVersion: 'unversioned-rule' },
  }));
});

test('stores only normalized per-minute derived BPM evidence', async () => {
  const store = createMemoryStore();
  await store.users.insert(userId);
  await store.connections.insert(connection());
  const row = evidence();

  await store.healthMetrics.upsertHeartRateMinuteEvidence([row]);
  const saved = await store.healthMetrics.listHeartRateMinuteEvidence({
    userId,
    fromUtc: '2026-09-04T00:00:00.000Z',
    toUtcExclusive: '2026-09-05T00:00:00.000Z',
  });

  assert.deepEqual(saved, [row]);
  assert.throws(() => parseHeartRateMinuteEvidence({
    ...row,
    segments: [
      { startOffsetMs: 30_000, endOffsetMs: 60_000, bpm: 100 },
      { startOffsetMs: 0, endOffsetMs: 20_000, bpm: 100 },
    ],
  }));
});

test('keeps versioned v3 daily, weekly, capacity, and bootstrap rows separate from v2', async () => {
  const store = createMemoryStore();
  await store.users.insert(userId);
  await store.connections.insert(connection());
  const daily = dailyLoad();
  const weekly = parseWeeklyCardioBaseline({
    userId,
    weekStart: '2026-08-31',
    metricVersion: CARDIO_LOAD_TRIMP_VERSION,
    status: 'stable',
    weeklyLoad: 80,
    weekToDateLoad: 80,
    rm4: 70,
    ewma4: 72,
    baseline: 72,
    inputFingerprint: `sha256:${'b'.repeat(64)}`,
  });
  const capacity = parseDailyLoadCapacity({
    userId,
    civilDate,
    metricVersion: CARDIO_LOAD_TRIMP_VERSION,
    status: 'scored',
    actualLoad: 12.4,
    usableLoad: 20,
    utilization: 0.62,
    historySampleCount: 28,
    usedGlobalFallback: false,
    recoveryTier: 'low',
    recoveryMetricVersion: 'whoop-style-v2',
    recoveryCivilDate: civilDate,
    recoveryQuality: 'high',
    recoveryInputFingerprint: `sha256:${'d'.repeat(64)}`,
    inputFingerprint: `sha256:${'c'.repeat(64)}`,
  });
  const bootstrap = parseCardioLoadBootstrap({
    userId,
    connectionId,
    metricVersion: CARDIO_LOAD_TRIMP_VERSION,
    status: 'failed',
    attemptedAt: '2026-09-04T10:00:00.000Z',
    completedAt: null,
    errorCode: 'upstream_unavailable',
  });

  await store.healthMetrics.upsertDailyCardioLoad(daily);
  await store.healthMetrics.upsertWeeklyCardioBaseline(weekly);
  await store.healthMetrics.upsertDailyLoadCapacity(capacity);
  await store.healthMetrics.upsertCardioLoadBootstrap(bootstrap);

  assert.deepEqual(await store.healthMetrics.getDailyCardioLoad({ userId, civilDate }), daily);
  assert.deepEqual(await store.healthMetrics.getWeeklyCardioBaseline({ userId, weekStart: '2026-08-31' }), weekly);
  assert.deepEqual(await store.healthMetrics.getDailyLoadCapacity({ userId, civilDate }), capacity);
  assert.deepEqual(await store.healthMetrics.readCardioLoadBootstrap({ userId, connectionId }), bootstrap);
});

test('scopes bootstrap reads and writes to the connection owner', async () => {
  const store = createMemoryStore();
  await store.users.insert(userId);
  await store.users.insert(otherUserId);
  await store.connections.insert(connection());
  const bootstrap = parseCardioLoadBootstrap({
    userId, connectionId, metricVersion: CARDIO_LOAD_TRIMP_VERSION, status: 'completed',
    attemptedAt: '2026-09-04T10:00:00.000Z', completedAt: '2026-09-04T10:01:00.000Z', errorCode: null,
  });

  await store.healthMetrics.upsertCardioLoadBootstrap(bootstrap);
  assert.equal(await store.healthMetrics.readCardioLoadBootstrap({ userId: otherUserId, connectionId }), undefined);
  await assert.rejects(store.healthMetrics.upsertCardioLoadBootstrap({ ...bootstrap, userId: otherUserId }));
});
