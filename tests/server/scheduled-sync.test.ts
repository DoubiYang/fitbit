import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConnectionRow } from '../../src/server/auth/types';
import { createMemoryStore } from '../../src/server/db/memory-store';
import { TokenRefreshError } from '../../src/server/health/access-token';
import { runDueSyncForUser, runDueSyncs, scheduleInitialSync } from '../../src/server/health/scheduled-sync';
import type { HealthSyncDataType } from '../../src/server/health/cardio-store';

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

test('initial sync logs claimed/succeeded/failed instead of swallowing the result', async () => {
  const work: Array<() => void | Promise<void>> = [];
  const logs: string[] = [];
  scheduleInitialSync(
    async () => ({ claimed: 1, succeeded: 1, failed: 0 }),
    (task) => {
      work.push(task);
    },
    (message) => logs.push(message),
  );
  assert.equal(work.length, 1);
  await work[0]?.();
  assert.deepEqual(logs, ['[sync] initial claimed=1 succeeded=1 failed=0']);
});

test('initial sync logs a failure without throwing into the request', async () => {
  const work: Array<() => void | Promise<void>> = [];
  const logs: string[] = [];
  scheduleInitialSync(
    async () => {
      throw new Error('connection no longer syncable');
    },
    (task) => {
      work.push(task);
    },
    (message) => logs.push(message),
  );
  await work[0]?.();
  assert.deepEqual(logs, ['[sync] initial sync failed']);
});

test('claims each due user under a fresh lease instead of leasing the whole batch up front', async () => {
  const store = createMemoryStore();
  const now = new Date('2026-08-24T12:00:00.000Z');
  for (const userId of ['first-user', 'second-user']) {
    const row = connection(userId, now);
    await store.users.insert(row.userId);
    await store.connections.insert(row);
  }
  const claimLimits: number[] = [];
  const originalClaim = store.connections.claimDueSyncs.bind(store.connections);
  store.connections.claimDueSyncs = async (input) => {
    claimLimits.push(input.limit);
    return originalClaim(input);
  };

  const result = await runDueSyncs({
    config,
    store,
    now,
    limit: 2,
    syncConnection: async () => {},
  });

  assert.deepEqual(result, { claimed: 2, succeeded: 2, failed: 0 });
  assert.deepEqual(claimLimits, [1, 1]);
});

test('a successful due sync schedules only the claimed user one hour later', async () => {
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
  assert.equal(scheduled.nextSyncAt.toISOString(), '2026-08-24T13:00:00.000Z');
  assert.equal(scheduled.syncRetryCount, 0);
  assert.equal(scheduled.syncLeaseUntil, undefined);
  assert.equal(scheduled.lastErrorCode, undefined);
  assert.equal(((await store.connections.findByUserId(other.userId)) as ScheduledConnection).nextSyncAt.toISOString(), now.toISOString());
});

