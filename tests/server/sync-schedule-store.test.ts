import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMetricResult } from '../../src/domain/cardio-records';
import { WHOOP_STYLE_METRIC_VERSION } from '../../src/domain/metric-types';
import type { ConnectionRow } from '../../src/server/auth/types';
import { createMemoryStore } from '../../src/server/db/memory-store';

type ScheduledConnection = ConnectionRow & {
  nextSyncAt: Date | undefined;
  syncRetryCount: number;
  syncLeaseUntil: Date | undefined;
  lastSyncAttemptAt: Date | undefined;
};

function connection(input: Partial<ScheduledConnection> & Pick<ScheduledConnection, 'id' | 'userId' | 'status'>): ScheduledConnection {
  return {
    id: input.id,
    userId: input.userId,
    healthUserId: `health-${input.userId}`,
    legacyUserId: undefined,
    tokenEnvelopeCiphertext: 'tokenEnvelopeCiphertext' in input ? input.tokenEnvelopeCiphertext : Buffer.from('ciphertext'),
    tokenEnvelopeIv: 'tokenEnvelopeIv' in input ? input.tokenEnvelopeIv : Buffer.alloc(12),
    tokenEnvelopeAuthTag: 'tokenEnvelopeAuthTag' in input ? input.tokenEnvelopeAuthTag : Buffer.alloc(16),
    encryptionKeyVersion: 1,
    accessTokenExpiresAt: new Date('2026-08-24T13:00:00.000Z'),
    refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? new Date('2026-08-31T12:00:00.000Z'),
    grantedScopes: [],
    status: input.status,
    lastErrorCode: undefined,
    connectedAt: new Date('2026-08-24T00:00:00.000Z'),
    updatedAt: new Date('2026-08-24T00:00:00.000Z'),
    lastSuccessfulSyncAt: undefined,
    nextSyncAt: input.nextSyncAt,
    syncRetryCount: input.syncRetryCount ?? 0,
    syncLeaseUntil: input.syncLeaseUntil,
    lastSyncAttemptAt: input.lastSyncAttemptAt,
  };
}

test('claims each due active connection once and skips future, disconnected, and leased connections', async () => {
  const store = createMemoryStore();
  const now = new Date('2026-08-24T12:00:00.000Z');
  const leaseUntil = new Date('2026-08-24T12:15:00.000Z');
  const rows = [
    connection({ id: 'due', userId: 'due-user', status: 'active', nextSyncAt: now, syncLeaseUntil: undefined, lastSyncAttemptAt: undefined }),
    connection({ id: 'future', userId: 'future-user', status: 'active', nextSyncAt: new Date('2026-08-24T12:01:00.000Z'), syncLeaseUntil: undefined, lastSyncAttemptAt: undefined }),
    connection({ id: 'disconnected', userId: 'disconnected-user', status: 'disconnected', nextSyncAt: now, syncLeaseUntil: undefined, lastSyncAttemptAt: undefined }),
    connection({ id: 'leased', userId: 'leased-user', status: 'partial', nextSyncAt: now, syncLeaseUntil: new Date('2026-08-24T12:05:00.000Z'), lastSyncAttemptAt: undefined }),
  ];
  for (const row of rows) {
    await store.users.insert(row.userId);
    await store.connections.insert(row);
  }

  const schedule = store.connections as typeof store.connections & {
    claimDueSyncs(input: { now: Date; leaseUntil: Date; limit: number }): Promise<ScheduledConnection[]>;
  };
  const first = await schedule.claimDueSyncs({ now, leaseUntil, limit: 10 });
  const second = await schedule.claimDueSyncs({ now, leaseUntil, limit: 10 });

  assert.deepEqual(first.map((row) => row.userId), ['due-user']);
  assert.deepEqual(second, []);
  assert.equal((await store.connections.findByUserId('due-user') as ScheduledConnection | undefined)?.syncLeaseUntil?.toISOString(), leaseUntil.toISOString());
});

test('does not claim expired refresh tokens or connections without a token envelope', async () => {
  const store = createMemoryStore();
  const now = new Date('2026-08-24T12:00:00.000Z');
  const leaseUntil = new Date('2026-08-24T12:15:00.000Z');
  const rows = [
    connection({
      id: 'expired-token',
      userId: 'expired-user',
      status: 'active',
      nextSyncAt: now,
      refreshTokenExpiresAt: new Date('2026-08-24T11:59:00.000Z'),
    }),
    connection({
      id: 'no-token',
      userId: 'no-token-user',
      status: 'active',
      nextSyncAt: now,
      tokenEnvelopeCiphertext: undefined,
      tokenEnvelopeIv: undefined,
      tokenEnvelopeAuthTag: undefined,
    }),
    connection({ id: 'due', userId: 'due-user', status: 'active', nextSyncAt: now }),
  ];
  for (const row of rows) {
    await store.users.insert(row.userId);
    await store.connections.insert(row);
  }

  const claimed = await store.connections.claimDueSyncs({ now, leaseUntil, limit: 10 });
  assert.deepEqual(claimed.map((row) => row.userId), ['due-user']);
});

