import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parseDailyCardio, parseMetricResult } from '../../src/domain/cardio-records';
import { WHOOP_STYLE_METRIC_VERSION } from '../../src/domain/metric-types';
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

class LeaseAwareSnapshotQueryable implements PostgresQueryable {
  readonly queries: Query[] = [];

  constructor(private activeLeaseToken: string) {}

  takeOver(leaseToken: string): void {
    this.activeLeaseToken = leaseToken;
  }

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text, values });
    return { rows: [], rowCount: values?.[8] === this.activeLeaseToken ? 1 : 0 };
  }
}

class DeadlineRaceQueryable implements PostgresQueryable {
  readonly queries: Query[] = [];

  constructor(private readonly expiredDeadlineAt: Date) {}

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text, values });
    const failureFinish = text.includes('UPDATE google_health_connections') && values?.[6] === 'sync_failed';
    const hasDeadlinePredicate = /(?:now|clock_timestamp)\(\) < \$\d+/u.test(text) && values?.includes(this.expiredDeadlineAt);
    return { rows: [], rowCount: failureFinish || !hasDeadlinePredicate ? 1 : 0 };
  }
}

class DeadlineTransactionPool implements PostgresQueryable {
  readonly queries: Query[] = [];
  private guardChecks = 0;
  readonly client = {
    query: async (text: string, values?: unknown[]) => this.query(text, values),
    release: () => undefined,
  };

  async connect() {
    return this.client;
  }

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text, values });
    if (text.includes('FROM google_health_connections') && text.includes('FOR UPDATE')) {
      this.guardChecks += 1;
      return { rows: [], rowCount: this.guardChecks === 1 ? 1 : 0 };
    }
    return { rows: [], rowCount: 1 };
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

test('Postgres connection rereads use row locks inside OAuth transactions', async () => {
  const queryable = new RecordingQueryable(0);
  const store = createPostgresStoreForTesting(queryable);
  const lockedConnections = store.connections as typeof store.connections & {
    findByHealthUserIdForUpdate(healthUserId: string): Promise<undefined>;
    findByUserIdForUpdate(userId: string): Promise<undefined>;
  };

  await lockedConnections.findByUserIdForUpdate(userId);
  await lockedConnections.findByHealthUserIdForUpdate('health-1');

  assert.match(queryable.queries[0]?.text ?? '', /WHERE user_id = \$1\s+FOR UPDATE/u);
  assert.match(queryable.queries[1]?.text ?? '', /WHERE health_user_id = \$1\s+FOR UPDATE/u);
});

test('snapshot persistence atomically rejects a superseded token', async () => {
  const queryable = new LeaseAwareSnapshotQueryable(oldLeaseToken);
  queryable.takeOver('55555555-5555-4555-8555-555555555555');
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

test('a database deadline atomically rejects scheduled success writes but not the failure retry', async () => {
  const deadlineAt = new Date('2026-08-24T11:59:00.000Z');
  const lease = { connectionId, userId, leaseToken: oldLeaseToken, leaseUntil, now, deadlineAt };
  const queryable = new DeadlineRaceQueryable(deadlineAt);
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
    lease,
  } as never);
  assert.equal(updated, false);
  const stamped = await store.connections.markLastSuccessfulSyncIfSyncable({
    id: connectionId,
    userId,
    syncedAt: now,
    lease,
  } as never);
  assert.equal(stamped, false);
  let leaseBodyRan = false;
  await assert.rejects(
    () => store.withScheduledSyncLease(lease as never, async () => {
      leaseBodyRan = true;
    }),
    /sync lease no longer held/u,
  );
  assert.equal(leaseBodyRan, false);
  const saveWithQueryable = (snapshots as Record<string, unknown>).saveHealthSnapshotForTesting as
    | ((input: Record<string, unknown>) => Promise<void>)
    | undefined;
  assert.ok(saveWithQueryable, 'snapshot test seam must exist');
  await assert.rejects(
    () => saveWithQueryable!({ queryable, userId, records: emptyUserHealthRecords(), syncedAt: now, lease }),
    /sync lease no longer held/u,
  );
  const success = await store.connections.finishScheduledSync({
    id: connectionId,
    userId,
    leaseUntil,
    leaseToken: oldLeaseToken,
    now,
    nextSyncAt: new Date('2026-08-24T13:00:00.000Z'),
    syncRetryCount: 0,
    lastErrorCode: undefined,
    deadlineAt,
  } as never);
  assert.equal(success, false);
  const failure = await store.connections.finishScheduledSync({
    id: connectionId,
    userId,
    leaseUntil,
    leaseToken: oldLeaseToken,
    now,
    nextSyncAt: new Date('2026-08-24T12:30:00.000Z'),
    syncRetryCount: 1,
    lastErrorCode: 'sync_failed',
    deadlineAt,
  } as never);
  assert.equal(failure, true);
});