test('failed due syncs retry at 30 minutes, one hour, two hours, then return to the one-hour cycle', async () => {
  const store = createMemoryStore();
  const startedAt = new Date('2026-08-24T12:00:00.000Z');
  const row = connection('retry-user', startedAt);
  await store.users.insert(row.userId);
  await store.connections.insert(row);
  const expected = [
    '2026-08-24T12:30:00.000Z',
    '2026-08-24T13:30:00.000Z',
    '2026-08-24T15:30:00.000Z',
    '2026-08-24T16:30:00.000Z',
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

test('health api 401 and 403 stay on the retry schedule instead of expiring', async () => {
  const store = createMemoryStore();
  const now = new Date('2026-08-24T12:00:00.000Z');
  for (const [userId, message] of [
    ['health-401', 'health api 401'],
    ['health-403', 'health api 403'],
  ] as const) {
    const row = connection(userId, now);
    await store.users.insert(row.userId);
    await store.connections.insert(row);
    await runDueSyncForUser({
      config,
      store,
      userId,
      now,
      syncConnection: async () => {
        throw new Error(message);
      },
    });
    const current = (await store.connections.findByUserId(userId)) as ScheduledConnection;
    assert.equal(current.status, 'active');
    assert.equal(current.nextSyncAt.toISOString(), '2026-08-24T12:30:00.000Z');
    assert.equal(current.lastErrorCode, 'sync_failed');
  }
});

test('an in-flight auth failure does not expire a reauthorized envelope', async () => {
  const store = createMemoryStore();
  const now = new Date('2026-08-24T12:00:00.000Z');
  const row = connection('reauth-user', now);
  await store.users.insert(row.userId);
  await store.connections.insert(row);

  await runDueSyncForUser({
    config,
    store,
    userId: row.userId,
    now,
    syncConnection: async () => {
      const current = (await store.connections.findByUserId(row.userId)) as ScheduledConnection;
      await store.connections.update({
        ...current,
        tokenEnvelopeCiphertext: Buffer.from('new-envelope'),
        nextSyncAt: now,
        lastErrorCode: undefined,
      });
      throw new TokenRefreshError(400);
    },
  });

  const current = (await store.connections.findByUserId(row.userId)) as ScheduledConnection;
  assert.equal(current.status, 'active');
  assert.equal(current.nextSyncAt.toISOString(), now.toISOString());
  assert.equal(current.syncLeaseUntil, undefined);
  assert.equal(current.lastErrorCode, undefined);
  assert.deepEqual(current.tokenEnvelopeCiphertext, Buffer.from('new-envelope'));
});

test('a successful in-flight sync keeps a reauthorize due time instead of pushing one hour', async () => {
  const store = createMemoryStore();
  const now = new Date('2026-08-24T12:00:00.000Z');
  const row = connection('success-reauth', now);
  await store.users.insert(row.userId);
  await store.connections.insert(row);

  await runDueSyncForUser({
    config,
    store,
    userId: row.userId,
    now,
    syncConnection: async () => {
      const current = (await store.connections.findByUserId(row.userId)) as ScheduledConnection;
      await store.connections.update({
        ...current,
        nextSyncAt: now,
      });
    },
  });

  const current = (await store.connections.findByUserId(row.userId)) as ScheduledConnection;
  assert.equal(current.status, 'active');
  assert.equal(current.nextSyncAt.toISOString(), now.toISOString());
  assert.equal(current.syncLeaseUntil, undefined);
});

test('token refresh auth failures expire; 5xx stays on retry', async () => {
  const store = createMemoryStore();
  const now = new Date('2026-08-24T12:00:00.000Z');
  const authRow = connection('refresh-auth', now);
  const serverRow = connection('refresh-5xx', now);
  for (const row of [authRow, serverRow]) {
    await store.users.insert(row.userId);
    await store.connections.insert(row);
  }

  await runDueSyncForUser({
    config,
    store,
    userId: authRow.userId,
    now,
    syncConnection: async () => {
      throw new TokenRefreshError(400);
    },
  });
  await runDueSyncForUser({
    config,
    store,
    userId: serverRow.userId,
    now,
    syncConnection: async () => {
      throw new TokenRefreshError(500);
    },
  });

  const expired = (await store.connections.findByUserId(authRow.userId)) as ScheduledConnection;
  const retried = (await store.connections.findByUserId(serverRow.userId)) as ScheduledConnection;
  assert.equal(expired.status, 'expired');
  assert.equal(expired.nextSyncAt, undefined);
  assert.equal(retried.status, 'active');
  assert.equal(retried.nextSyncAt.toISOString(), '2026-08-24T12:30:00.000Z');
  assert.equal(retried.lastErrorCode, 'sync_failed');
});

test('a successful sync becomes due at the earliest per-type cursor retry', async () => {
  const store = createMemoryStore();
  const now = new Date('2026-08-24T12:00:00.000Z');
  const row = connection('cursor-user', now);
  await store.users.insert(row.userId);
  await store.connections.insert(row);
  await store.healthMetrics.updateCursor({
    connectionId: row.id,
    dataType: 'heart-rate' satisfies HealthSyncDataType,
    successfulWatermark: undefined,
    lastErrorCode: 'rate_limited',
    retryCount: 1,
    nextAttemptAt: new Date('2026-08-24T12:30:00.000Z'),
  });
  await store.healthMetrics.updateCursor({
    connectionId: row.id,
    dataType: 'activity-level',
    successfulWatermark: now,
    lastErrorCode: undefined,
    retryCount: 0,
    nextAttemptAt: new Date('2026-08-24T13:00:00.000Z'),
  });

  await runDueSyncForUser({
    config,
    store,
    userId: row.userId,
    now,
    syncConnection: async () => {},
  });

  const scheduled = (await store.connections.findByUserId(row.userId)) as ScheduledConnection;
  assert.equal(scheduled.nextSyncAt.toISOString(), '2026-08-24T12:30:00.000Z');
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

test('an aborted scheduled run only schedules a retry through its own lease token', async () => {
  const store = createMemoryStore();
  const now = new Date('2026-08-24T12:00:00.000Z');
  const row = connection('abort-user', now);
  await store.users.insert(row.userId);
  await store.connections.insert(row);
  const abort = new AbortController();
  const reason = new Error('test deadline');
  abort.abort(reason);
  let syncStarted = 0;
  let callbackSawAborted: boolean | undefined;
  let callbackReason: unknown;

  const result = await runDueSyncForUser({
    config,
    store,
    userId: row.userId,
    now,
    signal: abort.signal,
    syncConnection: async (_connection, run) => {
      syncStarted += 1;
      callbackSawAborted = run.signal.aborted;
      callbackReason = run.signal.reason;
    },
  });

  assert.deepEqual(result, { claimed: 1, succeeded: 0, failed: 1 });
  assert.equal(syncStarted, 0);
  assert.equal(callbackSawAborted, undefined);
  assert.equal(callbackReason, undefined);
  const current = (await store.connections.findByUserId(row.userId)) as ScheduledConnection;
  assert.equal(current.syncLeaseUntil, undefined);
  assert.equal(current.nextSyncAt?.toISOString(), '2026-08-24T12:30:00.000Z');
});

test('a deadline that fires after sync work returns cannot be finalized as a success', async () => {
  const store = createMemoryStore();
  const now = new Date('2026-08-24T12:00:00.000Z');
  const row = connection('post-work-abort-user', now);
  await store.users.insert(row.userId);
  await store.connections.insert(row);
  const controller = new AbortController();

  const result = await runDueSyncForUser({
    config,
    store,
    userId: row.userId,
    now,
    signal: controller.signal,
    syncConnection: async () => {
      controller.abort(new Error('test deadline'));
    },
  });

  assert.deepEqual(result, { claimed: 1, succeeded: 0, failed: 1 });
  const current = (await store.connections.findByUserId(row.userId)) as ScheduledConnection;
  assert.equal(current.nextSyncAt?.toISOString(), '2026-08-24T12:30:00.000Z');
  assert.equal(current.lastErrorCode, 'sync_failed');
});
