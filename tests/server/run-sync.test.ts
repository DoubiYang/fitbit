import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConnectionRow } from '../../src/server/auth/types';
import { loadConfig } from '../../src/server/config/env';
import { encryptTokenEnvelope } from '../../src/server/crypto/token-envelope';
import { createMemoryStore } from '../../src/server/db/memory-store';
import type { HealthApiClient } from '../../src/server/health/health-api';
import type { GoogleDataPoint } from '../../src/server/health/map-records';
import { emptyUserHealthRecords, type UserHealthRecords } from '../../src/server/health/provider';
import { syncUserConnection } from '../../src/server/health/run-sync';
import type { HealthSnapshot } from '../../src/server/health/snapshot-store';

const key = Buffer.alloc(32, 3).toString('base64');
const keyBuffer = Buffer.alloc(32, 3);

function oauthConfig() {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://rhythm:x@db:5432/rhythm',
    GOOGLE_HEALTH_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_HEALTH_CLIENT_SECRET: 'secret',
    TOKEN_ENCRYPTION_KEY: key,
    SYNC_SECRET: 'test-sync-secret',
    APP_ORIGIN: 'http://localhost:3000',
  });
  if (config.kind !== 'oauth') {
    throw new Error('expected oauth');
  }
  return config;
}

function connection(overrides: Partial<ConnectionRow> & Pick<ConnectionRow, 'id' | 'userId' | 'healthUserId'>): ConnectionRow {
  return {
    legacyUserId: undefined,
    tokenEnvelopeCiphertext: Buffer.from('x'),
    tokenEnvelopeIv: Buffer.from('y'),
    tokenEnvelopeAuthTag: Buffer.from('z'),
    encryptionKeyVersion: 1,
    accessTokenExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    refreshTokenExpiresAt: new Date('2099-01-08T00:00:00.000Z'),
    grantedScopes: [],
    status: 'active',
    lastErrorCode: undefined,
    connectedAt: new Date('2026-08-24T00:00:00.000Z'),
    updatedAt: new Date('2026-08-24T00:00:00.000Z'),
    lastSuccessfulSyncAt: undefined,
    ...overrides,
  };
}

test('initial sync only reads the selected active user for the UTC-wide 35-day backfill range', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.users.insert('u2');
  await store.users.insert('u3');
  await store.connections.insert(connection({ id: 'c1', userId: 'u1', healthUserId: 'h1' }));
  await store.connections.insert(connection({ id: 'c2', userId: 'u2', healthUserId: 'h2' }));
  await store.connections.insert(connection({ id: 'c3', userId: 'u3', healthUserId: 'h3', status: 'disconnected' }));

  const seen: string[] = [];
  const result = await syncUserConnection({
    config: oauthConfig(),
    store,
    userId: 'u1',
    now: new Date('2026-08-24T12:00:00.000Z'),
    syncOne: async (row, range) => {
      seen.push(`${row.userId}:${range.from}:${range.to}`);
    },
  });

  assert.equal(result, true);
  assert.deepEqual(seen, ['u1:2026-07-19:2026-08-24']);
});

test('35-day snapshot window uses a UTC-wide range, not Asia/Shanghai', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.connections.insert(connection({ id: 'c1', userId: 'u1', healthUserId: 'h1' }));

  const seen: string[] = [];
  await syncUserConnection({
    config: oauthConfig(),
    store,
    userId: 'u1',
    now: new Date('2026-08-23T23:00:00.000Z'),
    syncOne: async (row, range) => {
      seen.push(`${row.userId}:${range.from}:${range.to}`);
    },
  });

  assert.deepEqual(seen, ['u1:2026-07-18:2026-08-23']);
  assert.notEqual(seen[0], 'u1:2026-07-20:2026-08-23');
});

test('initial UTC-wide backfill covers a UTC-8 user local day at a UTC date boundary', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.connections.insert(liveConnection('u1', 'c1'));

  const seen: string[] = [];
  await syncUserConnection({
    config: oauthConfig(),
    store,
    userId: 'u1',
    now: new Date('2026-08-24T00:30:00.000Z'),
    syncOne: async (row, range) => {
      seen.push(`${row.userId}:${range.from}:${range.to}`);
    },
  });

  assert.deepEqual(seen, ['u1:2026-07-19:2026-08-24']);
});

