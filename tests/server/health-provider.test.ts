import assert from 'node:assert/strict';
import test from 'node:test';

import { encryptTokenEnvelope } from '../../src/server/crypto/token-envelope';
import { loadConfig } from '../../src/server/config/env';
import { createMemoryStore } from '../../src/server/db/memory-store';
import { DemoHealthProvider } from '../../src/server/health/demo-provider';
import { GoogleHealthProvider } from '../../src/server/health/google-health-provider';
import { getCurrentUser } from '../../src/server/session/current-user';

const range = { from: '2026-07-24', to: '2026-08-22' };
const key = Buffer.alloc(32, 3);

test('live provider maps Health API points and does not leak another user', async () => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://rhythm:x@db:5432/rhythm',
    GOOGLE_HEALTH_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_HEALTH_CLIENT_SECRET: 'secret',
    TOKEN_ENCRYPTION_KEY: key.toString('base64'),
    APP_ORIGIN: 'http://localhost:3000',
  });
  assert.equal(config.kind, 'oauth');
  if (config.kind !== 'oauth') {
    return;
  }
  const store = createMemoryStore();
  const encrypted = encryptTokenEnvelope({ accessToken: 'access', refreshToken: 'refresh' }, key, 'c1', 'u1');
  const connection = {
    id: 'c1',
    userId: 'u1',
    healthUserId: 'h1',
    legacyUserId: undefined,
    tokenEnvelopeCiphertext: encrypted.ciphertext,
    tokenEnvelopeIv: encrypted.iv,
    tokenEnvelopeAuthTag: encrypted.authTag,
    encryptionKeyVersion: 1,
    accessTokenExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    refreshTokenExpiresAt: new Date('2099-01-08T00:00:00.000Z'),
    grantedScopes: [],
    status: 'active' as const,
    lastErrorCode: undefined,
    connectedAt: new Date('2026-08-24T00:00:00.000Z'),
    updatedAt: new Date('2026-08-24T00:00:00.000Z'),
    lastSuccessfulSyncAt: undefined,
  };
  await store.users.insert('u1');
  await store.connections.insert(connection);
  const provider = new GoogleHealthProvider({
    config,
    store,
    connection,
    api: {
      async listDataPoints(input) {
        if (input.dataType === 'sleep') {
          return [
            {
              name: 'sleep-1',
              sleep: {
                type: 'STAGES',
                interval: {
                  startTime: '2026-08-23T21:00:00Z',
                  endTime: '2026-08-24T05:00:00Z',
                  endUtcOffset: '0s',
                  civilEndTime: { date: { year: 2026, month: 8, day: 24 } },
                },
                summary: { minutesAsleep: '400', minutesInSleepPeriod: '480', minutesAwake: '80' },
              },
            },
          ];
        }
        return [];
      },
    },
    refresher: {
      async refresh() {
        throw new Error('should not refresh');
      },
    },
  });

  const own = await provider.listRecords('u1', range);
  const other = await provider.listRecords('someone-else', range);
  assert.equal(own.sleepSessions.length, 1);
  assert.equal(own.sleepSessions[0]?.minutesAsleep, 400);
  assert.deepEqual(other, { sleepSessions: [], dailyHrv: [], dailyRhr: [], trainingDays: [] });
  assert.ok((await store.connections.findByUserId('u1'))?.lastSuccessfulSyncAt);
});

