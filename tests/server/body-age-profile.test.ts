import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';

import { sha256Buffer } from '../../src/server/auth/oauth-url';
import type { HttpDeps } from '../../src/server/auth/http';
import type { SessionRow } from '../../src/server/auth/types';
import { loadConfig, type OAuthConfig } from '../../src/server/config/env';
import { createMemoryStore } from '../../src/server/db/memory-store';
import { emptyUserHealthRecords } from '../../src/server/health/provider';
import { handleGetBodyAgeProfile, handlePutBodyAgeProfile } from '../../src/server/settings/body-age-profile';

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
  if (loaded.kind !== 'oauth') throw new Error('expected oauth config');
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

function deps(store: ReturnType<typeof createMemoryStore>): HttpDeps {
  return {
    config: oauthConfig(),
    store,
    now: () => NOW,
    snapshotForUser: async () => ({ records: emptyUserHealthRecords(), syncedAt: NOW }),
  };
}

function getRequest(token?: string): Request {
  return new Request('http://localhost:3000/rhythm/api/settings/body-age-profile', {
    headers: token ? { Cookie: `rhythm_session=${token}` } : undefined,
  });
}

function putRequest(body: unknown, token?: string, origin = 'http://localhost:3000'): Request {
  return new Request('http://localhost:3000/rhythm/api/settings/body-age-profile', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}),
      ...(token ? { Cookie: `rhythm_session=${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

test('body-age profile GET and PUT require an authenticated OAuth user', async () => {
  const { store } = await seedUsers();
  const get = await handleGetBodyAgeProfile(getRequest(), deps(store));
  const put = await handlePutBodyAgeProfile(putRequest({ birthDate: '1990-02-03', referenceSex: 'female' }), deps(store));

  assert.equal(get.status, 401);
  assert.equal(put.status, 401);
  assert.equal((await get.json() as { error: string }).error, 'unauthenticated');
  assert.equal((await put.json() as { error: string }).error, 'unauthenticated');
});

test('body-age profile GET is owner-scoped and returns only settings fields', async () => {
  const { store, tokenA } = await seedUsers();
  await store.healthMetrics.updateBodyAgeProfile({ userId: userA, birthDate: '1992-02-29', referenceSex: 'female' });
  await store.healthMetrics.recordObservedHrPeak({ userId: userA, observedHrPeakBpm: 188, observedAt: NOW.toISOString() });
  await store.healthMetrics.updateBodyAgeProfile({ userId: userB, birthDate: '1980-01-01', referenceSex: 'male' });

  const response = await handleGetBodyAgeProfile(getRequest(tokenA), deps(store));
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(body, { birthDate: '1992-02-29', referenceSex: 'female', profileRevision: 1 });
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('188'), false);
  assert.equal(serialized.includes('1980-01-01'), false);
  assert.equal(serialized.includes(userB), false);
});

test('body-age profile PUT validates explicit real, non-future dates and sex values', async () => {
  const { store, tokenA } = await seedUsers();
  const invalid = [
    {},
    { birthDate: '2001-02-29', referenceSex: 'female' },
    { birthDate: '1990-2-03', referenceSex: 'female' },
    { birthDate: '2026-08-25', referenceSex: 'female' },
    { birthDate: '1990-02-03', referenceSex: 'other' },
    { birthDate: '1990-02-03' },
    { referenceSex: 'female' },
    [],
  ];
  for (const body of invalid) {
    const response = await handlePutBodyAgeProfile(putRequest(body, tokenA), deps(store));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json() as { error: string }).error, 'invalid_body_age_profile');
  }

  const leapDay = await handlePutBodyAgeProfile(
    putRequest({ birthDate: '2000-02-29', referenceSex: 'female' }, tokenA),
    deps(store),
  );
  assert.equal(leapDay.status, 200);
  assert.deepEqual(await leapDay.json(), {
    birthDate: '2000-02-29', referenceSex: 'female', profileRevision: 1, recomputePending: true,
  });
});

test('body-age profile PUT enforces origin protection and can save without a time zone', async () => {
  const { store, tokenA } = await seedUsers();
  const rejected = await handlePutBodyAgeProfile(
    putRequest({ birthDate: '1990-02-03', referenceSex: 'male' }, tokenA, 'https://attacker.example'),
    deps(store),
  );
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json() as { error: string }).error, 'origin_rejected');
  assert.equal(await store.healthMetrics.getBodyAgeProfile({ userId: userA }), undefined);

  const saved = await handlePutBodyAgeProfile(
    putRequest({ birthDate: '1990-02-03', referenceSex: 'male' }, tokenA),
    deps(store),
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), {
    birthDate: '1990-02-03', referenceSex: 'male', profileRevision: 1, recomputePending: true,
  });
});

test('body-age profile reports unconfigured deployment without writing', async () => {
  const { store, tokenA } = await seedUsers();
  const unconfigured: HttpDeps = {
    config: loadConfig({ DATABASE_URL: 'postgresql://rhythm:x@db:5432/rhythm' }),
    store,
    now: () => NOW,
  };
  const response = await handlePutBodyAgeProfile(
    putRequest({ birthDate: '1990-02-03', referenceSex: 'male' }, tokenA),
    unconfigured,
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json() as { error: string }).error, 'unconfigured');
  assert.equal(await store.healthMetrics.getBodyAgeProfile({ userId: userA }), undefined);
});
