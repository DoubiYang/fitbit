import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';

import { sha256Buffer } from '../../src/server/auth/oauth-url';
import type { HttpDeps } from '../../src/server/auth/http';
import type { SessionRow } from '../../src/server/auth/types';
import { loadConfig, type OAuthConfig } from '../../src/server/config/env';
import { createMemoryStore } from '../../src/server/db/memory-store';
import { emptyUserHealthRecords } from '../../src/server/health/provider';
import { handleGetTimeZone, handlePutTimeZone, TIME_ZONE_BACKFILL_EPOCH } from '../../src/server/settings/time-zone';

const NOW = new Date('2026-08-24T12:00:00.000Z');
const userA = 'user-a';
const userB = 'user-b';

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

async function insertSession(store: ReturnType<typeof createMemoryStore>, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const row: SessionRow = {
    id: randomUUID(),
    userId,
    tokenHash: sha256Buffer(token),
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    createdAt: NOW,
    lastSeenAt: NOW,
  };
  await store.sessions.insert(row);
  return token;
}

async function seedUsers() {
  const store = createMemoryStore();
  await store.users.insert(userA);
  await store.users.insert(userB);
  return { store, tokenA: await insertSession(store, userA), tokenB: await insertSession(store, userB) };
}

function deps(store: ReturnType<typeof createMemoryStore>, now = NOW): HttpDeps {
  return {
    config: oauthConfig(),
    store,
    now: () => now,
    snapshotForUser: async () => ({ records: emptyUserHealthRecords(), syncedAt: now }),
  };
}

function getRequest(token?: string): Request {
  return new Request('http://localhost:3000/rhythm/api/settings/time-zone', {
    headers: token ? { Cookie: `rhythm_session=${token}` } : undefined,
  });
}

