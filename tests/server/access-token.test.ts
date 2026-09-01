import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../../src/server/config/env';
import { encryptTokenEnvelope } from '../../src/server/crypto/token-envelope';
import { createMemoryStore } from '../../src/server/db/memory-store';
import { createGoogleTokenRefresher, TokenRefreshError, resolveAccessToken } from '../../src/server/health/access-token';

test('does not restore credentials when the user disconnects while a token refresh is in flight', async () => {
  const key = Buffer.alloc(32, 9);
  const config = loadConfig({
    DATABASE_URL: 'postgresql://rhythm:x@db:5432/rhythm',
    GOOGLE_HEALTH_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_HEALTH_CLIENT_SECRET: 'secret',
    TOKEN_ENCRYPTION_KEY: key.toString('base64'),
    SYNC_SECRET: 'test-sync-secret',
    APP_ORIGIN: 'http://localhost:3000',
  });
  assert.equal(config.kind, 'oauth');
  if (config.kind !== 'oauth') {
    return;
  }

  const store = createMemoryStore();
  const encrypted = encryptTokenEnvelope({ accessToken: 'old-access', refreshToken: 'refresh' }, key, 'connection-1', 'user-1');
  const connection = {
    id: 'connection-1',
    userId: 'user-1',
    healthUserId: 'health-1',
    legacyUserId: undefined,
    tokenEnvelopeCiphertext: encrypted.ciphertext,
    tokenEnvelopeIv: encrypted.iv,
    tokenEnvelopeAuthTag: encrypted.authTag,
    encryptionKeyVersion: 1,
    accessTokenExpiresAt: new Date('2026-08-24T11:00:00.000Z'),
    refreshTokenExpiresAt: new Date('2026-08-31T12:00:00.000Z'),
    grantedScopes: [],
    status: 'active' as const,
    lastErrorCode: undefined,
    connectedAt: new Date('2026-08-24T00:00:00.000Z'),
    updatedAt: new Date('2026-08-24T00:00:00.000Z'),
    lastSuccessfulSyncAt: undefined,
  };
  await store.users.insert(connection.userId);
  await store.connections.insert(connection);

  await assert.rejects(
    () =>
      resolveAccessToken({
        config,
        store,
        connection,
        now: new Date('2026-08-24T12:00:00.000Z'),
        refresher: {
          async refresh() {
            const latest = await store.connections.findByUserId(connection.userId);
            assert.ok(latest);
            await store.connections.update({
              ...latest,
              status: 'disconnected',
              tokenEnvelopeCiphertext: undefined,
              tokenEnvelopeIv: undefined,
              tokenEnvelopeAuthTag: undefined,
              encryptionKeyVersion: undefined,
              accessTokenExpiresAt: undefined,
              refreshTokenExpiresAt: undefined,
            });
            return {
              accessToken: 'new-access',
              refreshToken: undefined,
              expiresAt: new Date('2026-08-24T13:00:00.000Z'),
              refreshExpiresAt: undefined,
            };
          },
        },
      }),
    /connection no longer syncable/,
  );

  const current = await store.connections.findByUserId(connection.userId);
  assert.equal(current?.status, 'disconnected');
  assert.equal(current?.tokenEnvelopeCiphertext, undefined);
  assert.equal(current?.accessTokenExpiresAt, undefined);
});

