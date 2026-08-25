import pg from 'pg';

import type { AccessTokenUpdate, AuthStore, ConnectionRow, DueSyncClaim, OauthTransactionRow, ScheduledSyncFinish, SessionRow } from '../auth/types';
import type { ConnectionStatus } from '../auth/scopes';

const pools = new Map<string, pg.Pool>();

function poolFor(databaseUrl: string): pg.Pool {
  const existing = pools.get(databaseUrl);
  if (existing) {
    return existing;
  }
  const created = new pg.Pool({ connectionString: databaseUrl });
  pools.set(databaseUrl, created);
  return created;
}

type Queryable = pg.Pool | pg.PoolClient;

function asBuffer(value: unknown): Buffer | undefined {
  if (!value) {
    return undefined;
  }
  return Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
}

function mapConnection(row: pg.QueryResult['rows'][number]): ConnectionRow {
  return {
    id: row.id,
    userId: row.user_id,
    healthUserId: row.health_user_id,
    legacyUserId: row.legacy_user_id ?? undefined,
    tokenEnvelopeCiphertext: asBuffer(row.token_envelope_ciphertext),
    tokenEnvelopeIv: asBuffer(row.token_envelope_iv),
    tokenEnvelopeAuthTag: asBuffer(row.token_envelope_auth_tag),
    encryptionKeyVersion: row.encryption_key_version ?? undefined,
    accessTokenExpiresAt: row.access_token_expires_at ?? undefined,
    refreshTokenExpiresAt: row.refresh_token_expires_at ?? undefined,
    grantedScopes: row.granted_scopes ?? [],
    status: row.status as ConnectionStatus,
    lastErrorCode: row.last_error_code ?? undefined,
    connectedAt: row.connected_at,
    updatedAt: row.updated_at,
    lastSuccessfulSyncAt: row.last_successful_sync_at ?? undefined,
    nextSyncAt: row.next_sync_at ?? undefined,
    syncRetryCount: row.sync_retry_count ?? 0,
    syncLeaseUntil: row.sync_lease_until ?? undefined,
    lastSyncAttemptAt: row.last_sync_attempt_at ?? undefined,
  };
}

