import assert from 'node:assert/strict';
import test from 'node:test';

import { completeGoogleOAuth, disconnectUser, readSessionUserId, startGoogleOAuth } from '../../src/server/auth/oauth-service';
import { REQUESTED_SCOPES } from '../../src/server/auth/scopes';
import type { GoogleOAuthClient, GoogleTokenResponse } from '../../src/server/auth/types';
import { loadConfig, redirectUri } from '../../src/server/config/env';
import { createMemoryStore } from '../../src/server/db/memory-store';

const validKey = Buffer.alloc(32, 9).toString('base64');
const now = new Date('2026-08-24T12:00:00.000Z');

function oauthConfig() {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://rhythm:x@db:5432/rhythm',
    GOOGLE_HEALTH_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_HEALTH_CLIENT_SECRET: 'client-secret',
    TOKEN_ENCRYPTION_KEY: validKey,
    APP_ORIGIN: 'http://localhost:3000',
  });
  if (config.kind !== 'oauth') {
    throw new Error('expected oauth config');
  }
  return config;
}

function tokens(overrides: Partial<GoogleTokenResponse> = {}): GoogleTokenResponse {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: new Date('2026-08-24T13:00:00.000Z'),
    refreshExpiresAt: new Date('2026-08-31T12:00:00.000Z'),
    grantedScopes: [...REQUESTED_SCOPES],
    ...overrides,
  };
}

function googleClient(overrides: Partial<GoogleOAuthClient> = {}): GoogleOAuthClient & { revoked: string[] } {
  const revoked: string[] = [];
  return {
    revoked,
    async exchangeCode() {
      return tokens();
    },
    async getIdentity() {
      return { healthUserId: 'health-1', legacyUserId: 'legacy-1' };
    },
    async revoke(token: string) {
      revoked.push(token);
    },
    ...overrides,
  };
}

async function startAndCallback(input: {
  store: ReturnType<typeof createMemoryStore>;
  google: GoogleOAuthClient;
  sessionUserId?: string;
  query?: { code?: string; state?: string; error?: string };
}) {
  const started = await startGoogleOAuth({ config: oauthConfig(), store: input.store, sessionUserId: input.sessionUserId, now });
  if (started.kind !== 'redirect') {
    throw new Error('expected redirect');
  }
  const state = new URL(started.url).searchParams.get('state') ?? undefined;
  return completeGoogleOAuth({
    config: oauthConfig(),
    store: input.store,
    google: input.google,
    query: input.query ?? { code: 'code-1', state },
    transactionId: started.transactionId,
    now,
  });
}

test('start fails closed without oauth config', async () => {
  const result = await startGoogleOAuth({ config: { kind: 'demo' }, store: createMemoryStore(), now });
  assert.equal(result.kind, 'not_configured');
});

test('start URL uses the registered local redirect and omits include_granted_scopes', async () => {
  const started = await startGoogleOAuth({ config: oauthConfig(), store: createMemoryStore(), now });
  assert.equal(started.kind, 'redirect');
  if (started.kind !== 'redirect') {
    return;
  }
  const url = new URL(started.url);
  assert.equal(url.searchParams.get('redirect_uri'), redirectUri(oauthConfig()));
  assert.equal(url.searchParams.has('include_granted_scopes'), false);
  assert.equal(url.searchParams.get('prompt'), 'consent');
});

test('wrong or expired state fails before token exchange', async () => {
  const store = createMemoryStore();
  const google = googleClient({
    async exchangeCode() {
      throw new Error('should not exchange');
    },
  });
  const started = await startGoogleOAuth({ config: oauthConfig(), store, now });
  assert.equal(started.kind, 'redirect');
  if (started.kind !== 'redirect') {
    return;
  }

  const wrongState = await completeGoogleOAuth({
    config: oauthConfig(),
    store,
    google,
    query: { code: 'code-1', state: 'nope' },
    transactionId: started.transactionId,
    now,
  });
  assert.equal(wrongState.authError, 'invalid_state');

  const expiredStore = createMemoryStore();
  const expiredStart = await startGoogleOAuth({ config: oauthConfig(), store: expiredStore, now });
  assert.equal(expiredStart.kind, 'redirect');
  if (expiredStart.kind !== 'redirect') {
    return;
  }
  const expired = await completeGoogleOAuth({
    config: oauthConfig(),
    store: expiredStore,
    google,
    query: { code: 'code-1', state: new URL(expiredStart.url).searchParams.get('state') ?? undefined },
    transactionId: expiredStart.transactionId,
    now: new Date(now.getTime() + 11 * 60 * 1000),
  });
  assert.equal(expired.authError, 'transaction_expired');
});