test('token refresh 401 is an auth failure, not a generic retry', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('invalid_grant', { status: 401 });
  try {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://rhythm:x@db:5432/rhythm',
      GOOGLE_HEALTH_CLIENT_ID: 'client.apps.googleusercontent.com',
      GOOGLE_HEALTH_CLIENT_SECRET: 'secret',
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
      SYNC_SECRET: 'test-sync-secret',
      APP_ORIGIN: 'http://localhost:3000',
    });
    assert.equal(config.kind, 'oauth');
    if (config.kind !== 'oauth') {
      return;
    }
    await assert.rejects(
      () => createGoogleTokenRefresher(config).refresh('refresh'),
      (error: unknown) => error instanceof TokenRefreshError && error.status === 401 && error.isAuthFailure,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('refresh request receives the scheduled run abort signal', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let signal: AbortSignal | undefined;
  globalThis.fetch = async (_url, init) => {
    signal = init?.signal ?? undefined;
    return Response.json({ access_token: 'refreshed-access', expires_in: 3600 });
  };
  try {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://rhythm:x@db:5432/rhythm',
      GOOGLE_HEALTH_CLIENT_ID: 'client.apps.googleusercontent.com',
      GOOGLE_HEALTH_CLIENT_SECRET: 'secret',
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
      SYNC_SECRET: 'test-sync-secret',
      APP_ORIGIN: 'http://localhost:3000',
    });
    assert.equal(config.kind, 'oauth');
    if (config.kind !== 'oauth') return;

    await createGoogleTokenRefresher(config).refresh('refresh', controller.signal);
    assert.equal(signal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an abort after refresh returns prevents the scheduled lease from writing a token envelope', async () => {
  const key = Buffer.alloc(32, 7);
  const config = loadConfig({
    DATABASE_URL: 'postgresql://rhythm:x@db:5432/rhythm',
    GOOGLE_HEALTH_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_HEALTH_CLIENT_SECRET: 'secret',
    TOKEN_ENCRYPTION_KEY: key.toString('base64'),
    SYNC_SECRET: 'test-sync-secret',
    APP_ORIGIN: 'http://localhost:3000',
  });
  assert.equal(config.kind, 'oauth');
  if (config.kind !== 'oauth') return;

  const store = createMemoryStore();
  const now = new Date('2026-08-24T12:00:00.000Z');
  const encrypted = encryptTokenEnvelope({ accessToken: 'old-access', refreshToken: 'refresh' }, key, 'connection-abort', 'user-abort');
  await store.users.insert('user-abort');
  await store.connections.insert({
    id: 'connection-abort',
    userId: 'user-abort',
    healthUserId: 'health-abort',
    legacyUserId: undefined,
    tokenEnvelopeCiphertext: encrypted.ciphertext,
    tokenEnvelopeIv: encrypted.iv,
    tokenEnvelopeAuthTag: encrypted.authTag,
    encryptionKeyVersion: 1,
    accessTokenExpiresAt: new Date('2026-08-24T11:00:00.000Z'),
    refreshTokenExpiresAt: new Date('2026-08-31T12:00:00.000Z'),
    grantedScopes: [],
    status: 'active',
    lastErrorCode: undefined,
    connectedAt: now,
    updatedAt: now,
    lastSuccessfulSyncAt: undefined,
    nextSyncAt: now,
    syncRetryCount: 0,
  });
  const [claimed] = await store.connections.claimDueSyncs({
    now,
    leaseUntil: new Date('2026-08-24T12:15:00.000Z'),
    limit: 1,
  });
  assert.ok(claimed?.syncLeaseToken);
  const controller = new AbortController();

  await assert.rejects(
    () => resolveAccessToken({
      config,
      store,
      connection: claimed!,
      now,
      lease: {
        connectionId: claimed!.id,
        userId: claimed!.userId,
        leaseToken: claimed!.syncLeaseToken!,
        leaseUntil: claimed!.syncLeaseUntil!,
        now,
        signal: controller.signal,
      } as never,
      refresher: {
        async refresh(_refreshToken, signal) {
          assert.equal(signal, controller.signal);
          controller.abort(new Error('test deadline'));
          return {
            accessToken: 'new-access',
            refreshToken: undefined,
            expiresAt: new Date('2026-08-24T13:00:00.000Z'),
            refreshExpiresAt: undefined,
          };
        },
      },
    }),
    /scheduled sync deadline exceeded/u,
  );
  const current = await store.connections.findByUserId('user-abort');
  assert.deepEqual(current?.tokenEnvelopeCiphertext, encrypted.ciphertext);
  assert.equal(current?.accessTokenExpiresAt?.toISOString(), '2026-08-24T11:00:00.000Z');
});