test('initial sync does not read an expired or disconnected connection', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.connections.insert(connection({ id: 'c1', userId: 'u1', healthUserId: 'h1', status: 'expired' }));

  const result = await syncUserConnection({
    config: oauthConfig(),
    store,
    userId: 'u1',
    syncOne: async () => {
      throw new Error('must not sync');
    },
  });

  assert.equal(result, false);
});

function liveConnection(userId: string, connectionId: string): ConnectionRow {
  const encrypted = encryptTokenEnvelope({ accessToken: 'access', refreshToken: 'refresh' }, keyBuffer, connectionId, userId);
  return connection({
    id: connectionId,
    userId,
    healthUserId: `h-${userId}`,
    tokenEnvelopeCiphertext: encrypted.ciphertext,
    tokenEnvelopeIv: encrypted.iv,
    tokenEnvelopeAuthTag: encrypted.authTag,
    encryptionKeyVersion: 1,
  });
}

function createFakeApi(pages: Partial<Record<string, GoogleDataPoint[][]>>) {
  const requests: Array<{ dataType: string; filter: string }> = [];
  async function* iterate(input: { dataType: string; filter: string }) {
    requests.push({ dataType: input.dataType, filter: input.filter });
    for (const page of pages[input.dataType] ?? [[]]) {
      yield page;
    }
  }
  const api: HealthApiClient & { requests: typeof requests } = {
    requests,
    async *iterateReconciledDataPoints(input) {
      yield* iterate(input);
    },
    async listDataPoints(input) {
      if (input.dataType === 'heart-rate' || input.dataType === 'activity-level') {
        throw new Error(`${input.dataType} must use iterateReconciledDataPoints`);
      }
      const collected: GoogleDataPoint[] = [];
      for await (const page of iterate(input)) collected.push(...page);
      return collected;
    },
  };
  return api;
}

test('live sync applies snapshot sleep before cardio recompute and sets hourly nextSyncAt', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.connections.insert(liveConnection('u1', 'c1'));
  const snapshot: UserHealthRecords = {
    ...emptyUserHealthRecords(),
    sleepSessions: [
      {
        userId: 'u1',
        source: 'google_health',
        sourceRecordId: 'sleep-1',
        id: 'sleep-1',
        startTime: '2026-08-22T11:30:00.000Z',
        endTime: '2026-08-22T12:30:00.000Z',
        civilEndDate: '2026-08-22',
        utcOffsetMinutes: 0,
        minutesAsleep: 400,
        timeInBedMinutes: 480,
        awakeMinutes: 80,
        isNap: true,
        processed: true,
      },
    ],
  };
  let persisted: UserHealthRecords | undefined;
  const api = createFakeApi({
    sleep: [
      [
        {
          name: 'sleep-1',
          sleep: {
            type: 'STAGES',
            interval: {
              startTime: '2026-08-22T11:30:00.000Z',
              endTime: '2026-08-22T12:30:00.000Z',
              endUtcOffset: '0s',
              civilEndTime: { date: { year: 2026, month: 8, day: 22 } },
            },
            metadata: { nap: true, processed: true },
            summary: { minutesAsleep: '400', minutesInSleepPeriod: '480', minutesAwake: '80' },
          },
        },
      ],
    ],
    'heart-rate': [
      [
        {
          heartRate: {
            sampleTime: { physicalTime: '2026-08-22T12:00:00.000Z', utcOffset: '0s' },
            beatsPerMinute: '110',
          },
        },
      ],
    ],
    'activity-level': [
      [
        {
          activityLevel: {
            interval: { startTime: '2026-08-22T12:00:00.000Z', endTime: '2026-08-22T12:01:00.000Z' },
            activityLevelType: 'LIGHTLY_ACTIVE',
          },
        },
      ],
    ],
    'daily-heart-rate-zones': [
      [
        {
          dailyHeartRateZones: {
            date: { year: 2026, month: 8, day: 22 },
            heartRateZones: [
              { heartRateZoneType: 'LIGHT', minBeatsPerMinute: '97', maxBeatsPerMinute: '116' },
              { heartRateZoneType: 'MODERATE', minBeatsPerMinute: '117', maxBeatsPerMinute: '136' },
              { heartRateZoneType: 'VIGOROUS', minBeatsPerMinute: '137', maxBeatsPerMinute: '155' },
              { heartRateZoneType: 'PEAK', minBeatsPerMinute: '156', maxBeatsPerMinute: '200' },
            ],
          },
        },
      ],
    ],
  });

  const result = await syncUserConnection({
    config: oauthConfig(),
    store,
    userId: 'u1',
    now: new Date('2026-08-24T12:00:00.000Z'),
    api,
    persistSnapshot: async (_userId, records) => {
      persisted = records;
    },
    loadSnapshot: async () => ({ records: snapshot, syncedAt: new Date('2026-08-23T12:00:00.000Z') }),
    loadRecords: async () => persisted ?? snapshot,
    refresher: {
      async refresh() {
        throw new Error('should not refresh');
      },
    },
  });

  assert.equal(result, true);
  const cardio = await store.healthMetrics.getDailyCardio({ userId: 'u1', civilDate: '2026-08-22' });
  assert.equal(cardio?.dose, 0);
  assert.equal(cardio?.attributedMinutes, 0);
  const scheduled = await store.connections.findByUserId('u1');
  assert.equal(scheduled?.nextSyncAt?.toISOString(), '2026-08-24T13:00:00.000Z');
  assert.ok(api.requests.some((request) => request.dataType === 'sleep'));
  assert.ok(api.requests.some((request) => request.dataType === 'heart-rate'));
});

