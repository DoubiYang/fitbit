import assert from 'node:assert/strict';
import test from 'node:test';

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