test('first connection without refresh token does not insert a user', async () => {
  const store = createMemoryStore();
  const google = googleClient({
    async exchangeCode() {
      return tokens({ refreshToken: undefined });
    },
  });
  const result = await startAndCallback({ store, google });
  assert.equal(result.authError, 'missing_refresh_token');
  assert.equal(await store.connections.findByHealthUserId('health-1'), undefined);
  assert.deepEqual((google as { revoked: string[] }).revoked, ['access-token']);
});

test('unknown identity creates an owner; reconnect after disconnect reuses the same ids', async () => {
  const store = createMemoryStore();
  const google = googleClient();
  const first = await startAndCallback({ store, google });
  assert.equal(first.authError, undefined);
  const created = await store.connections.findByHealthUserId('health-1');
  assert.ok(created);
  const userId = created!.userId;
  const connectionId = created!.id;
  assert.equal(created!.status, 'active');
  assert.ok(!JSON.stringify(created).includes('refresh-token'));

  const sessionUser = await readSessionUserId(store, first.sessionToken, now);
  assert.equal(sessionUser, userId);

  await disconnectUser({ store, google, config: oauthConfig(), userId, now });
  const disconnected = await store.connections.findByHealthUserId('health-1');
  assert.equal(disconnected?.status, 'disconnected');
  assert.equal(disconnected?.id, connectionId);
  assert.equal(await readSessionUserId(store, first.sessionToken, now), undefined);

  const second = await startAndCallback({ store, google });
  const restored = await store.connections.findByHealthUserId('health-1');
  assert.equal(restored?.userId, userId);
  assert.equal(restored?.id, connectionId);
  assert.equal(restored?.status, 'active');
  assert.equal(second.sessionToken !== first.sessionToken, true);
});

test('reauthorize without a new refresh token keeps the previous refresh token', async () => {
  const store = createMemoryStore();
  const firstGoogle = googleClient();
  const first = await startAndCallback({ store, google: firstGoogle });
  const userId = await readSessionUserId(store, first.sessionToken, now);

  const reauthGoogle = googleClient({
    async exchangeCode() {
      return tokens({ accessToken: 'access-token-2', refreshToken: undefined });
    },
  });
  const reauth = await startAndCallback({ store, google: reauthGoogle, sessionUserId: userId });
  assert.equal(reauth.authError, undefined);
  assert.equal(reauth.keepExistingSession, true);

  const row = await store.connections.findByUserId(userId!);
  assert.ok(row?.tokenEnvelopeCiphertext);
});

test('logged-in callback cannot attach another user identity', async () => {
  const store = createMemoryStore();
  const first = await startAndCallback({ store, google: googleClient() });
  const userA = await readSessionUserId(store, first.sessionToken, now);

  const other = googleClient({
    async getIdentity() {
      return { healthUserId: 'health-other', legacyUserId: undefined };
    },
  });
  const mismatch = await startAndCallback({ store, google: other, sessionUserId: userA });
  assert.equal(mismatch.authError, 'identity_mismatch');
  assert.equal(await store.connections.findByHealthUserId('health-other'), undefined);
});

test('two users only read their own connection', async () => {
  const store = createMemoryStore();
  await startAndCallback({ store, google: googleClient() });
  const secondGoogle = googleClient({
    async getIdentity() {
      return { healthUserId: 'health-2', legacyUserId: undefined };
    },
  });
  const second = await startAndCallback({ store, google: secondGoogle });
  const userB = await readSessionUserId(store, second.sessionToken, now);
  const own = await store.connections.findByUserId(userB!);
  const other = await store.connections.findByHealthUserId('health-1');
  assert.equal(own?.healthUserId, 'health-2');
  assert.notEqual(own?.userId, other?.userId);
});

test('disconnect still clears local credentials when Google revoke fails', async () => {
  const store = createMemoryStore();
  const first = await startAndCallback({ store, google: googleClient() });
  const userId = await readSessionUserId(store, first.sessionToken, now);
  const failing = googleClient({
    async revoke() {
      throw new Error('google down');
    },
  });
  const result = await disconnectUser({ store, google: failing, config: oauthConfig(), userId: userId!, now });
  assert.equal(result.googleRevokeFailed, true);
  assert.equal((await store.connections.findByUserId(userId!))?.status, 'disconnected');
  assert.equal(await readSessionUserId(store, first.sessionToken, now), undefined);
});