function putRequest(body: unknown, token?: string): Request {
  return new Request('http://localhost:3000/rhythm/api/settings/time-zone', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://localhost:3000',
      ...(token ? { Cookie: `rhythm_session=${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

test('unauthenticated time-zone GET and PUT are 401', async () => {
  const { store } = await seedUsers();
  const get = await handleGetTimeZone(getRequest(), deps(store));
  const put = await handlePutTimeZone(putRequest({ ianaTimeZone: 'UTC' }), deps(store));
  assert.equal(get.status, 401);
  assert.equal(put.status, 401);
  assert.equal((await get.json() as { error: string }).error, 'unauthenticated');
});

test('GET never returns another user time-zone history', async () => {
  const { store, tokenA } = await seedUsers();
  await store.healthMetrics.insertTimeZoneHistory({
    userId: userA,
    ianaTimeZone: 'Asia/Shanghai',
    effectiveAt: '2026-08-01T00:00:00.000Z',
    isBackfillAnchor: true,
  });
  await store.healthMetrics.insertTimeZoneHistory({
    userId: userB,
    ianaTimeZone: 'Pacific/Auckland',
    effectiveAt: '2026-08-01T00:00:00.000Z',
    isBackfillAnchor: true,
  });

  const response = await handleGetTimeZone(getRequest(tokenA), deps(store));
  const body = await response.json() as { ianaTimeZone: string; history: Array<{ ianaTimeZone: string }> };
  assert.equal(response.status, 200);
  assert.equal(body.ianaTimeZone, 'Asia/Shanghai');
  assert.equal(JSON.stringify(body).includes('Pacific/Auckland'), false);
  assert.equal(JSON.stringify(body).includes(userB), false);
  assert.ok(body.history.every((row) => row.ianaTimeZone === 'Asia/Shanghai'));
});

test('time-zone PUT rejects unknown IANA names', async () => {
  const { store, tokenA } = await seedUsers();
  const response = await handlePutTimeZone(putRequest({ ianaTimeZone: 'Not/AZone' }, tokenA), deps(store));
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { error: string }).error, 'invalid_time_zone');
  assert.equal((await store.healthMetrics.listTimeZoneHistory(userA)).length, 0);
});

test('first IANA write uses the earliest saved minute and is a backfill anchor', async () => {
  const { store, tokenA } = await seedUsers();
  await store.healthMetrics.upsertMinutes([
    {
      userId: userA,
      sourceFamily: 'google-wearables',
      minuteStartUtc: '2026-08-20T01:00:00.000Z',
      civilDate: '2026-08-20',
      utcOffsetMinutes: 0,
      ianaTimeZone: null,
      localMinuteOfDay: 60,
      avgBpm: 70,
      minBpm: 70,
      maxBpm: 70,
      sampleCount: 4,
      coverageSeconds: 60,
      activityLevel: 'SEDENTARY',
    },
    {
      userId: userA,
      sourceFamily: 'google-wearables',
      minuteStartUtc: '2026-08-22T01:00:00.000Z',
      civilDate: '2026-08-22',
      utcOffsetMinutes: 0,
      ianaTimeZone: null,
      localMinuteOfDay: 60,
      avgBpm: 72,
      minBpm: 72,
      maxBpm: 72,
      sampleCount: 4,
      coverageSeconds: 60,
      activityLevel: 'SEDENTARY',
    },
  ]);

  const response = await handlePutTimeZone(putRequest({ ianaTimeZone: 'UTC' }, tokenA), deps(store));
  const body = await response.json() as { ianaTimeZone: string; effectiveAt: string; isBackfillAnchor: boolean };
  assert.equal(response.status, 200);
  assert.equal(body.ianaTimeZone, 'UTC');
  assert.equal(body.effectiveAt, '2026-08-20T01:00:00.000Z');
  assert.equal(body.isBackfillAnchor, true);

  const history = await store.healthMetrics.listTimeZoneHistory(userA);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.effectiveAt, '2026-08-20T01:00:00.000Z');
  assert.equal(history[0]?.isBackfillAnchor, true);
  assert.equal(history[0]?.ianaTimeZone, 'UTC');

  const minutes = await store.healthMetrics.listMinutesInRange({
    userId: userA,
    fromUtc: '2026-08-20T00:00:00.000Z',
  });
  assert.ok(minutes.every((minute) => minute.ianaTimeZone === 'UTC'));
  assert.ok(minutes.every((minute) => minute.utcOffsetMinutes === 0));
});

test('first IANA write without minutes uses the epoch backfill anchor', async () => {
  const { store, tokenA } = await seedUsers();
  const response = await handlePutTimeZone(putRequest({ ianaTimeZone: 'Asia/Shanghai' }, tokenA), deps(store));
  const body = await response.json() as { effectiveAt: string; isBackfillAnchor: boolean; ianaTimeZone: string };
  assert.equal(response.status, 200);
  assert.equal(body.effectiveAt, TIME_ZONE_BACKFILL_EPOCH);
  assert.equal(body.isBackfillAnchor, true);
  assert.equal(body.ianaTimeZone, 'Asia/Shanghai');

  const historical = '2026-08-17T12:00:00.000Z';
  assert.ok(Date.parse(historical) < NOW.getTime());
  const zone = await store.healthMetrics.lookupTimeZoneHistory({ userId: userA, at: historical });
  assert.equal(zone?.ianaTimeZone, 'Asia/Shanghai');
  assert.equal(zone?.isBackfillAnchor, true);
  assert.equal(zone?.effectiveAt, TIME_ZONE_BACKFILL_EPOCH);
});

test('later PUT of the same IANA does not insert a second history row', async () => {
  const { store, tokenA } = await seedUsers();
  const first = await handlePutTimeZone(putRequest({ ianaTimeZone: 'UTC' }, tokenA), deps(store));
  const second = await handlePutTimeZone(putRequest({ ianaTimeZone: 'UTC' }, tokenA), deps(store, new Date('2026-08-24T13:00:00.000Z')));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  const body = await second.json() as { ianaTimeZone: string; effectiveAt: string; isBackfillAnchor: boolean };
  assert.equal(body.ianaTimeZone, 'UTC');
  assert.equal(body.effectiveAt, TIME_ZONE_BACKFILL_EPOCH);
  assert.equal(body.isBackfillAnchor, true);
  assert.equal((await store.healthMetrics.listTimeZoneHistory(userA)).length, 1);
});

test('later IANA writes use the received instant and are not a second backfill anchor', async () => {
  const { store, tokenA } = await seedUsers();
  const first = await handlePutTimeZone(putRequest({ ianaTimeZone: 'UTC' }, tokenA), deps(store, new Date('2026-08-20T00:00:00.000Z')));
  const laterNow = new Date('2026-08-24T12:00:00.000Z');
  const later = await handlePutTimeZone(putRequest({ ianaTimeZone: 'Asia/Shanghai' }, tokenA), deps(store, laterNow));
  assert.equal(first.status, 200);
  assert.equal(later.status, 200);

  const body = await later.json() as { effectiveAt: string; isBackfillAnchor: boolean; ianaTimeZone: string };
  assert.equal(body.effectiveAt, laterNow.toISOString());
  assert.equal(body.isBackfillAnchor, false);
  assert.equal(body.ianaTimeZone, 'Asia/Shanghai');

  const history = await store.healthMetrics.listTimeZoneHistory(userA);
  assert.equal(history.length, 2);
  assert.equal(history.filter((row) => row.isBackfillAnchor).length, 1);
  assert.equal(history[1]?.effectiveAt, laterNow.toISOString());
  assert.equal(history[1]?.isBackfillAnchor, false);
});
