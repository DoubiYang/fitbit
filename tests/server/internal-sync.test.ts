import assert from 'node:assert/strict';
import test from 'node:test';

import { handleInternalSync } from '../../src/server/health/internal-sync';
import type { ConnectionRow } from '../../src/server/auth/types';
import { loadConfig } from '../../src/server/config/env';
import { createMemoryStore } from '../../src/server/db/memory-store';

const validKey = Buffer.alloc(32, 9).toString('base64');

function oauthEnv(overrides: NodeJS.Dict<string> = {}) {
  return {
    DATABASE_URL: 'postgresql://rhythm:x@db:5432/rhythm',
    GOOGLE_HEALTH_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_HEALTH_CLIENT_SECRET: 'client-secret',
    TOKEN_ENCRYPTION_KEY: validKey,
    APP_ORIGIN: 'http://localhost:3000',
    ...overrides,
  };
}

function dueConnection(id: string, userId: string, now: Date): ConnectionRow {
  return {
    id,
    userId,
    healthUserId: `health-${userId}`,
    legacyUserId: undefined,
    tokenEnvelopeCiphertext: Buffer.from('ciphertext'),
    tokenEnvelopeIv: Buffer.from('iv'),
    tokenEnvelopeAuthTag: Buffer.from('tag'),
    encryptionKeyVersion: 1,
    accessTokenExpiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
    refreshTokenExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
    grantedScopes: [],
    status: 'active',
    lastErrorCode: undefined,
    connectedAt: now,
    updatedAt: now,
    lastSuccessfulSyncAt: undefined,
    nextSyncAt: now,
    syncRetryCount: 0,
    syncLeaseUntil: undefined,
    syncLeaseToken: undefined,
    lastSyncAttemptAt: undefined,
  };
}

test('internal sync is disabled when oauth has no SYNC_SECRET', async () => {
  const config = loadConfig(oauthEnv());
  assert.equal(config.kind, 'oauth');
  const response = await handleInternalSync(
    new Request('http://localhost:3000/rhythm/api/internal/sync', {
      method: 'POST',
      headers: { Authorization: 'Bearer unused' },
    }),
    { config, store: createMemoryStore() },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'scheduler_disabled' });
});

test('internal sync still requires the bearer secret when it is configured', async () => {
  const config = loadConfig(oauthEnv({ SYNC_SECRET: 'test-sync-secret' }));
  assert.equal(config.kind, 'oauth');
  const unauthorized = await handleInternalSync(
    new Request('http://localhost:3000/rhythm/api/internal/sync', { method: 'POST' }),
    { config, store: createMemoryStore() },
  );
  assert.equal(unauthorized.status, 401);
});

test('internal sync claims one due connection per worker request', async () => {
  const config = loadConfig(oauthEnv({ SYNC_SECRET: 'test-sync-secret' }));
  assert.equal(config.kind, 'oauth');
  const store = createMemoryStore();
  const now = new Date();
  await store.users.insert('user-a');
  await store.users.insert('user-b');
  await store.connections.insert(dueConnection('connection-a', 'user-a', now));
  await store.connections.insert(dueConnection('connection-b', 'user-b', now));

  const claimDueSyncs = store.connections.claimDueSyncs.bind(store.connections);
  let claimCalls = 0;
  const claimedUserIds: string[] = [];
  store.connections.claimDueSyncs = async (input) => {
    claimCalls += 1;
    const claimed = await claimDueSyncs(input);
    claimedUserIds.push(...claimed.map((row) => row.userId));
    // Avoid invoking the real provider; the assertion concerns claiming work.
    return claimed.map((row) => ({ ...row, syncLeaseUntil: undefined, syncLeaseToken: undefined }));
  };

  const request = () =>
    new Request('http://localhost:3000/rhythm/api/internal/sync', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-sync-secret' },
    });

  const first = await handleInternalSync(request(), { config, store });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { claimed: 0, succeeded: 0, failed: 1 });
  assert.equal(claimCalls, 1);
  assert.deepEqual(claimedUserIds, ['user-a']);

  const nextWorkerTick = await handleInternalSync(request(), { config, store });
  assert.equal(nextWorkerTick.status, 200);
  assert.deepEqual(await nextWorkerTick.json(), { claimed: 0, succeeded: 0, failed: 1 });
  assert.equal(claimCalls, 2);
  assert.deepEqual(claimedUserIds, ['user-a', 'user-b']);
});
