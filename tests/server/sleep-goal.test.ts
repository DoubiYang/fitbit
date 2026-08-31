import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';

import { parseSleepGoal } from '../../src/domain/cardio-records';
import { sha256Buffer } from '../../src/server/auth/oauth-url';
import type { HttpDeps } from '../../src/server/auth/http';
import type { SessionRow } from '../../src/server/auth/types';
import { loadConfig, type OAuthConfig } from '../../src/server/config/env';
import { createMemoryStore } from '../../src/server/db/memory-store';
import { emptyUserHealthRecords } from '../../src/server/health/provider';
import { handleGetSleepGoal, handlePutSleepGoal } from '../../src/server/settings/sleep-goal';

const NOW = new Date('2026-08-23T16:00:00.000Z');
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
  const tokenA = await insertSession(store, userA);
  const tokenB = await insertSession(store, userB);
  return { store, tokenA, tokenB };
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
  return new Request('http://localhost:3000/rhythm/api/settings/sleep-goal', {
    headers: token ? { Cookie: `rhythm_session=${token}` } : undefined,
  });
}

function putRequest(body: unknown, token?: string, origin = 'http://localhost:3000'): Request {
  return new Request('http://localhost:3000/rhythm/api/settings/sleep-goal', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}),
      ...(token ? { Cookie: `rhythm_session=${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

test('unauthenticated sleep-goal GET and PUT are 401', async () => {
  const { store } = await seedUsers();
  const get = await handleGetSleepGoal(getRequest(), deps(store));
  const put = await handlePutSleepGoal(putRequest({ goalMinutes: 480 }), deps(store));
  assert.equal(get.status, 401);
  assert.equal(put.status, 401);
  assert.equal((await get.json() as { error: string }).error, 'unauthenticated');
  assert.equal((await put.json() as { error: string }).error, 'unauthenticated');
});

test('GET never returns another user sleep goal', async () => {
  const { store, tokenA } = await seedUsers();
  await store.healthMetrics.insertTimeZoneHistory({
    userId: userA,
    ianaTimeZone: 'Asia/Shanghai',
    effectiveAt: '2026-08-01T00:00:00.000Z',
    isBackfillAnchor: true,
  });
  await store.healthMetrics.insertSleepGoal(parseSleepGoal({
    userId: userA,
    goalMinutes: 480,
    effectiveCivilDate: '2026-08-02',
  }));
  await store.healthMetrics.insertSleepGoal(parseSleepGoal({
    userId: userB,
    goalMinutes: 720,
    effectiveCivilDate: '2026-08-02',
  }));

  const response = await handleGetSleepGoal(getRequest(tokenA), deps(store));
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(body.goalMinutes, 480);
  assert.equal(body.effectiveCivilDate, '2026-08-02');
  assert.equal(JSON.stringify(body).includes('720'), false);
  assert.equal(JSON.stringify(body).includes(userB), false);
});

test('sleep-goal PUT rejects non-integers and values outside 300-900', async () => {
  const { store, tokenA } = await seedUsers();
  await store.healthMetrics.insertTimeZoneHistory({
    userId: userA,
    ianaTimeZone: 'Asia/Shanghai',
    effectiveAt: '2026-08-01T00:00:00.000Z',
    isBackfillAnchor: true,
  });

  const rejected = [480.5, '480', 299, 901, null, true, { minutes: 480 }];
  for (const goalMinutes of rejected) {
    const response = await handlePutSleepGoal(putRequest({ goalMinutes }, tokenA), deps(store));
    assert.equal(response.status, 400, String(goalMinutes));
    assert.equal((await response.json() as { error: string }).error, 'invalid_sleep_goal');
  }
});

test('sleep-goal PUT rejects until a time zone has been written', async () => {
  const { store, tokenA } = await seedUsers();
  const response = await handlePutSleepGoal(putRequest({ goalMinutes: 480 }, tokenA), deps(store));
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { error: string }).error, 'time_zone_required');
  assert.equal(await store.healthMetrics.lookupSleepGoal({ userId: userA, civilDate: '9999-12-31' }), undefined);
});

test('successful sleep-goal PUT dated local day T writes only T+1', async () => {
  const { store, tokenA } = await seedUsers();
  await store.healthMetrics.insertTimeZoneHistory({
    userId: userA,
    ianaTimeZone: 'Asia/Shanghai',
    effectiveAt: '2026-08-01T00:00:00.000Z',
    isBackfillAnchor: true,
  });

  const response = await handlePutSleepGoal(putRequest({ goalMinutes: 480 }, tokenA), deps(store));
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 200);
  assert.equal(body.goalMinutes, 480);
  assert.equal(body.effectiveCivilDate, '2026-08-25');
  assert.equal(JSON.stringify(body).includes('可按原计划'), false);
  assert.equal(JSON.stringify(body).includes('训练'), false);

  assert.equal(await store.healthMetrics.lookupSleepGoal({ userId: userA, civilDate: '2026-08-24' }), undefined);
  assert.equal((await store.healthMetrics.lookupSleepGoal({ userId: userA, civilDate: '2026-08-25' }))?.goalMinutes, 480);
  assert.equal((await store.healthMetrics.lookupSleepGoal({ userId: userB, civilDate: '2026-08-25' })), undefined);
});

test('repeated sleep-goal PUT for the same effective date returns 409 SleepGoalConflictError', async () => {
  const { store, tokenA } = await seedUsers();
  await store.healthMetrics.insertTimeZoneHistory({
    userId: userA,
    ianaTimeZone: 'Asia/Shanghai',
    effectiveAt: '2026-08-01T00:00:00.000Z',
    isBackfillAnchor: true,
  });

  const first = await handlePutSleepGoal(putRequest({ goalMinutes: 480 }, tokenA), deps(store));
  const conflict = await handlePutSleepGoal(putRequest({ goalMinutes: 420 }, tokenA), deps(store));
  assert.equal(first.status, 200);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as { error: string }).error, 'SleepGoalConflictError');
  assert.equal((await store.healthMetrics.lookupSleepGoal({ userId: userA, civilDate: '2026-08-25' }))?.goalMinutes, 480);
});

test('sleep-goal PUT accepts 300 and 900 minute boundaries', async () => {
  const { store, tokenA, tokenB } = await seedUsers();
  await store.healthMetrics.insertTimeZoneHistory({
    userId: userA,
    ianaTimeZone: 'UTC',
    effectiveAt: '2026-08-01T00:00:00.000Z',
    isBackfillAnchor: true,
  });
  await store.healthMetrics.insertTimeZoneHistory({
    userId: userB,
    ianaTimeZone: 'UTC',
    effectiveAt: '2026-08-01T00:00:00.000Z',
    isBackfillAnchor: true,
  });

  const min = await handlePutSleepGoal(putRequest({ goalMinutes: 300 }, tokenA), deps(store));
  const max = await handlePutSleepGoal(putRequest({ goalMinutes: 900 }, tokenB), deps(store));
  assert.equal(min.status, 200);
  assert.equal(max.status, 200);
  assert.equal((await min.json() as { goalMinutes: number }).goalMinutes, 300);
  assert.equal((await max.json() as { goalMinutes: number }).goalMinutes, 900);
});