function storeFor(queryable: Queryable): AuthStore {
  const connections = {
    async findByHealthUserId(healthUserId: string): Promise<ConnectionRow | undefined> {
      const result = await queryable.query('SELECT * FROM google_health_connections WHERE health_user_id = $1', [healthUserId]);
      return result.rows[0] ? mapConnection(result.rows[0]) : undefined;
    },
    async findByUserId(userId: string): Promise<ConnectionRow | undefined> {
      const result = await queryable.query('SELECT * FROM google_health_connections WHERE user_id = $1', [userId]);
      return result.rows[0] ? mapConnection(result.rows[0]) : undefined;
    },
    async insert(row: ConnectionRow): Promise<void> {
      await queryable.query(
        `INSERT INTO google_health_connections (
          id, user_id, health_user_id, legacy_user_id,
          token_envelope_ciphertext, token_envelope_iv, token_envelope_auth_tag, encryption_key_version,
          access_token_expires_at, refresh_token_expires_at, granted_scopes, status, last_error_code, connected_at, updated_at, last_successful_sync_at,
          next_sync_at, sync_retry_count, sync_lease_until, last_sync_attempt_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          row.id,
          row.userId,
          row.healthUserId,
          row.legacyUserId ?? null,
          row.tokenEnvelopeCiphertext ?? null,
          row.tokenEnvelopeIv ?? null,
          row.tokenEnvelopeAuthTag ?? null,
          row.encryptionKeyVersion ?? null,
          row.accessTokenExpiresAt ?? null,
          row.refreshTokenExpiresAt ?? null,
          row.grantedScopes,
          row.status,
          row.lastErrorCode ?? null,
          row.connectedAt,
          row.updatedAt,
          row.lastSuccessfulSyncAt ?? null,
          row.nextSyncAt ?? null,
          row.syncRetryCount ?? 0,
          row.syncLeaseUntil ?? null,
          row.lastSyncAttemptAt ?? null,
        ],
      );
    },
    async update(row: ConnectionRow): Promise<void> {
      await queryable.query(
        `UPDATE google_health_connections SET
          health_user_id = $2, legacy_user_id = $3,
          token_envelope_ciphertext = $4, token_envelope_iv = $5, token_envelope_auth_tag = $6, encryption_key_version = $7,
          access_token_expires_at = $8, refresh_token_expires_at = $9, granted_scopes = $10, status = $11, last_error_code = $12,
          connected_at = $13, updated_at = $14, last_successful_sync_at = $15,
          next_sync_at = $16, sync_retry_count = $17, sync_lease_until = $18, last_sync_attempt_at = $19
         WHERE id = $1`,
        [
          row.id,
          row.healthUserId,
          row.legacyUserId ?? null,
          row.tokenEnvelopeCiphertext ?? null,
          row.tokenEnvelopeIv ?? null,
          row.tokenEnvelopeAuthTag ?? null,
          row.encryptionKeyVersion ?? null,
          row.accessTokenExpiresAt ?? null,
          row.refreshTokenExpiresAt ?? null,
          row.grantedScopes,
          row.status,
          row.lastErrorCode ?? null,
          row.connectedAt,
          row.updatedAt,
          row.lastSuccessfulSyncAt ?? null,
          row.nextSyncAt ?? null,
          row.syncRetryCount ?? 0,
          row.syncLeaseUntil ?? null,
          row.lastSyncAttemptAt ?? null,
        ],
      );
    },
    async updateAccessTokenIfSyncable(input: AccessTokenUpdate): Promise<boolean> {
      const result = await queryable.query(
        `UPDATE google_health_connections SET
          token_envelope_ciphertext = $3, token_envelope_iv = $4, token_envelope_auth_tag = $5, encryption_key_version = $6,
          access_token_expires_at = $7, refresh_token_expires_at = COALESCE($8, refresh_token_expires_at), updated_at = $9
         WHERE id = $1 AND user_id = $2 AND status IN ('active', 'partial')`,
        [
          input.id,
          input.userId,
          input.tokenEnvelopeCiphertext,
          input.tokenEnvelopeIv,
          input.tokenEnvelopeAuthTag,
          input.encryptionKeyVersion,
          input.accessTokenExpiresAt,
          input.refreshTokenExpiresAt ?? null,
          input.updatedAt,
        ],
      );
      return result.rowCount === 1;
    },
    async claimDueSyncs(input: DueSyncClaim) {
      const values: unknown[] = [input.now, input.leaseUntil, input.limit];
      const userFilter = input.userId ? ` AND user_id = $${values.push(input.userId)}` : '';
      const result = await queryable.query(
        `WITH due AS (
           SELECT id
           FROM google_health_connections
           WHERE status IN ('active', 'partial')
             AND next_sync_at IS NOT NULL
             AND next_sync_at <= $1
             AND (sync_lease_until IS NULL OR sync_lease_until <= $1)
             ${userFilter}
           ORDER BY next_sync_at ASC, id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $3
         )
         UPDATE google_health_connections AS connection
         SET sync_lease_until = $2, last_sync_attempt_at = $1, updated_at = $1
         FROM due
         WHERE connection.id = due.id
         RETURNING connection.*`,
        values,
      );
      return result.rows.map(mapConnection);
    },
    async finishScheduledSync(input: ScheduledSyncFinish) {
      const result = await queryable.query(
        `UPDATE google_health_connections
         SET next_sync_at = $4, sync_retry_count = $5, sync_lease_until = NULL, last_error_code = $6, updated_at = $7
         WHERE id = $1
           AND user_id = $2
           AND status IN ('active', 'partial')
           AND sync_lease_until = $3`,
        [
          input.id,
          input.userId,
          input.leaseUntil,
          input.nextSyncAt,
          input.syncRetryCount,
          input.lastErrorCode ?? null,
          input.now,
        ],
      );
      return result.rowCount === 1;
    },
  };

  const store: AuthStore = {
    async withTransaction<T>(fn: (inner: AuthStore) => Promise<T>): Promise<T> {
      const pool = queryable instanceof pg.Pool ? queryable : undefined;
      if (!pool) {
        return fn(store);
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(storeFor(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    users: {
      async insert(id: string): Promise<void> {
        await queryable.query('INSERT INTO users (id) VALUES ($1)', [id]);
      },
    },
    connections,
    sessions: {
      async insert(row: SessionRow): Promise<void> {
        await queryable.query(
          `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [row.id, row.userId, row.tokenHash, row.expiresAt, row.createdAt, row.lastSeenAt],
        );
      },
      async findByTokenHash(tokenHash: Buffer): Promise<SessionRow | undefined> {
        const result = await queryable.query('SELECT * FROM sessions WHERE token_hash = $1', [tokenHash]);
        const row = result.rows[0];
        if (!row) {
          return undefined;
        }
        return {
          id: row.id,
          userId: row.user_id,
          tokenHash: asBuffer(row.token_hash) ?? tokenHash,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
          lastSeenAt: row.last_seen_at,
        };
      },
      async deleteByTokenHash(tokenHash: Buffer): Promise<void> {
        await queryable.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
      },
      async deleteAllForUser(userId: string): Promise<void> {
        await queryable.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
      },
    },
    healthSnapshots: {
      async deleteForUser(userId: string): Promise<void> {
        await queryable.query('DELETE FROM health_snapshots WHERE user_id = $1', [userId]);
      },
    },
    transactions: {
      async insert(row: OauthTransactionRow): Promise<void> {
        await queryable.query(
          `INSERT INTO oauth_transactions (
            id, state_hash, pkce_verifier_ciphertext, pkce_verifier_iv, pkce_verifier_auth_tag, pkce_key_version, initiating_user_id, expires_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            row.id,
            row.stateHash,
            row.pkceVerifierCiphertext,
            row.pkceVerifierIv,
            row.pkceVerifierAuthTag,
            row.pkceKeyVersion,
            row.initiatingUserId ?? null,
            row.expiresAt,
          ],
        );
      },
      async findById(id: string): Promise<OauthTransactionRow | undefined> {
        const result = await queryable.query('SELECT * FROM oauth_transactions WHERE id = $1', [id]);
        const row = result.rows[0];
        if (!row) {
          return undefined;
        }
        return {
          id: row.id,
          stateHash: asBuffer(row.state_hash) ?? Buffer.alloc(0),
          pkceVerifierCiphertext: asBuffer(row.pkce_verifier_ciphertext) ?? Buffer.alloc(0),
          pkceVerifierIv: asBuffer(row.pkce_verifier_iv) ?? Buffer.alloc(0),
          pkceVerifierAuthTag: asBuffer(row.pkce_verifier_auth_tag) ?? Buffer.alloc(0),
          pkceKeyVersion: row.pkce_key_version,
          initiatingUserId: row.initiating_user_id ?? undefined,
          expiresAt: row.expires_at,
        };
      },
      async deleteById(id: string): Promise<void> {
        await queryable.query('DELETE FROM oauth_transactions WHERE id = $1', [id]);
      },
      async deleteExpired(now: Date): Promise<void> {
        await queryable.query('DELETE FROM oauth_transactions WHERE expires_at <= $1', [now]);
      },
    },
  };

  return store;
}

export function getPostgresStore(databaseUrl: string): AuthStore {
  return storeFor(poolFor(databaseUrl));
}

export function getPool(databaseUrl: string): pg.Pool {
  return poolFor(databaseUrl);
}

const migrated = new Set<string>();

export async function ensurePostgresReady(databaseUrl: string): Promise<AuthStore> {
  if (migrated.has(databaseUrl)) {
    return getPostgresStore(databaseUrl);
  }
  const { migrate } = await import('./migrate');
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await migrate(databaseUrl);
      migrated.add(databaseUrl);
      return getPostgresStore(databaseUrl);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}