test('a daily RHR 429 persists successful snapshot types and retries only RHR sooner than hourly', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.connections.insert(liveConnection('u1', 'c1'));
  const previous = {
    ...emptyUserHealthRecords(),
    dailyHrv: [{ userId: 'u1', source: 'google_health' as const, sourceRecordId: 'hrv-keep', date: '2026-08-04', valueMs: 44 }],
  };
  const api = createFakeApi({
    sleep: [
      [
        {
          name: 'sleep-22',
          sleep: {
            type: 'STAGES',
            interval: {
              startTime: '2026-08-22T03:00:00.000Z',
              endTime: '2026-08-22T11:00:00.000Z',
              endUtcOffset: '0s',
              civilEndTime: { date: { year: 2026, month: 8, day: 22 } },
            },
            summary: { minutesAsleep: '420', minutesInSleepPeriod: '480', minutesAwake: '60' },
          },
        },
      ],
    ],
    'daily-heart-rate-variability': [
      [
        {
          name: 'hrv-22',
          dailyHeartRateVariability: {
            date: { year: 2026, month: 8, day: 22 },
            averageHeartRateVariabilityMilliseconds: 52,
          },
        },
      ],
    ],
    'heart-rate': [
      [
        {
          heartRate: {
            sampleTime: { physicalTime: '2026-08-22T12:00:00.000Z', utcOffset: '0s' },
            beatsPerMinute: '110',
          },
        },
      ],
    ],
    'daily-heart-rate-zones': [
      [
        {
          dailyHeartRateZones: {
            date: { year: 2026, month: 8, day: 22 },
            heartRateZones: [
              { heartRateZoneType: 'LIGHT', minBeatsPerMinute: '97', maxBeatsPerMinute: '116' },
              { heartRateZoneType: 'MODERATE', minBeatsPerMinute: '117', maxBeatsPerMinute: '136' },
              { heartRateZoneType: 'VIGOROUS', minBeatsPerMinute: '137', maxBeatsPerMinute: '155' },
              { heartRateZoneType: 'PEAK', minBeatsPerMinute: '156', maxBeatsPerMinute: '200' },
            ],
          },
        },
      ],
    ],
  });
  const originalList = api.listDataPoints.bind(api);
  let rhrRateLimited = true;
  api.listDataPoints = async (input) => {
    if (input.dataType === 'daily-resting-heart-rate' && rhrRateLimited) {
      throw new Error('health api 429');
    }
    return originalList(input);
  };
  let persisted: UserHealthRecords | undefined;

  const result = await syncUserConnection({
    config: oauthConfig(),
    store,
    userId: 'u1',
    now: new Date('2026-08-24T12:00:00.000Z'),
    api,
    persistSnapshot: async (_userId, records) => {
      persisted = records;
    },
    loadSnapshot: async () => ({ records: previous, syncedAt: new Date('2026-08-23T12:00:00.000Z') }),
    loadRecords: async () => persisted ?? previous,
    refresher: {
      async refresh() {
        throw new Error('should not refresh');
      },
    },
  });

  assert.equal(result, true);
  const minutes = await store.healthMetrics.listMinutesByCivilDate({ userId: 'u1', civilDate: '2026-08-22' });
  assert.ok(minutes.length > 0);
  const heartRate = await store.healthMetrics.readCursor({ connectionId: 'c1', dataType: 'heart-rate' });
  assert.equal(heartRate?.successfulWatermark?.toISOString(), '2026-08-24T12:00:00.000Z');
  assert.equal(persisted?.sleepSessions.length, 1);
  assert.deepEqual(persisted?.dailyHrv.map((row) => [row.date, row.valueMs]), [
    ['2026-08-04', 44],
    ['2026-08-22', 52],
  ]);
  const sleep = await store.healthMetrics.readCursor({ connectionId: 'c1', dataType: 'sleep' });
  assert.equal(sleep?.successfulWatermark?.toISOString(), '2026-08-24T12:00:00.000Z');
  const hrv = await store.healthMetrics.readCursor({ connectionId: 'c1', dataType: 'daily-heart-rate-variability' });
  assert.equal(hrv?.successfulWatermark?.toISOString(), '2026-08-24T12:00:00.000Z');
  const rhr = await store.healthMetrics.readCursor({ connectionId: 'c1', dataType: 'daily-resting-heart-rate' });
  assert.equal(rhr?.successfulWatermark, undefined);
  assert.equal(rhr?.lastErrorCode, 'rate_limited');
  assert.equal(rhr?.nextAttemptAt?.toISOString(), '2026-08-24T12:30:00.000Z');
  const scheduled = await store.connections.findByUserId('u1');
  assert.equal(scheduled?.nextSyncAt?.toISOString(), '2026-08-24T12:30:00.000Z');

  rhrRateLimited = false;
  api.requests.length = 0;
  await syncUserConnection({
    config: oauthConfig(),
    store,
    userId: 'u1',
    now: new Date('2026-08-24T12:30:00.000Z'),
    api,
    persistSnapshot: async (_userId, records) => {
      persisted = records;
    },
    loadSnapshot: async () => ({ records: previous, syncedAt: new Date('2026-08-23T12:00:00.000Z') }),
    loadRecords: async () => persisted ?? previous,
    refresher: {
      async refresh() {
        throw new Error('should not refresh');
      },
    },
  });

  assert.deepEqual(
    api.requests
      .filter((request) =>
        ['sleep', 'daily-heart-rate-variability', 'daily-resting-heart-rate', 'exercise'].includes(request.dataType),
      )
      .map((request) => request.dataType),
    ['daily-resting-heart-rate'],
  );
  const retriedSleep = await store.healthMetrics.readCursor({ connectionId: 'c1', dataType: 'sleep' });
  const retriedHrv = await store.healthMetrics.readCursor({ connectionId: 'c1', dataType: 'daily-heart-rate-variability' });
  const retriedRhr = await store.healthMetrics.readCursor({ connectionId: 'c1', dataType: 'daily-resting-heart-rate' });
  assert.equal(retriedSleep?.successfulWatermark?.toISOString(), '2026-08-24T12:00:00.000Z');
  assert.equal(retriedSleep?.nextAttemptAt?.toISOString(), '2026-08-24T13:00:00.000Z');
  assert.equal(retriedHrv?.successfulWatermark?.toISOString(), '2026-08-24T12:00:00.000Z');
  assert.equal(retriedHrv?.nextAttemptAt?.toISOString(), '2026-08-24T13:00:00.000Z');
  assert.equal(retriedRhr?.successfulWatermark?.toISOString(), '2026-08-24T12:30:00.000Z');
});

