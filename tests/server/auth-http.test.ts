import assert from 'node:assert/strict';
import test from 'node:test';

import { handleDisconnect, handleGoogleCallback, handleGoogleStart, handleReauthorize } from '../../src/server/auth/http';
import { completeGoogleOAuth, startGoogleOAuth } from '../../src/server/auth/oauth-service';
import { REQUESTED_SCOPES } from '../../src/server/auth/scopes';
import type { GoogleOAuthClient } from '../../src/server/auth/types';
import { loadConfig } from '../../src/server/config/env';
import { createMemoryStore } from '../../src/server/db/memory-store';

const validKey = Buffer.alloc(32, 9).toString('base64');
const now = new Date('2026-08-24T12:00:00.000Z');

function config() {
  const loaded = loadConfig({
    DATABASE_URL: 'postgresql://rhythm:x@db:5432/rhythm',
    GOOGLE_HEALTH_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_HEALTH_CLIENT_SECRET: 'client-secret',
    TOKEN_ENCRYPTION_KEY: validKey,
    APP_ORIGIN: 'http://localhost:3000',
  });
  if (loaded.kind !== 'oauth') {
    throw new Error('expected oauth');
  }
  return loaded;
}

function google(): GoogleOAuthClient {
  return {
    async exchangeCode() {
      return {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: new Date('2026-08-24T13:00:00.000Z'),
        refreshExpiresAt: undefined,
        grantedScopes: [...REQUESTED_SCOPES],
      };
    },
    async getIdentity() {
      return { healthUserId: 'health-1', legacyUserId: undefined };
    },
    async revoke() {},
  };
}

test('GET start is 405', async () => {
  const response = await handleGoogleStart(new Request('http://localhost:3000/rhythm/api/auth/google/start'), {
    config: config(),
    store: createMemoryStore(),
  });
  assert.equal(response.status, 405);
});

test('cross-origin POST is rejected', async () => {
  const response = await handleGoogleStart(
    new Request('http://localhost:3000/rhythm/api/auth/google/start', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    }),
    { config: config(), store: createMemoryStore() },
  );
  assert.equal(response.status, 303);
  assert.match(response.headers.get('Location') ?? '', /auth_error=origin_rejected/);
});

test('callback ignores unexpected query keys and sets host-only session cookie path', async () => {
  const store = createMemoryStore();
  const started = await startGoogleOAuth({ config: config(), store, now });
  assert.equal(started.kind, 'redirect');
  if (started.kind !== 'redirect') {
    return;
  }
  const state = new URL(started.url).searchParams.get('state');
  const response = await handleGoogleCallback(
    new Request(
      `http://localhost:3000/rhythm/api/auth/google/callback?code=code-1&state=${state}&foo=bar`,
      { headers: { Cookie: `rhythm_oauth_tx=${started.transactionId}` } },
    ),
    { config: config(), store, google: google(), now: () => now },
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), 'http://localhost:3000/rhythm/account');
  const cookies = response.headers.getSetCookie?.() ?? [];
  const session = cookies.find((item) => item.startsWith('rhythm_session='));
  assert.ok(session);
  assert.match(session ?? '', /Path=\/rhythm/);
  assert.doesNotMatch(session ?? '', /Domain=/);
  assert.doesNotMatch(JSON.stringify(cookies), /refresh-token/);
  assert.doesNotMatch(JSON.stringify(cookies), /access-token/);
});

test('reauthorize and disconnect require a session', async () => {
  const deps = { config: config(), store: createMemoryStore(), google: google(), now: () => now };
  const reauth = await handleReauthorize(
    new Request('http://localhost:3000/rhythm/api/account/reauthorize', { method: 'POST', headers: { Origin: 'http://localhost:3000' } }),
    deps,
  );
  assert.equal(reauth.status, 401);

  const disconnect = await handleDisconnect(
    new Request('http://localhost:3000/rhythm/api/account/disconnect', { method: 'POST', headers: { Origin: 'http://localhost:3000' } }),
    deps,
  );
  assert.equal(disconnect.status, 401);
});

test('https production POST without Origin is rejected', async () => {
  const production = loadConfig({
    DATABASE_URL: 'postgresql://rhythm:x@db:5432/rhythm',
    GOOGLE_HEALTH_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_HEALTH_CLIENT_SECRET: 'client-secret',
    TOKEN_ENCRYPTION_KEY: validKey,
    APP_ORIGIN: 'https://doubiyang.com',
  });
  const response = await handleGoogleStart(new Request('https://doubiyang.com/rhythm/api/auth/google/start', { method: 'POST' }), {
    config: production,
    store: createMemoryStore(),
  });
  assert.equal(response.status, 303);
  assert.match(response.headers.get('Location') ?? '', /origin_rejected/);
});

test('complete oauth helper still works after HTTP callback cookie parse', async () => {
  const store = createMemoryStore();
  const started = await startGoogleOAuth({ config: config(), store, now });
  assert.equal(started.kind, 'redirect');
  if (started.kind !== 'redirect') {
    return;
  }
  const result = await completeGoogleOAuth({
    config: config(),
    store,
    google: google(),
    query: { code: 'code-1', state: new URL(started.url).searchParams.get('state') ?? undefined },
    transactionId: started.transactionId,
    now,
  });
  assert.equal(result.authError, undefined);
});
