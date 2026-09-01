import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createPostgresStoreForTesting, type PostgresQueryable } from '../../src/server/db/postgres-store';
import * as snapshots from '../../src/server/health/snapshot-store';
import { emptyUserHealthRecords } from '../../src/server/health/provider';

type Query = { text: string; values: unknown[] | undefined };

class RecordingQueryable implements PostgresQueryable {
  readonly queries: Query[] = [];

  constructor(private readonly rowCount = 0) {}

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text, values });
    return { rows: [], rowCount: this.rowCount };
  }
}

const connectionId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const oldLeaseToken = '44444444-4444-4444-8444-444444444444';
const now = new Date('2026-08-24T12:00:00.000Z');
const leaseUntil = new Date('2026-08-24T12:15:00.000Z');

test('migration adds a nullable token for each scheduled-sync lease', () => {
  const migration = readFileSync(new URL('../../db/migrations/011_sync_lease_fencing.sql', import.meta.url), 'utf8');
  assert.match(migration, /ADD COLUMN sync_lease_token UUID/u);
});

test('Postgres token refresh update is one atomic lease-fenced statement', async () => {
  const queryable = new RecordingQueryable(0);
  const store = createPostgresStoreForTesting(queryable);
  const updated = await store.connections.updateAccessTokenIfSyncable({
    id: connectionId,
    userId,
    tokenEnvelopeCiphertext: Buffer.from('ciphertext'),
    tokenEnvelopeIv: Buffer.alloc(12),
    tokenEnvelopeAuthTag: Buffer.alloc(16),
    encryptionKeyVersion: 1,
    accessTokenExpiresAt: now,
    refreshTokenExpiresAt: undefined,
    updatedAt: now,
    lease: { connectionId, userId, leaseToken: oldLeaseToken, leaseUntil, now },
  } as never);

  assert.equal(updated, false);
  assert.equal(queryable.queries.length, 1);
  const query = queryable.queries[0]!;
  assert.match(query.text, /sync_lease_token/u);
  assert.match(query.text, /sync_lease_until > now\(\)/u);
  assert.ok(query.values?.includes(connectionId));
  assert.ok(query.values?.includes(userId));
  assert.ok(query.values?.includes(oldLeaseToken));
  assert.ok(query.values?.some((value) => value instanceof Date && value.getTime() === leaseUntil.getTime()));
});

test('Postgres success watermark update is one atomic lease-fenced statement', async () => {
  const queryable = new RecordingQueryable(0);
  const store = createPostgresStoreForTesting(queryable);
  const stamped = await store.connections.markLastSuccessfulSyncIfSyncable({
    id: connectionId,
    userId,
    syncedAt: now,
    lease: { connectionId, userId, leaseToken: oldLeaseToken, leaseUntil, now },
  } as never);

  assert.equal(stamped, false);
  const query = queryable.queries[0]!;
  assert.match(query.text, /sync_lease_token/u);
  assert.match(query.text, /sync_lease_until > now\(\)/u);
  assert.ok(query.values?.includes(oldLeaseToken));
});

test('snapshot persistence atomically rejects a superseded token', async () => {
  const queryable = new RecordingQueryable(0);
  const saveWithQueryable = (snapshots as Record<string, unknown>).saveHealthSnapshotForTesting as
    | ((input: Record<string, unknown>) => Promise<void>)
    | undefined;
  assert.ok(saveWithQueryable, 'snapshot test seam must exist');
  await assert.rejects(
    () => saveWithQueryable!({
      queryable,
      userId,
      records: emptyUserHealthRecords(),
      syncedAt: now,
      lease: { connectionId, userId, leaseToken: oldLeaseToken, leaseUntil, now },
    }),
    /connection no longer syncable|sync lease no longer held/u,
  );
  assert.equal(queryable.queries.length, 1);
  const query = queryable.queries[0]!;
  assert.match(query.text, /INSERT INTO health_snapshots/u);
  assert.match(query.text, /sync_lease_token/u);
  assert.match(query.text, /sync_lease_until > now\(\)/u);
  assert.ok(query.values?.includes(connectionId));
  assert.ok(query.values?.includes(userId));
  assert.ok(query.values?.includes(oldLeaseToken));
});