test('an initial RHR retry retains the 35-day backfill window without refetching successful snapshot types', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.connections.insert(liveConnection('u1', 'c1'));
  const api = createFakeApi({});
  const originalList = api.listDataPoints.bind(api);
  let rhrRateLimited = true;
  api.listDataPoints = async (input) => {
    if (input.dataType === 'daily-resting-heart-rate' && rhrRateLimited) {
      throw new Error('health api 429');
    }
    return originalList(input);
  };
  let persisted: HealthSnapshot | undefined;
  const sync = async (now: Date) =>
    syncUserConnection({
      config: oauthConfig(),
      store,
      userId: 'u1',
      now,
      api,
      persistSnapshot: async (_userId, records, syncedAt) => {
        persisted = { records, syncedAt };
      },
      loadSnapshot: async () => persisted,
      loadRecords: async () => persisted?.records ?? emptyUserHealthRecords(),
      refresher: { async refresh() { throw new Error('should not refresh'); } },
    });

  await sync(new Date('2026-08-24T12:00:00.000Z'));
  rhrRateLimited = false;
  api.requests.length = 0;
  await sync(new Date('2026-08-24T12:30:00.000Z'));

  const snapshotRequests = api.requests.filter((request) =>
    ['sleep', 'daily-heart-rate-variability', 'daily-resting-heart-rate', 'exercise'].includes(request.dataType),
  );
  assert.deepEqual(snapshotRequests.map((request) => request.dataType), ['daily-resting-heart-rate']);
  assert.match(snapshotRequests[0]?.filter ?? '', /daily_resting_heart_rate\.date >= "2026-07-19"/);
});

