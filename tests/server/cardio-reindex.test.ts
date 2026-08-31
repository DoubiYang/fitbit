import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';

import { parseDailyHeartRateZones, parseHeartRateMinuteAggregate } from '../../src/domain/cardio-records';
import { sha256Buffer } from '../../src/server/auth/oauth-url';
import type { HttpDeps } from '../../src/server/auth/http';
import type { SessionRow } from '../../src/server/auth/types';
import { loadConfig, type OAuthConfig } from '../../src/server/config/env';
import { createMemoryStore } from '../../src/server/db/memory-store';
import { emptyUserHealthRecords } from '../../src/server/health/provider';
import { handlePutTimeZone } from '../../src/server/settings/time-zone';

const userId = 'user-a';
const NOW = new Date('2026-08-24T12:00:00.000Z');
const COMPLETE_DATE = '2026-08-22';
const MISMATCH_DATE = '2026-08-21';
const RANGE_START = '2026-07-21';
const ZONES = {
  LIGHT: { minBeatsPerMinute: 97, maxBeatsPerMinute: 116 },
  MODERATE: { minBeatsPerMinute: 117, maxBeatsPerMinute: 136 },
  VIGOROUS: { minBeatsPerMinute: 137, maxBeatsPerMinute: 155 },
  PEAK: { minBeatsPerMinute: 156, maxBeatsPerMinute: 200 },
};

function addCivilDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function oauthConfig(): OAuthConfig {
  const loaded = loadConfig({
    DATABASE_URL: 'postgresql://rhythm:x@db:5432/rhythm',
    GOOGLE_HEALTH_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_HEALTH_CLIENT_SECRET: 'client-secret',
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    SYNC_SECRET: 'test-sync-secret',
    APP_ORIGIN: 'http://localhost:3000',
  });
  assert.equal(loaded.kind, 'oauth');
  if (loaded.kind !== 'oauth') {
    throw new Error('expected oauth config');
  }
  return loaded;
}

async function signedInStore() {
  const store = createMemoryStore();
  await store.users.insert(userId);
  const token = randomBytes(32).toString('base64url');
  const session: SessionRow = {
    id: randomUUID(),
    userId,
    tokenHash: sha256Buffer(token),
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    createdAt: NOW,
    lastSeenAt: NOW,
  };
  await store.sessions.insert(session);
  return { store, token };
}

function deps(store: ReturnType<typeof createMemoryStore>, googleCalls: { count: number }): HttpDeps {
  return {
    config: oauthConfig(),
    store,
    now: () => NOW,
    google: {
      async exchangeCode() {
        googleCalls.count += 1;
        throw new Error('must not call Google');
      },
      async getIdentity() {
        googleCalls.count += 1;
        throw new Error('must not call Google');
      },
      async revoke() {
        googleCalls.count += 1;
        throw new Error('must not call Google');
      },
    },
    snapshotForUser: async () => ({ records: emptyUserHealthRecords(), syncedAt: NOW }),
  };
}

function utcMinute(civilDate: string, localMinuteOfDay: number, overrides: { utcOffsetMinutes?: number; avgBpm?: number } = {}) {
  const utcOffsetMinutes = overrides.utcOffsetMinutes ?? 0;
  const minuteStartUtc = new Date(Date.parse(`${civilDate}T00:00:00.000Z`) - utcOffsetMinutes * 60_000 + localMinuteOfDay * 60_000).toISOString();
  return parseHeartRateMinuteAggregate({
    userId,
    sourceFamily: 'google-wearables',
    minuteStartUtc,
    civilDate,
    utcOffsetMinutes,
    ianaTimeZone: null,
    localMinuteOfDay,
    avgBpm: overrides.avgBpm ?? 70,
    minBpm: overrides.avgBpm ?? 70,
    maxBpm: overrides.avgBpm ?? 70,
    sampleCount: 4,
    coverageSeconds: 60,
    activityLevel: 'unknown',
  });
}

