import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleInternalNutritionSync,
  type InternalNutritionSyncWorkers,
} from '../../src/server/meals/internal-nutrition-sync';
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

test('nutrition sync endpoint is disabled without SYNC_SECRET', async () => {
  const config = loadConfig(oauthEnv());
  assert.equal(config.kind, 'oauth');
  const response = await handleInternalNutritionSync(
    new Request('http://localhost:3000/rhythm/api/internal/nutrition-sync', {
      method: 'POST',
      headers: { Authorization: 'Bearer unused' },
    }),
    { config, store: createMemoryStore() },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'scheduler_disabled' });
});

test('nutrition sync endpoint requires its bearer secret', async () => {
  const config = loadConfig(oauthEnv({ SYNC_SECRET: 'test-sync-secret' }));
  assert.equal(config.kind, 'oauth');
  const response = await handleInternalNutritionSync(
    new Request('http://localhost:3000/rhythm/api/internal/nutrition-sync', { method: 'POST' }),
    { config, store: createMemoryStore() },
  );
  assert.equal(response.status, 401);
});

test('nutrition sync endpoint runs legacy and current-meal workers with one token resolver and aggregates their counts', async () => {
  const config = loadConfig(oauthEnv({ SYNC_SECRET: 'test-sync-secret' }));
  assert.equal(config.kind, 'oauth');
  const tokenResolvers: Array<(userId: string) => Promise<string>> = [];
  const calls: string[] = [];
  const workers: InternalNutritionSyncWorkers = {
    async runLegacy(input) {
      calls.push('legacy');
      tokenResolvers.push(input.tokenForUser);
      assert.equal(await input.tokenForUser('legacy-user'), 'access-token');
      return { claimed: 2, succeeded: 1, failed: 0, retrying: 1, unknown: 0 };
    },
    async runCurrentMeals(input) {
      calls.push('current');
      tokenResolvers.push(input.tokenForUser);
      assert.equal(await input.tokenForUser('current-user'), 'access-token');
      return { claimed: 3, succeeded: 1, failed: 1, retrying: 0, unknown: 1 };
    },
  };
  const response = await handleInternalNutritionSync(
    new Request('http://localhost:3000/rhythm/api/internal/nutrition-sync', {
      method: 'POST', headers: { Authorization: 'Bearer test-sync-secret' },
    }),
    { config, store: createMemoryStore() },
    {
      ...workers,
      tokenForUser: async () => 'access-token',
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['legacy', 'current']);
  assert.equal(tokenResolvers[0], tokenResolvers[1]);
  assert.deepEqual(await response.json(), {
    claimed: 5, succeeded: 2, failed: 1, retrying: 1, unknown: 1,
    legacy: { claimed: 2, succeeded: 1, failed: 0, retrying: 1, unknown: 0 },
    currentMeals: { claimed: 3, succeeded: 1, failed: 1, retrying: 0, unknown: 1 },
  });
});

test('a current-meal worker failure becomes an aggregate failure without blocking the legacy worker', async () => {
  const config = loadConfig(oauthEnv({ SYNC_SECRET: 'test-sync-secret' }));
  assert.equal(config.kind, 'oauth');
  const calls: string[] = [];
  const workers: InternalNutritionSyncWorkers = {
    async runLegacy() {
      calls.push('legacy');
      return { claimed: 1, succeeded: 1, failed: 0, retrying: 0, unknown: 0 };
    },
    async runCurrentMeals() {
      calls.push('current');
      throw new Error('one malformed current meal row');
    },
  };
  const response = await handleInternalNutritionSync(
    new Request('http://localhost:3000/rhythm/api/internal/nutrition-sync', {
      method: 'POST', headers: { Authorization: 'Bearer test-sync-secret' },
    }),
    { config, store: createMemoryStore() },
    workers,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['legacy', 'current']);
  assert.deepEqual(await response.json(), {
    claimed: 1, succeeded: 1, failed: 1, retrying: 0, unknown: 0,
    legacy: { claimed: 1, succeeded: 1, failed: 0, retrying: 0, unknown: 0 },
    currentMeals: { claimed: 0, succeeded: 0, failed: 1, retrying: 0, unknown: 0 },
  });
});

test('a legacy worker failure does not block the current-meal worker', async () => {
  const config = loadConfig(oauthEnv({ SYNC_SECRET: 'test-sync-secret' }));
  assert.equal(config.kind, 'oauth');
  const calls: string[] = [];
  const workers: InternalNutritionSyncWorkers = {
    async runLegacy() {
      calls.push('legacy');
      throw new Error('one legacy outbox row is malformed');
    },
    async runCurrentMeals() {
      calls.push('current');
      return { claimed: 1, succeeded: 0, failed: 0, retrying: 1, unknown: 0 };
    },
  };
  const response = await handleInternalNutritionSync(
    new Request('http://localhost:3000/rhythm/api/internal/nutrition-sync', {
      method: 'POST', headers: { Authorization: 'Bearer test-sync-secret' },
    }),
    { config, store: createMemoryStore() },
    workers,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['legacy', 'current']);
  assert.deepEqual(await response.json(), {
    claimed: 1, succeeded: 0, failed: 1, retrying: 1, unknown: 0,
    legacy: { claimed: 0, succeeded: 0, failed: 1, retrying: 0, unknown: 0 },
    currentMeals: { claimed: 1, succeeded: 0, failed: 0, retrying: 1, unknown: 0 },
  });
});

test('nutrition sync endpoint does not call Google when neither outbox has work', async () => {
  const config = loadConfig(oauthEnv({ SYNC_SECRET: 'test-sync-secret' }));
  assert.equal(config.kind, 'oauth');
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error('Google must not be called without queued work');
  };
  try {
    const response = await handleInternalNutritionSync(
      new Request('http://localhost:3000/rhythm/api/internal/nutrition-sync', {
        method: 'POST', headers: { Authorization: 'Bearer test-sync-secret' },
      }),
      { config, store: createMemoryStore() },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      claimed: 0, succeeded: 0, failed: 0, retrying: 0, unknown: 0,
      legacy: { claimed: 0, succeeded: 0, failed: 0, retrying: 0, unknown: 0 },
      currentMeals: { claimed: 0, succeeded: 0, failed: 0, retrying: 0, unknown: 0 },
    });
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