test('a later snapshot sleep recomputes historical strain without another HR backfill', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.connections.insert(liveConnection('u1', 'c1'));
  const now = new Date('2026-08-24T12:00:00.000Z');
  let snapshotFailed = true;
  const api = createFakeApi({
    'heart-rate': [
      [
        {
          heartRate: {
            sampleTime: { physicalTime: '2026-08-22T12:00:00.000Z', utcOffset: '0s' },
            beatsPerMinute: '110',
          },
        },
      ],
    ],
    'activity-level': [
      [
        {
          activityLevel: {
            interval: { startTime: '2026-08-22T12:00:00.000Z', endTime: '2026-08-22T12:01:00.000Z' },
            activityLevelType: 'LIGHTLY_ACTIVE',
          },
        },
      ],
    ],
    'daily-heart-rate-zones': [
      [
        {
          dailyHeartRateZones: {
            date: { year: 2026, month: 8, day: 22 },
            heartRateZones: [
              { heartRateZoneType: 'LIGHT', minBeatsPerMinute: '97', maxBeatsPerMinute: '116' },
              { heartRateZoneType: 'MODERATE', minBeatsPerMinute: '117', maxBeatsPerMinute: '136' },
              { heartRateZoneType: 'VIGOROUS', minBeatsPerMinute: '137', maxBeatsPerMinute: '155' },
              { heartRateZoneType: 'PEAK', minBeatsPerMinute: '156', maxBeatsPerMinute: '200' },
            ],
          },
        },
      ],
    ],
  });
  const originalList = api.listDataPoints.bind(api);
  const originalIterate = api.iterateReconciledDataPoints.bind(api);
  api.listDataPoints = async (input) => {
    if (
      snapshotFailed &&
      (input.dataType === 'sleep' ||
        input.dataType === 'daily-heart-rate-variability' ||
        input.dataType === 'daily-resting-heart-rate')
    ) {
      throw new Error('health api 429');
    }
    if (input.dataType === 'sleep') {
      return [
        {
          name: 'sleep-overlap',
          sleep: {
            type: 'STAGES',
            interval: {
              startTime: '2026-08-22T11:30:00.000Z',
              endTime: '2026-08-22T12:30:00.000Z',
              endUtcOffset: '0s',
              civilEndTime: { date: { year: 2026, month: 8, day: 22 } },
            },
            metadata: { nap: true, processed: true },
            summary: { minutesAsleep: '60', minutesInSleepPeriod: '60', minutesAwake: '0' },
          },
        },
      ];
    }
    return originalList(input);
  };
  api.iterateReconciledDataPoints = async function* (input) {
    if (snapshotFailed) {
      yield* originalIterate(input);
      return;
    }
    yield [];
  };

  const syncOpts = {
    config: oauthConfig(),
    store,
    userId: 'u1',
    now,
    api,
    persistSnapshot: async () => {},
    loadSnapshot: async () => undefined,
    refresher: { async refresh() { throw new Error('should not refresh'); } },
  };

  await syncUserConnection(syncOpts);
  const before = await store.healthMetrics.getDailyCardio({ userId: 'u1', civilDate: '2026-08-22' });
  assert.ok((before?.dose ?? 0) > 0);
  assert.ok((before?.attributedMinutes ?? 0) > 0);

  snapshotFailed = false;
  await syncUserConnection({
    ...syncOpts,
    now: new Date('2026-08-24T12:30:00.000Z'),
  });
  const after = await store.healthMetrics.getDailyCardio({ userId: 'u1', civilDate: '2026-08-22' });
  assert.equal(after?.dose, 0);
  assert.equal(after?.attributedMinutes, 0);
  const heartRate = await store.healthMetrics.readCursor({ connectionId: 'c1', dataType: 'heart-rate' });
  assert.equal(heartRate?.successfulWatermark?.toISOString(), now.toISOString());
});