async function seedThirtyFiveDayMinutes(store: ReturnType<typeof createMemoryStore>): Promise<void> {
  const minutes = [];
  for (let offset = 0; offset < 35; offset += 1) {
    const date = addCivilDays(RANGE_START, offset);
    if (date === COMPLETE_DATE) {
      for (let localMinuteOfDay = 0; localMinuteOfDay < 1440; localMinuteOfDay += 1) {
        minutes.push(utcMinute(date, localMinuteOfDay, { avgBpm: 110 }));
      }
      continue;
    }
    if (date === MISMATCH_DATE) {
      minutes.push(utcMinute(date, 480, { utcOffsetMinutes: 480, avgBpm: 80 }));
      continue;
    }
    minutes.push(utcMinute(date, 0));
  }
  await store.healthMetrics.upsertMinutes(minutes);
  await store.healthMetrics.upsertActivityLevelIntervals([
    {
      userId,
      sourceFamily: 'google-wearables',
      startTime: `${COMPLETE_DATE}T00:00:00.000Z`,
      endTime: `${addCivilDays(COMPLETE_DATE, 1)}T00:00:00.000Z`,
      activityLevelType: 'LIGHTLY_ACTIVE',
    },
  ]);
  await store.healthMetrics.replaceHeartRateZones(parseDailyHeartRateZones({
    userId,
    sourceFamily: 'google-wearables',
    date: COMPLETE_DATE,
    zones: ZONES,
  }));
  await store.healthMetrics.replaceHeartRateZones(parseDailyHeartRateZones({
    userId,
    sourceFamily: 'google-wearables',
    date: MISMATCH_DATE,
    zones: ZONES,
  }));
}

test('first matching IANA write completes eligible historical days without Google API', async () => {
  const { store, token } = await signedInStore();
  await seedThirtyFiveDayMinutes(store);
  const googleCalls = { count: 0 };

  const response = await handlePutTimeZone(
    new Request('http://localhost:3000/rhythm/api/settings/time-zone', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
        Cookie: `rhythm_session=${token}`,
      },
      body: JSON.stringify({ ianaTimeZone: 'UTC' }),
    }),
    deps(store, googleCalls),
  );
  assert.equal(response.status, 200);
  assert.equal(googleCalls.count, 0);
  assert.equal((await response.json() as { isBackfillAnchor: boolean }).isBackfillAnchor, true);

  const history = await store.healthMetrics.listTimeZoneHistory(userId);
  assert.equal(history[0]?.effectiveAt, '2026-07-21T00:00:00.000Z');
  assert.equal(history[0]?.isBackfillAnchor, true);

  const completeMinutes = await store.healthMetrics.listMinutesByCivilDate({ userId, civilDate: COMPLETE_DATE });
  assert.equal(completeMinutes.length, 1440);
  assert.ok(completeMinutes.every((minute) => minute.ianaTimeZone === 'UTC'));
  assert.ok(completeMinutes.every((minute) => minute.utcOffsetMinutes === 0));

  const mismatchMinutes = await store.healthMetrics.listMinutesByCivilDate({ userId, civilDate: MISMATCH_DATE });
  assert.equal(mismatchMinutes.length, 1);
  assert.equal(mismatchMinutes[0]?.ianaTimeZone, null);
  assert.equal(mismatchMinutes[0]?.utcOffsetMinutes, 480);

  const complete = await store.healthMetrics.getDailyCardio({ userId, civilDate: COMPLETE_DATE });
  const mismatch = await store.healthMetrics.getDailyCardio({ userId, civilDate: MISMATCH_DATE });
  assert.equal(complete?.status, 'complete');
  assert.equal(mismatch?.status, 'timezone_ambiguous');
});

test('later time-zone writes only reindex their own effective range', async () => {
  const { store, token } = await signedInStore();
  await store.healthMetrics.upsertMinutes([
    utcMinute('2026-08-20', 60),
    utcMinute('2026-08-25', 60, { utcOffsetMinutes: 480 }),
  ]);

  const first = await handlePutTimeZone(
    new Request('http://localhost:3000/rhythm/api/settings/time-zone', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
        Cookie: `rhythm_session=${token}`,
      },
      body: JSON.stringify({ ianaTimeZone: 'UTC' }),
    }),
    deps(store, { count: 0 }),
  );
  assert.equal(first.status, 200);

  const laterNow = new Date('2026-08-24T12:00:00.000Z');
  const later = await handlePutTimeZone(
    new Request('http://localhost:3000/rhythm/api/settings/time-zone', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
        Cookie: `rhythm_session=${token}`,
      },
      body: JSON.stringify({ ianaTimeZone: 'Asia/Shanghai' }),
    }),
    { ...deps(store, { count: 0 }), now: () => laterNow },
  );
  assert.equal(later.status, 200);

  const early = await store.healthMetrics.listMinutesByCivilDate({ userId, civilDate: '2026-08-20' });
  const late = await store.healthMetrics.listMinutesInRange({
    userId,
    fromUtc: laterNow.toISOString(),
  });
  assert.equal(early[0]?.ianaTimeZone, 'UTC');
  assert.equal(late.length, 1);
  assert.equal(late[0]?.ianaTimeZone, 'Asia/Shanghai');
  assert.equal(late[0]?.utcOffsetMinutes, 480);
});