test('Postgres scheduled finish preserves a callback schedule for both success and failure', async () => {
  const deadlineAt = new Date('2026-08-24T12:13:00.000Z');
  const queryable = new RecordingQueryable(1);
  const store = createPostgresStoreForTesting(queryable);
  for (const [nextSyncAt, syncRetryCount, lastErrorCode] of [
    [new Date('2026-08-24T13:00:00.000Z'), 0, undefined],
    [new Date('2026-08-24T12:30:00.000Z'), 1, 'sync_failed'],
  ] as const) {
    const finished = await store.connections.finishScheduledSync({
      id: connectionId,
      userId,
      leaseUntil,
      leaseToken: oldLeaseToken,
      now,
      nextSyncAt,
      syncRetryCount,
      lastErrorCode,
      deadlineAt,
    } as never);
    assert.equal(finished, true);
  }

  assert.equal(queryable.queries.length, 2);
  for (const query of queryable.queries) {
    assert.match(query.text, /WHEN next_sync_at IS NOT NULL\s+THEN next_sync_at/u);
    assert.match(query.text, /WHEN next_sync_at IS NOT NULL\s+THEN sync_retry_count/u);
    assert.match(query.text, /WHEN next_sync_at IS NOT NULL\s+THEN last_error_code/u);
    assert.doesNotMatch(query.text, /next_sync_at IS NOT NULL AND next_sync_at <=/u);
  }
});

test('a scheduled transaction rolls back writes when its post-write real-time deadline guard fails', async () => {
  const deadlineAt = new Date('2026-08-24T12:13:00.000Z');
  const lease = { connectionId, userId, leaseToken: oldLeaseToken, leaseUntil, now, deadlineAt };
  const pool = new DeadlineTransactionPool();
  const store = createPostgresStoreForTesting(pool);

  await assert.rejects(
    () => store.withScheduledSyncLease(lease, async (inner) => {
      await inner.healthMetrics.upsertDailyCardio(parseDailyCardio({
        userId,
        date: '2026-08-24',
        status: 'provisional',
        strain: 3,
        dose: 10,
        zoneMinutes: { light: 10, moderate: 0, vigorous: 0, peak: 0 },
        knownContextMinutes: 10,
        rawCoverageMinutes: 10,
        attributedMinutes: 10,
        metricVersion: WHOOP_STYLE_METRIC_VERSION,
      }));
      await inner.healthMetrics.upsertMetricResult(parseMetricResult({
        userId,
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
      await inner.healthMetrics.updateCursor({
        connectionId,
        dataType: 'heart-rate',
        successfulWatermark: now,
        lastErrorCode: undefined,
        retryCount: 0,
        nextAttemptAt: new Date('2026-08-24T13:00:00.000Z'),
      });
    }),
    /sync lease no longer held/u,
  );

  const guards = pool.queries.filter((query) => query.text.includes('FROM google_health_connections') && query.text.includes('FOR UPDATE'));
  assert.equal(guards.length, 2);
  assert.ok(guards.every((query) => query.text.includes('clock_timestamp()')));
  assert.equal(pool.queries.some((query) => query.text.includes('INSERT INTO daily_cardio')), true);
  assert.equal(pool.queries.some((query) => query.text.includes('INSERT INTO metric_results')), true);
  assert.equal(pool.queries.some((query) => query.text.includes('INSERT INTO health_sync_cursors')), true);
  assert.equal(pool.queries.at(-1)?.text, 'ROLLBACK');
  assert.equal(pool.queries.some((query) => query.text === 'COMMIT'), false);
});