test('memory locked connection reads return the current row', async () => {
  const store = createMemoryStore();
  const now = new Date('2026-08-24T12:00:00.000Z');
  const row = connection({ id: 'locked', userId: 'locked-user', status: 'active', nextSyncAt: now });
  await store.users.insert(row.userId);
  await store.connections.insert(row);
  const lockedConnections = store.connections as typeof store.connections & {
    findByHealthUserIdForUpdate(healthUserId: string): Promise<ConnectionRow | undefined>;
    findByUserIdForUpdate(userId: string): Promise<ConnectionRow | undefined>;
  };

  const byUser = await lockedConnections.findByUserIdForUpdate(row.userId);
  const byHealth = await lockedConnections.findByHealthUserIdForUpdate(row.healthUserId);
  assert.equal(byUser?.id, row.id);
  assert.equal(byHealth?.id, row.id);
});

test('claim assigns an opaque lease token and rejects another run from finishing or releasing it', async () => {
  const store = createMemoryStore();
  const now = new Date('2026-08-24T12:00:00.000Z');
  const leaseUntil = new Date('2026-08-24T12:15:00.000Z');
  const row = connection({ id: 'due', userId: 'due-user', status: 'active', nextSyncAt: now });
  await store.users.insert(row.userId);
  await store.connections.insert(row);

  const [claimed] = await store.connections.claimDueSyncs({ now, leaseUntil, limit: 1 });
  const leaseToken = (claimed as ScheduledConnection & { syncLeaseToken?: string }).syncLeaseToken;
  assert.equal(typeof leaseToken, 'string');
  assert.ok(leaseToken && leaseToken.length > 0);

  const wrongToken = '00000000-0000-4000-8000-000000000000';
  const finished = await store.connections.finishScheduledSync({
    id: row.id,
    userId: row.userId,
    leaseUntil,
    leaseToken: wrongToken,
    now,
    nextSyncAt: new Date('2026-08-24T13:00:00.000Z'),
    syncRetryCount: 0,
    lastErrorCode: undefined,
  } as never);
  const cleared = await store.connections.clearSyncLeaseIfHeld({
    id: row.id,
    userId: row.userId,
    leaseUntil,
    leaseToken: wrongToken,
    now,
  } as never);
  const expired = await store.connections.expireIfSyncable({
    id: row.id,
    userId: row.userId,
    leaseUntil,
    leaseToken: wrongToken,
    now,
    lastErrorCode: 'expired',
    tokenEnvelopeCiphertext: row.tokenEnvelopeCiphertext,
  } as never);

  assert.equal(finished, false);
  assert.equal(cleared, false);
  assert.equal(expired, false);
  assert.equal((await store.connections.findByUserId(row.userId))?.syncLeaseUntil?.toISOString(), leaseUntil.toISOString());
});

test('reclaims an expired lease with a new token when the prior worker never finalized', async () => {
  const store = createMemoryStore();
  const startedAt = new Date('2026-08-24T12:00:00.000Z');
  const row = connection({ id: 'reclaim', userId: 'reclaim-user', status: 'active', nextSyncAt: startedAt });
  await store.users.insert(row.userId);
  await store.connections.insert(row);

  const [first] = await store.connections.claimDueSyncs({
    now: startedAt,
    leaseUntil: new Date('2026-08-24T12:15:00.000Z'),
    limit: 1,
  });
  const [second] = await store.connections.claimDueSyncs({
    now: new Date('2026-08-24T12:16:00.000Z'),
    leaseUntil: new Date('2026-08-24T12:31:00.000Z'),
    limit: 1,
  });

  assert.ok(first?.syncLeaseToken);
  assert.ok(second?.syncLeaseToken);
  assert.notEqual(second?.syncLeaseToken, first?.syncLeaseToken);
  assert.equal(second?.syncLeaseUntil?.toISOString(), '2026-08-24T12:31:00.000Z');
});