test('a snapshot-only HRV revision recomputes Recovery when cardio pages are empty', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.connections.insert(liveConnection('u1', 'c1'));
  const api = createFakeApi({});
  const originalList = api.listDataPoints.bind(api);
  api.listDataPoints = async (input) => {
    if (input.dataType === 'daily-heart-rate-variability') {
      return [
        {
          name: 'hrv-23',
          dailyHeartRateVariability: {
            date: { year: 2026, month: 8, day: 23 },
            averageHeartRateVariabilityMilliseconds: 61,
          },
        },
      ];
    }
    return originalList(input);
  };

  await syncUserConnection({
    config: oauthConfig(),
    store,
    userId: 'u1',
    now: new Date('2026-08-24T12:00:00.000Z'),
    api,
    persistSnapshot: async () => {},
    loadSnapshot: async () => undefined,
    refresher: { async refresh() { throw new Error('should not refresh'); } },
  });

  const recovery = await store.healthMetrics.getMetricResult({
    userId: 'u1',
    civilDate: '2026-08-23',
    metricName: 'recovery',
  });
  assert.ok(recovery);
  assert.equal(recovery.source.hrv, true);
});

test('does not ingest cardio after the connection is no longer syncable', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.connections.insert(liveConnection('u1', 'c1'));
  const api = createFakeApi({
    'heart-rate': [
      [
        {
          heartRate: {
            sampleTime: { physicalTime: '2026-08-22T12:00:00.000Z', utcOffset: '0s' },
            beatsPerMinute: '110',
          },
        },
      ],
    ],
  });
  const originalList = api.listDataPoints.bind(api);
  api.listDataPoints = async (input) => {
    const current = await store.connections.findByUserId('u1');
    if (current) {
      await store.connections.update({
        ...current,
        status: 'disconnected',
        tokenEnvelopeCiphertext: undefined,
        tokenEnvelopeIv: undefined,
        tokenEnvelopeAuthTag: undefined,
        nextSyncAt: undefined,
      });
    }
    return originalList(input);
  };

  const result = await syncUserConnection({
    config: oauthConfig(),
    store,
    userId: 'u1',
    now: new Date('2026-08-24T12:00:00.000Z'),
    api,
    persistSnapshot: async () => {},
    loadSnapshot: async () => undefined,
    refresher: { async refresh() { throw new Error('should not refresh'); } },
  });

  assert.equal(result, false);
  const minutes = await store.healthMetrics.listMinutesByCivilDate({ userId: 'u1', civilDate: '2026-08-22' });
  assert.equal(minutes.length, 0);
});

test('aborts cardio ingest when disconnect happens after snapshot extraDates', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.connections.insert(liveConnection('u1', 'c1'));
  const api = createFakeApi({
    'heart-rate': [
      [
        {
          heartRate: {
            sampleTime: { physicalTime: '2026-08-22T12:00:00.000Z', utcOffset: '0s' },
            beatsPerMinute: '110',
          },
        },
      ],
    ],
  });
  const originalList = api.listDataPoints.bind(api);
  const originalIterate = api.iterateReconciledDataPoints.bind(api);
  api.listDataPoints = async (input) => {
    if (input.dataType === 'sleep') {
      return [
        {
          name: 'sleep-22',
          sleep: {
            type: 'STAGES',
            interval: {
              startTime: '2026-08-21T22:00:00.000Z',
              endTime: '2026-08-22T06:00:00.000Z',
              endUtcOffset: '0s',
              civilEndTime: { date: { year: 2026, month: 8, day: 22 } },
            },
            metadata: { nap: false, processed: true },
            summary: { minutesAsleep: '400', minutesInSleepPeriod: '480', minutesAwake: '80' },
          },
        },
      ];
    }
    return originalList(input);
  };
  api.iterateReconciledDataPoints = async function* (input) {
    if (input.dataType === 'heart-rate') {
      const current = await store.connections.findByUserId('u1');
      if (current) {
        await store.connections.update({
          ...current,
          status: 'disconnected',
          tokenEnvelopeCiphertext: undefined,
          tokenEnvelopeIv: undefined,
          tokenEnvelopeAuthTag: undefined,
          nextSyncAt: undefined,
        });
      }
    }
    yield* originalIterate(input);
  };

  const result = await syncUserConnection({
    config: oauthConfig(),
    store,
    userId: 'u1',
    now: new Date('2026-08-24T12:00:00.000Z'),
    api,
    persistSnapshot: async () => {},
    loadSnapshot: async () => undefined,
    refresher: {
      async refresh() {
        throw new Error('should not refresh');
      },
    },
  });

  assert.equal(result, false);
  assert.equal((await store.healthMetrics.listMinutesByCivilDate({ userId: 'u1', civilDate: '2026-08-22' })).length, 0);
  assert.deepEqual(await store.healthMetrics.listMetricResults({ userId: 'u1', civilDate: '2026-08-22' }), []);
  assert.deepEqual(await store.healthMetrics.listMetricResults({ userId: 'u1', civilDate: '2026-08-23' }), []);
  const heartRate = await store.healthMetrics.readCursor({ connectionId: 'c1', dataType: 'heart-rate' });
  assert.equal(heartRate?.successfulWatermark, undefined);
});

