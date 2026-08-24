import type { AuthStore, ConnectionRow, OauthTransactionRow, SessionRow } from '../auth/types';

function cloneConnection(row: ConnectionRow): ConnectionRow {
  return {
    ...row,
    grantedScopes: [...row.grantedScopes],
    tokenEnvelopeCiphertext: row.tokenEnvelopeCiphertext ? Buffer.from(row.tokenEnvelopeCiphertext) : undefined,
    tokenEnvelopeIv: row.tokenEnvelopeIv ? Buffer.from(row.tokenEnvelopeIv) : undefined,
    tokenEnvelopeAuthTag: row.tokenEnvelopeAuthTag ? Buffer.from(row.tokenEnvelopeAuthTag) : undefined,
    accessTokenExpiresAt: row.accessTokenExpiresAt ? new Date(row.accessTokenExpiresAt) : undefined,
    refreshTokenExpiresAt: row.refreshTokenExpiresAt ? new Date(row.refreshTokenExpiresAt) : undefined,
    connectedAt: new Date(row.connectedAt),
    updatedAt: new Date(row.updatedAt),
  };
}

export function createMemoryStore(): AuthStore {
  const users = new Set<string>();
  const connections = new Map<string, ConnectionRow>();
  const sessions = new Map<string, SessionRow>();
  const transactions = new Map<string, OauthTransactionRow>();

  const store: AuthStore = {
    async withTransaction<T>(fn: (inner: AuthStore) => Promise<T>): Promise<T> {
      return fn(store);
    },
    users: {
      async insert(id: string): Promise<void> {
        users.add(id);
      },
    },
    connections: {
      async findByHealthUserId(healthUserId: string): Promise<ConnectionRow | undefined> {
        const row = [...connections.values()].find((item) => item.healthUserId === healthUserId);
        return row ? cloneConnection(row) : undefined;
      },
      async findByUserId(userId: string): Promise<ConnectionRow | undefined> {
        const row = [...connections.values()].find((item) => item.userId === userId);
        return row ? cloneConnection(row) : undefined;
      },
      async insert(row: ConnectionRow): Promise<void> {
        connections.set(row.id, cloneConnection(row));
      },
      async update(row: ConnectionRow): Promise<void> {
        connections.set(row.id, cloneConnection(row));
      },
    },
    sessions: {
      async insert(row: SessionRow): Promise<void> {
        sessions.set(row.tokenHash.toString('hex'), { ...row, tokenHash: Buffer.from(row.tokenHash) });
      },
      async findByTokenHash(tokenHash: Buffer): Promise<SessionRow | undefined> {
        const row = sessions.get(tokenHash.toString('hex'));
        return row ? { ...row, tokenHash: Buffer.from(row.tokenHash) } : undefined;
      },
      async deleteByTokenHash(tokenHash: Buffer): Promise<void> {
        sessions.delete(tokenHash.toString('hex'));
      },
      async deleteAllForUser(userId: string): Promise<void> {
        for (const [key, row] of sessions) {
          if (row.userId === userId) {
            sessions.delete(key);
          }
        }
      },
    },
    transactions: {
      async insert(row: OauthTransactionRow): Promise<void> {
        transactions.set(row.id, { ...row });
      },
      async findById(id: string): Promise<OauthTransactionRow | undefined> {
        const row = transactions.get(id);
        return row ? { ...row } : undefined;
      },
      async deleteById(id: string): Promise<void> {
        transactions.delete(id);
      },
      async deleteExpired(now: Date): Promise<void> {
        for (const [id, row] of transactions) {
          if (row.expiresAt.getTime() <= now.getTime()) {
            transactions.delete(id);
          }
        }
      },
    },
  };

  return store;
}
