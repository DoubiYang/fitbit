import assert from 'node:assert/strict';
import test from 'node:test';

import { handleInternalSync } from '../../src/server/health/internal-sync';
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
