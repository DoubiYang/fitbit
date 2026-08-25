import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConnectionRow } from '../../src/server/auth/types';
import { loadConfig } from '../../src/server/config/env';
import { createMemoryStore } from '../../src/server/db/memory-store';
import { syncUserConnection } from '../../src/server/health/run-sync';

const key = Buffer.alloc(32, 3).toString('base64');

function oauthConfig() {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://rhythm:x@db:5432/rhythm',
    GOOGLE_HEALTH_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_HEALTH_CLIENT_SECRET: 'secret',
    TOKEN_ENCRYPTION_KEY: key,
    SYNC_SECRET: 'test-sync-secret',
    APP_ORIGIN: 'http://localhost:3000',
  });
  if (config.kind !== 'oauth') {
    throw new Error('expected oauth');
  }
  return config;
}

function connection(overrides: Partial<ConnectionRow> & Pick<ConnectionRow, 'id' | 'userId' | 'healthUserId'>): ConnectionRow {
  return {
    legacyUserId: undefined,
    tokenEnvelopeCiphertext: Buffer.from('x'),
    tokenEnvelopeIv: Buffer.from('y'),
    tokenEnvelopeAuthTag: Buffer.from('z'),
    encryptionKeyVersion: 1,
    accessTokenExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    refreshTokenExpiresAt: new Date('2099-01-08T00:00:00.000Z'),
    grantedScopes: [],
    status: 'active',
    lastErrorCode: undefined,
    connectedAt: new Date('2026-08-24T00:00:00.000Z'),
    updatedAt: new Date('2026-08-24T00:00:00.000Z'),
    lastSuccessfulSyncAt: undefined,
    ...overrides,
  };
}

test('initial sync only reads the selected active user for the recent 14-day range', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.users.insert('u2');
  await store.users.insert('u3');
  await store.connections.insert(connection({ id: 'c1', userId: 'u1', healthUserId: 'h1' }));
  await store.connections.insert(connection({ id: 'c2', userId: 'u2', healthUserId: 'h2' }));
  await store.connections.insert(connection({ id: 'c3', userId: 'u3', healthUserId: 'h3', status: 'disconnected' }));

  const seen: string[] = [];
  const result = await syncUserConnection({
    config: oauthConfig(),
    store,
    userId: 'u1',
    now: new Date('2026-08-24T12:00:00.000Z'),
    syncOne: async (row, range) => {
      seen.push(`${row.userId}:${range.from}:${range.to}`);
    },
  });

  assert.equal(result, true);
  assert.deepEqual(seen, ['u1:2026-08-11:2026-08-24']);
});

test('initial sync does not read an expired or disconnected connection', async () => {
  const store = createMemoryStore();
  await store.users.insert('u1');
  await store.connections.insert(connection({ id: 'c1', userId: 'u1', healthUserId: 'h1', status: 'expired' }));

  const result = await syncUserConnection({
    config: oauthConfig(),
    store,
    userId: 'u1',
    syncOne: async () => {
      throw new Error('must not sync');
    },
  });

  assert.equal(result, false);
});