test('live provider fails closed when one core Health API filter fails', async () => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://rhythm:x@db:5432/rhythm',
    GOOGLE_HEALTH_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_HEALTH_CLIENT_SECRET: 'secret',
    TOKEN_ENCRYPTION_KEY: key.toString('base64'),
    APP_ORIGIN: 'http://localhost:3000',
  });
  assert.equal(config.kind, 'oauth');
  if (config.kind !== 'oauth') {
    return;
  }
  const store = createMemoryStore();
  const encrypted = encryptTokenEnvelope({ accessToken: 'access', refreshToken: 'refresh' }, key, 'c2', 'u2');
  const connection = {
    id: 'c2',
    userId: 'u2',
    healthUserId: 'h2',
    legacyUserId: undefined,
    tokenEnvelopeCiphertext: encrypted.ciphertext,
    tokenEnvelopeIv: encrypted.iv,
    tokenEnvelopeAuthTag: encrypted.authTag,
    encryptionKeyVersion: 1,
    accessTokenExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    refreshTokenExpiresAt: new Date('2099-01-08T00:00:00.000Z'),
    grantedScopes: [],
    status: 'active' as const,
    lastErrorCode: undefined,
    connectedAt: new Date('2026-08-24T00:00:00.000Z'),
    updatedAt: new Date('2026-08-24T00:00:00.000Z'),
    lastSuccessfulSyncAt: undefined,
  };
  await store.users.insert('u2');
  await store.connections.insert(connection);
  const provider = new GoogleHealthProvider({
    config,
    store,
    connection,
    api: {
      async listDataPoints(input) {
        if (input.dataType === 'daily-heart-rate-variability') {
          throw new Error('health api 400');
        }
        if (input.dataType === 'sleep') {
          return [
            {
              dataPointName: 'sleep-1',
              sleep: {
                type: 'STAGES',
                interval: {
                  startTime: '2026-08-23T21:00:00Z',
                  endTime: '2026-08-24T05:00:00Z',
                  endUtcOffset: '0s',
                },
                summary: { minutesAsleep: '400', minutesInSleepPeriod: '480', minutesAwake: '80' },
              },
            },
          ];
        }
        return [];
      },
    },
    refresher: {
      async refresh() {
        throw new Error('should not refresh');
      },
    },
  });
  await assert.rejects(() => provider.listRecords('u2', range), /health api 400/);
});

test('does not replace a successful snapshot when any core Health API query fails', async () => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://rhythm:x@db:5432/rhythm',
    GOOGLE_HEALTH_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_HEALTH_CLIENT_SECRET: 'secret',
    TOKEN_ENCRYPTION_KEY: key.toString('base64'),
    APP_ORIGIN: 'http://localhost:3000',
  });
  assert.equal(config.kind, 'oauth');
  if (config.kind !== 'oauth') {
    return;
  }
  const store = createMemoryStore();
  const encrypted = encryptTokenEnvelope({ accessToken: 'access', refreshToken: 'refresh' }, key, 'c3', 'u3');
  const previousSync = new Date('2026-08-23T08:00:00.000Z');
  const connection = {
    id: 'c3',
    userId: 'u3',
    healthUserId: 'h3',
    legacyUserId: undefined,
    tokenEnvelopeCiphertext: encrypted.ciphertext,
    tokenEnvelopeIv: encrypted.iv,
    tokenEnvelopeAuthTag: encrypted.authTag,
    encryptionKeyVersion: 1,
    accessTokenExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    refreshTokenExpiresAt: new Date('2099-01-08T00:00:00.000Z'),
    grantedScopes: [],
    status: 'active' as const,
    lastErrorCode: undefined,
    connectedAt: new Date('2026-08-24T00:00:00.000Z'),
    updatedAt: new Date('2026-08-24T00:00:00.000Z'),
    lastSuccessfulSyncAt: previousSync,
  };
  await store.users.insert('u3');
  await store.connections.insert(connection);
  let persisted = false;
  const provider = new GoogleHealthProvider({
    config,
    store,
    connection,
    api: {
      async listDataPoints(input) {
        if (input.dataType === 'daily-heart-rate-variability') {
          throw new Error('health api 429');
        }
        return [];
      },
    },
    refresher: { async refresh() { throw new Error('should not refresh'); } },
    persistSnapshot: async () => {
      persisted = true;
    },
  });

  await assert.rejects(() => provider.listRecords('u3', range), /health api 429/);
  assert.equal(persisted, false);
  assert.equal((await store.connections.findByUserId('u3'))?.lastSuccessfulSyncAt?.toISOString(), previousSync.toISOString());
});

