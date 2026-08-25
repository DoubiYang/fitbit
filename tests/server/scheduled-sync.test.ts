import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConnectionRow } from '../../src/server/auth/types';
import { createMemoryStore } from '../../src/server/db/memory-store';
import { runDueSyncForUser } from '../../src/server/health/scheduled-sync';

type ScheduledConnection = ConnectionRow & {
  nextSyncAt: Date;
  syncRetryCount: number;
  syncLeaseUntil: Date | undefined;
  lastSyncAttemptAt: Date | undefined;
};

function connection(userId: string, nextSyncAt: Date): ScheduledConnection {
  return {
    id: `connection-${userId}`,
    userId,
    healthUserId: `health-${userId}`,
    legacyUserId: undefined,
    tokenEnvelopeCiphertext: Buffer.from('ciphertext'),
    tokenEnvelopeIv: Buffer.alloc(12),
    tokenEnvelopeAuthTag: Buffer.alloc(16),
    encryptionKeyVersion: 1,
    accessTokenExpiresAt: new Date('2026-08-24T13:00:00.000Z'),
    refreshTokenExpiresAt: new Date('2026-08-31T12:00:00.000Z'),
    grantedScopes: [],
    status: 'active',
    lastErrorCode: undefined,
    connectedAt: new Date('2026-08-24T00:00:00.000Z'),
    updatedAt: new Date('2026-08-24T00:00:00.000Z'),
    lastSuccessfulSyncAt: undefined,
    nextSyncAt,
    syncRetryCount: 0,
    syncLeaseUntil: undefined,
    lastSyncAttemptAt: undefined,
  };
}

const config = {
  kind: 'oauth' as const,
  databaseUrl: 'postgresql://rhythm:x@db:5432/rhythm',
  googleClientId: 'client.apps.googleusercontent.com',
  googleClientSecret: 'secret',
  syncSecret: 'test-sync-secret',
  appOrigin: 'http://localhost:3000',
  appBasePath: '/rhythm' as const,
  tokenEncryptionKey: Buffer.alloc(32),
  tokenEncryptionKeyPrevious: undefined,
};

test('a successful due sync schedules only the claimed user six hours later', async () => {
  const store = createMemoryStore();
  const now = new Date('2026-08-24T12:00:00.000Z');
  const due = connection('due-user', now);
  const other = connection('other-user', now);
  for (const row of [due, other]) {
    await store.users.insert(row.userId);
    await store.connections.insert(row);
  }
  const calls: string[] = [];

  const result = await runDueSyncForUser({
    config,
    store,
    userId: due.userId,
    now,
    syncConnection: async (row) => {
      calls.push(row.userId);
    },
  });

  assert.deepEqual(result, { claimed: 1, succeeded: 1, failed: 0 });
  assert.deepEqual(calls, ['due-user']);
  const scheduled = (await store.connections.findByUserId(due.userId)) as ScheduledConnection;
  assert.equal(scheduled.nextSyncAt.toISOString(), '2026-08-24T18:00:00.000Z');
  assert.equal(scheduled.syncRetryCount, 0);
  assert.equal(scheduled.syncLeaseUntil, undefined);
  assert.equal(scheduled.lastErrorCode, undefined);
  assert.equal(((await store.connections.findByUserId(other.userId)) as ScheduledConnection).nextSyncAt.toISOString(), now.toISOString());
});

test('failed due syncs retry at 30 minutes, one hour, two hours, then return to the six-hour cycle', async () => {
  const store = createMemoryStore();
  const startedAt = new Date('2026-08-24T12:00:00.000Z');
  const row = connection('retry-user', startedAt);
  await store.users.insert(row.userId);
  await store.connections.insert(row);
  const expected = [
    '2026-08-24T12:30:00.000Z',
    '2026-08-24T13:30:00.000Z',
    '2026-08-24T15:30:00.000Z',
    '2026-08-24T21:30:00.000Z',
  ];
  let now = startedAt;
  for (const nextSyncAt of expected) {
    const result = await runDueSyncForUser({
      config,
      store,
      userId: row.userId,
      now,
      syncConnection: async () => {
        throw new Error('health api 429');
      },
    });
    assert.deepEqual(result, { claimed: 1, succeeded: 0, failed: 1 });
    const scheduled = (await store.connections.findByUserId(row.userId)) as ScheduledConnection;
    assert.equal(scheduled.nextSyncAt.toISOString(), nextSyncAt);
    assert.equal(scheduled.lastErrorCode, 'rate_limited');
    now = new Date(nextSyncAt);
  }
  assert.equal(((await store.connections.findByUserId(row.userId)) as ScheduledConnection).syncRetryCount, 0);
});

test('a disconnected in-flight sync does not requeue or leave a lease', async () => {
  const store = createMemoryStore();
  const now = new Date('2026-08-24T12:00:00.000Z');
  const row = connection('disconnect-user', now);
  await store.users.insert(row.userId);
  await store.connections.insert(row);

  const result = await runDueSyncForUser({
    config,
    store,
    userId: row.userId,
    now,
    syncConnection: async () => {
      const current = (await store.connections.findByUserId(row.userId)) as ScheduledConnection;
      await store.connections.update({
        ...current,
        status: 'disconnected',
        nextSyncAt: undefined,
        syncLeaseUntil: undefined,
        syncRetryCount: 0,
      });
      throw new Error('connection no longer syncable');
    },
  });

  assert.deepEqual(result, { claimed: 1, succeeded: 0, failed: 1 });
  const current = (await store.connections.findByUserId(row.userId)) as ScheduledConnection;
  assert.equal(current.status, 'disconnected');
  assert.equal(current.nextSyncAt, undefined);
  assert.equal(current.syncLeaseUntil, undefined);
});