test('a taken-over token cannot enter the aggregate, cursor, or metric-result write scope', async () => {
  const store = createMemoryStore();
  const firstNow = new Date('2026-08-24T12:00:00.000Z');
  const row = connection({ id: 'takeover', userId: 'takeover-user', status: 'active', nextSyncAt: firstNow });
  await store.users.insert(row.userId);
  await store.connections.insert(row);
  const [first] = await store.connections.claimDueSyncs({
    now: firstNow,
    leaseUntil: new Date('2026-08-24T12:15:00.000Z'),
    limit: 1,
  });
  const takeoverNow = new Date('2026-08-24T12:16:00.000Z');
  const [second] = await store.connections.claimDueSyncs({
    now: takeoverNow,
    leaseUntil: new Date('2026-08-24T12:31:00.000Z'),
    limit: 1,
  });
  assert.ok(first?.syncLeaseToken);
  assert.ok(second?.syncLeaseToken);

  let aggregateWrite = false;
  let cursorWrite = false;
  let metricResultWrite = false;
  await assert.rejects(
    () => store.withScheduledSyncLease({
      connectionId: first!.id,
      userId: first!.userId,
      leaseToken: first!.syncLeaseToken!,
      leaseUntil: first!.syncLeaseUntil!,
      now: takeoverNow,
      deadlineAt: new Date('2026-08-24T12:29:00.000Z'),
    }, async (inner) => {
      aggregateWrite = true;
      await inner.healthMetrics.upsertMinutes([]);
      cursorWrite = true;
      await inner.healthMetrics.updateCursor({
        connectionId: first!.id,
        dataType: 'heart-rate',
        successfulWatermark: takeoverNow,
        lastErrorCode: undefined,
        retryCount: 0,
        nextAttemptAt: undefined,
      });
      await inner.healthMetrics.upsertMetricResult(parseMetricResult({
        userId: first!.userId,
        civilDate: '2026-08-24',
        metricName: 'strain',
        metricVersion: WHOOP_STYLE_METRIC_VERSION,
        score: 3,
        status: 'provisional',
        quality: null,
        reason: null,
        evidence: [],
        source: {
          heartRateZones: false,
          activityLevel: false,
          exercise: false,
          sleep: false,
          hrv: false,
          rhr: false,
          sleepGoal: false,
          timeZone: 'missing',
        },
        coverage: {
          knownContextMinutes: 0,
          rawHeartRateMinutes: 0,
          attributedMinutes: 0,
          lastKnownContextAt: null,
        },
      }));
      metricResultWrite = true;
    }),
    /sync lease no longer held/u,
  );
  assert.equal(aggregateWrite, false);
  assert.equal(cursorWrite, false);
  assert.equal(metricResultWrite, false);
  assert.deepEqual(await store.healthMetrics.listMetricResults({ userId: first!.userId, civilDate: '2026-08-24' }), []);

  const refreshed = await store.connections.updateAccessTokenIfSyncable({
    id: first!.id,
    userId: first!.userId,
    tokenEnvelopeCiphertext: Buffer.from('new-ciphertext'),
    tokenEnvelopeIv: Buffer.alloc(12),
    tokenEnvelopeAuthTag: Buffer.alloc(16),
    encryptionKeyVersion: 1,
    accessTokenExpiresAt: new Date('2026-08-24T13:00:00.000Z'),
    refreshTokenExpiresAt: undefined,
    updatedAt: takeoverNow,
    lease: {
      connectionId: first!.id,
      userId: first!.userId,
      leaseToken: first!.syncLeaseToken!,
      leaseUntil: first!.syncLeaseUntil!,
      now: takeoverNow,
      deadlineAt: new Date('2026-08-24T12:29:00.000Z'),
    },
  });
  const stamped = await store.connections.markLastSuccessfulSyncIfSyncable({
    id: first!.id,
    userId: first!.userId,
    syncedAt: takeoverNow,
    lease: {
      connectionId: first!.id,
      userId: first!.userId,
      leaseToken: first!.syncLeaseToken!,
      leaseUntil: first!.syncLeaseUntil!,
      now: takeoverNow,
      deadlineAt: new Date('2026-08-24T12:29:00.000Z'),
    },
  });
  const finished = await store.connections.finishScheduledSync({
    id: first!.id,
    userId: first!.userId,
    leaseUntil: first!.syncLeaseUntil!,
    leaseToken: first!.syncLeaseToken!,
    now: takeoverNow,
    nextSyncAt: new Date('2026-08-24T13:16:00.000Z'),
    syncRetryCount: 0,
    lastErrorCode: undefined,
    deadlineAt: new Date('2026-08-24T12:29:00.000Z'),
  });
  const failed = await store.connections.clearSyncLeaseIfHeld({
    id: first!.id,
    userId: first!.userId,
    leaseUntil: first!.syncLeaseUntil!,
    leaseToken: first!.syncLeaseToken!,
    now: takeoverNow,
  });
  assert.equal(refreshed, false);
  assert.equal(stamped, false);
  assert.equal(finished, false);
  assert.equal(failed, false);
  assert.equal((await store.connections.findByUserId(row.userId))?.syncLeaseToken, second!.syncLeaseToken);
});