function priorDates(endExclusive: string, count: number): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${endExclusive}T00:00:00.000Z`);
  for (let index = 0; index < count; index += 1) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates.reverse();
}

test('a failed snapshot keeps Recovery provisional from the previous snapshot sync time', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  const now = new Date('2026-08-24T12:00:00.000Z');
  const syncedAt = new Date(now.getTime() - 37 * 60 * 60 * 1_000);
  await store.connections.insert({
    ...liveConnection('u1', 'c1'),
    lastSuccessfulSyncAt: syncedAt,
  });
  const historyDates = priorDates('2026-08-23', 28);
  const previous: UserHealthRecords = {
    ...emptyUserHealthRecords(),
    dailyHrv: [
      ...historyDates.map((date, index) => ({
        userId: 'u1',
        source: 'google_health' as const,
        sourceRecordId: `hrv-${date}`,
        date,
        valueMs: 40 + (index % 5),
      })),
      { userId: 'u1', source: 'google_health', sourceRecordId: 'hrv-23', date: '2026-08-23', valueMs: 55 },
    ],
    dailyRhr: [
      ...historyDates.map((date, index) => ({
        userId: 'u1',
        source: 'google_health' as const,
        sourceRecordId: `rhr-${date}`,
        date,
        valueBpm: 50 + (index % 4),
      })),
      { userId: 'u1', source: 'google_health', sourceRecordId: 'rhr-23', date: '2026-08-23', valueBpm: 52 },
    ],
  };
  const api = createFakeApi({
    'heart-rate': [
      [
        {
          heartRate: {
            sampleTime: { physicalTime: '2026-08-23T12:00:00.000Z', utcOffset: '0s' },
            beatsPerMinute: '70',
          },
        },
      ],
    ],
  });
  const originalList = api.listDataPoints.bind(api);
  api.listDataPoints = async (input) => {
    if (
      input.dataType === 'sleep' ||
      input.dataType === 'daily-heart-rate-variability' ||
      input.dataType === 'daily-resting-heart-rate'
    ) {
      throw new Error('health api 429');
    }
    return originalList(input);
  };

  await syncUserConnection({
    config: oauthConfig(),
    store,
    userId: 'u1',
    now,
    api,
    persistSnapshot: async () => {},
    loadSnapshot: async () => ({ records: previous, syncedAt }),
    loadRecords: async () => previous,
    refresher: { async refresh() { throw new Error('should not refresh'); } },
  });

  const recovery = await store.healthMetrics.getMetricResult({
    userId: 'u1',
    civilDate: '2026-08-23',
    metricName: 'recovery',
  });
  assert.ok(recovery);
  assert.equal(recovery.quality, 'provisional');
});

test('partial snapshot success does not mark Recovery fresh before a complete snapshot succeeds', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  const now = new Date('2026-08-24T12:00:00.000Z');
  await store.connections.insert(liveConnection('u1', 'c1'));
  const historyDates = priorDates('2026-08-23', 28);
  const previous: UserHealthRecords = {
    ...emptyUserHealthRecords(),
    dailyHrv: [
      ...historyDates.map((date, index) => ({
        userId: 'u1',
        source: 'google_health' as const,
        sourceRecordId: `hrv-${date}`,
        date,
        valueMs: 40 + (index % 5),
      })),
      { userId: 'u1', source: 'google_health', sourceRecordId: 'hrv-23', date: '2026-08-23', valueMs: 55 },
    ],
    dailyRhr: [
      ...historyDates.map((date, index) => ({
        userId: 'u1',
        source: 'google_health' as const,
        sourceRecordId: `rhr-${date}`,
        date,
        valueBpm: 50 + (index % 4),
      })),
      { userId: 'u1', source: 'google_health', sourceRecordId: 'rhr-23', date: '2026-08-23', valueBpm: 52 },
    ],
  };
  const api = createFakeApi({
    'heart-rate': [
      [
        {
          heartRate: {
            sampleTime: { physicalTime: '2026-08-23T12:00:00.000Z', utcOffset: '0s' },
            beatsPerMinute: '70',
          },
        },
      ],
    ],
  });
  const originalList = api.listDataPoints.bind(api);
  api.listDataPoints = async (input) => {
    if (input.dataType === 'sleep') {
      throw new Error('health api 429');
    }
    return originalList(input);
  };

  await syncUserConnection({
    config: oauthConfig(),
    store,
    userId: 'u1',
    now,
    api,
    persistSnapshot: async () => {},
    loadSnapshot: async () => ({ records: previous, syncedAt: now }),
    loadRecords: async () => previous,
    refresher: { async refresh() { throw new Error('should not refresh'); } },
  });

  const recovery = await store.healthMetrics.getMetricResult({
    userId: 'u1',
    civilDate: '2026-08-23',
    metricName: 'recovery',
  });
  assert.ok(recovery);
  assert.equal(recovery.quality, 'provisional');
  assert.equal((await store.connections.findByUserId('u1'))?.lastSuccessfulSyncAt, undefined);
});

test('an incremental snapshot merge recomputes only dates changed in its 48-hour window', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  const now = new Date('2026-08-24T12:00:00.000Z');
  await store.connections.insert(liveConnection('u1', 'c1'));
  const dates = priorDates('2026-08-25', 35);
  const previous: UserHealthRecords = {
    ...emptyUserHealthRecords(),
    dailyHrv: dates.map((date, index) => ({
      userId: 'u1',
      source: 'google_health' as const,
      sourceRecordId: `hrv-${date}`,
      date,
      valueMs: 40 + (index % 4),
    })),
    dailyRhr: dates.map((date, index) => ({
      userId: 'u1',
      source: 'google_health' as const,
      sourceRecordId: `rhr-${date}`,
      date,
      valueBpm: 50 + (index % 4),
    })),
  };
  for (const dataType of [
    'sleep',
    'daily-heart-rate-variability',
    'daily-resting-heart-rate',
  ] as const) {
    await store.healthMetrics.updateCursor({
      connectionId: 'c1',
      dataType,
      successfulWatermark: new Date(now.getTime() - 60 * 60 * 1_000),
      lastErrorCode: undefined,
      retryCount: 0,
      nextAttemptAt: now,
    });
  }
  for (const dataType of [
    'heart-rate',
    'activity-level',
    'daily-heart-rate-zones',
    'time-in-heart-rate-zone',
    'exercise',
  ] as const) {
    await store.healthMetrics.updateCursor({
      connectionId: 'c1',
      dataType,
      successfulWatermark: now,
      lastErrorCode: undefined,
      retryCount: 0,
      nextAttemptAt: new Date(now.getTime() + 60 * 60 * 1_000),
    });
  }
  let persisted: UserHealthRecords | undefined;

  await syncUserConnection({
    config: oauthConfig(),
    store,
    userId: 'u1',
    now,
    api: createFakeApi({}),
    persistSnapshot: async (_userId, records) => {
      persisted = records;
    },
    loadSnapshot: async () => ({ records: previous, syncedAt: new Date(now.getTime() - 60 * 60 * 1_000) }),
    loadRecords: async () => persisted ?? previous,
    refresher: { async refresh() { throw new Error('should not refresh'); } },
  });

  assert.equal((await store.healthMetrics.readCursor({ connectionId: 'c1', dataType: 'sleep' }))?.lastErrorCode, undefined);
  assert.ok(persisted);
  assert.equal(persisted.dailyHrv.length, 35);
  assert.ok(await store.healthMetrics.getMetricResult({
    userId: 'u1',
    civilDate: '2026-08-24',
    metricName: 'recovery',
  }));
  assert.equal(
    await store.healthMetrics.getMetricResult({
      userId: 'u1',
      civilDate: '2026-07-21',
      metricName: 'recovery',
    }),
    undefined,
  );
});