test('does not mark a sync successful when snapshot persistence fails', async () => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://rhythm:x@db:5432/rhythm',
    GOOGLE_HEALTH_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_HEALTH_CLIENT_SECRET: 'secret',
    TOKEN_ENCRYPTION_KEY: key.toString('base64'),
    APP_ORIGIN: 'http://localhost:3000',
  });
  assert.equal(config.kind, 'oauth');
  if (config.kind !== 'oauth') {
    return;
  }
  const store = createMemoryStore();
  const encrypted = encryptTokenEnvelope({ accessToken: 'access', refreshToken: 'refresh' }, key, 'c4', 'u4');
  const previousSync = new Date('2026-08-23T08:00:00.000Z');
  const connection = {
    id: 'c4',
    userId: 'u4',
    healthUserId: 'h4',
    legacyUserId: undefined,
    tokenEnvelopeCiphertext: encrypted.ciphertext,
    tokenEnvelopeIv: encrypted.iv,
    tokenEnvelopeAuthTag: encrypted.authTag,
    encryptionKeyVersion: 1,
    accessTokenExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    refreshTokenExpiresAt: new Date('2099-01-08T00:00:00.000Z'),
    grantedScopes: [],
    status: 'active' as const,
    lastErrorCode: undefined,
    connectedAt: new Date('2026-08-24T00:00:00.000Z'),
    updatedAt: new Date('2026-08-24T00:00:00.000Z'),
    lastSuccessfulSyncAt: previousSync,
  };
  await store.users.insert('u4');
  await store.connections.insert(connection);
  const provider = new GoogleHealthProvider({
    config,
    store,
    connection,
    api: { async listDataPoints() { return []; } },
    refresher: { async refresh() { throw new Error('should not refresh'); } },
    persistSnapshot: async () => { throw new Error('snapshot unavailable'); },
  });

  await assert.rejects(() => provider.listRecords('u4', range), /snapshot unavailable/);
  assert.equal((await store.connections.findByUserId('u4'))?.lastSuccessfulSyncAt?.toISOString(), previousSync.toISOString());
});

test('does not persist a snapshot after the connection is disconnected during sync', async () => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://rhythm:x@db:5432/rhythm',
    GOOGLE_HEALTH_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_HEALTH_CLIENT_SECRET: 'secret',
    TOKEN_ENCRYPTION_KEY: key.toString('base64'),
    APP_ORIGIN: 'http://localhost:3000',
  });
  assert.equal(config.kind, 'oauth');
  if (config.kind !== 'oauth') {
    return;
  }
  const store = createMemoryStore();
  const encrypted = encryptTokenEnvelope({ accessToken: 'access', refreshToken: 'refresh' }, key, 'c5', 'u5');
  const connection = {
    id: 'c5',
    userId: 'u5',
    healthUserId: 'h5',
    legacyUserId: undefined,
    tokenEnvelopeCiphertext: encrypted.ciphertext,
    tokenEnvelopeIv: encrypted.iv,
    tokenEnvelopeAuthTag: encrypted.authTag,
    encryptionKeyVersion: 1,
    accessTokenExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    refreshTokenExpiresAt: new Date('2099-01-08T00:00:00.000Z'),
    grantedScopes: [],
    status: 'active' as const,
    lastErrorCode: undefined,
    connectedAt: new Date('2026-08-24T00:00:00.000Z'),
    updatedAt: new Date('2026-08-24T00:00:00.000Z'),
    lastSuccessfulSyncAt: undefined,
  };
  await store.users.insert('u5');
  await store.connections.insert(connection);
  let disconnected = false;
  let persisted = false;
  const provider = new GoogleHealthProvider({
    config,
    store,
    connection,
    api: {
      async listDataPoints() {
        if (!disconnected) {
          disconnected = true;
          const latest = await store.connections.findByUserId('u5');
          if (latest) {
            await store.connections.update({ ...latest, status: 'disconnected', updatedAt: new Date('2026-08-24T12:00:00.000Z') });
          }
        }
        return [];
      },
    },
    refresher: { async refresh() { throw new Error('should not refresh'); } },
    persistSnapshot: async () => {
      persisted = true;
    },
  });

  await assert.rejects(() => provider.listRecords('u5', range), /connection no longer syncable/);
  assert.equal(persisted, false);
});

test('returns copied demo records only for the resolved demo user', async () => {
  const provider = new DemoHealthProvider();
  const first = await provider.listRecords('demo_user', range);
  const second = await provider.listRecords('demo_user', range);
  const otherUser = await provider.listRecords('user_b', range);

  assert.ok(first.sleepSessions.length >= 14);
  assert.notEqual(first.sleepSessions, second.sleepSessions);
  assert.deepEqual(otherUser, { sleepSessions: [], dailyHrv: [], dailyRhr: [], trainingDays: [] });
});

test('uses a server-owned demo session rather than a client-supplied health user ID', async () => {
  const user = await getCurrentUser();

  assert.deepEqual(user, { id: 'demo_user', mode: 'demo' });
});
