import { randomUUID } from 'node:crypto';

import type { AuthStore, ConnectionRow, OauthTransactionRow, SessionRow } from '../auth/types';
import { confirmDraftRows } from '../meals/confirm-draft';
import type { MealDraftRow, MealVersionRow } from '../meals/types';

export type MemoryStore = AuthStore & {
  deletedHealthSnapshotUserIds: string[];
};

function envelopesEqual(left: Buffer | undefined, right: Buffer | undefined): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.equals(right);
}

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
    lastSuccessfulSyncAt: row.lastSuccessfulSyncAt ? new Date(row.lastSuccessfulSyncAt) : undefined,
    nextSyncAt: row.nextSyncAt ? new Date(row.nextSyncAt) : undefined,
    syncLeaseUntil: row.syncLeaseUntil ? new Date(row.syncLeaseUntil) : undefined,
    lastSyncAttemptAt: row.lastSyncAttemptAt ? new Date(row.lastSyncAttemptAt) : undefined,
  };
}

export function createMemoryStore(): MemoryStore {
  const users = new Set<string>();
  const writebackEnabled = new Map<string, boolean>();
  const drafts = new Map<string, MealDraftRow>();
  const versions: MealVersionRow[] = [];
  const connections = new Map<string, ConnectionRow>();
  const sessions = new Map<string, SessionRow>();
  const transactions = new Map<string, OauthTransactionRow>();
  const deletedHealthSnapshotUserIds: string[] = [];

  const store: AuthStore = {
    async withTransaction<T>(fn: (inner: AuthStore) => Promise<T>): Promise<T> {
      return fn(store);
    },
    users: {
      async insert(id: string): Promise<void> {
        users.add(id);
      },
      async setNutritionWritebackEnabled(id: string, enabled: boolean): Promise<void> {
        writebackEnabled.set(id, enabled);
      },
      async nutritionWritebackEnabled(id: string): Promise<boolean> {
        return writebackEnabled.get(id) === true;
      },
    },
    meals: {
      async insertDraft(input): Promise<MealDraftRow> {
        const row: MealDraftRow = {
          id: randomUUID(),
          userId: input.userId,
          mealType: input.mealType,
          eatenAt: new Date(input.eatenAt),
          vision: structuredClone(input.vision),
          createdAt: input.now,
          updatedAt: input.now,
        };
        drafts.set(row.id, row);
        return structuredClone(row);
      },
      async findDraft(userId, id): Promise<MealDraftRow | undefined> {
        const row = drafts.get(id);
        if (!row || row.userId !== userId) {
          return undefined;
        }
        return structuredClone(row);
      },
      async confirmDraft(input) {
        const draft = drafts.get(input.draftId);
        if (!draft || draft.userId !== input.userId) {
          return { ok: false as const, reason: '草稿不存在' };
        }
        const enabled = writebackEnabled.get(input.userId) === true;
        const result = confirmDraftRows(draft, input, enabled);
        if (!result.ok) {
          return result;
        }
        versions.push(result.version);
        drafts.delete(draft.id);
        return result;
      },
      async listVersions(userId): Promise<MealVersionRow[]> {
        return versions.filter((row) => row.userId === userId).map((row) => ({ ...row }));
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
      async updateAccessTokenIfSyncable(input): Promise<boolean> {
        const current = connections.get(input.id);
        if (!current || current.userId !== input.userId || (current.status !== 'active' && current.status !== 'partial')) {
          return false;
        }
        connections.set(
          current.id,
          cloneConnection({
            ...current,
            tokenEnvelopeCiphertext: input.tokenEnvelopeCiphertext,
            tokenEnvelopeIv: input.tokenEnvelopeIv,
            tokenEnvelopeAuthTag: input.tokenEnvelopeAuthTag,
            encryptionKeyVersion: input.encryptionKeyVersion,
            accessTokenExpiresAt: input.accessTokenExpiresAt,
            refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? current.refreshTokenExpiresAt,
            updatedAt: input.updatedAt,
          }),
        );
        return true;
      },
      async markLastSuccessfulSyncIfSyncable(input): Promise<boolean> {
        const current = connections.get(input.id);
        if (!current || current.userId !== input.userId || (current.status !== 'active' && current.status !== 'partial')) {
          return false;
        }
        connections.set(
          current.id,
          cloneConnection({
            ...current,
            lastSuccessfulSyncAt: input.syncedAt,
            updatedAt: input.syncedAt,
          }),
        );
        return true;
      },
      async claimDueSyncs(input) {
        const due = [...connections.values()]
          .filter(
            (row) =>
              (row.status === 'active' || row.status === 'partial') &&
              (!input.userId || row.userId === input.userId) &&
              Boolean(row.tokenEnvelopeCiphertext) &&
              (!row.refreshTokenExpiresAt || row.refreshTokenExpiresAt.getTime() > input.now.getTime()) &&
              row.nextSyncAt &&
              row.nextSyncAt.getTime() <= input.now.getTime() &&
              (!row.syncLeaseUntil || row.syncLeaseUntil.getTime() <= input.now.getTime()),
          )
          .sort((left, right) => {
            const byDue = left.nextSyncAt!.getTime() - right.nextSyncAt!.getTime();
            return byDue || left.id.localeCompare(right.id);
          })
          .slice(0, input.limit);
        for (const row of due) {
          connections.set(
            row.id,
            cloneConnection({
              ...row,
              syncLeaseUntil: input.leaseUntil,
              lastSyncAttemptAt: input.now,
              updatedAt: input.now,
              nextSyncAt: undefined,
            }),
          );
        }
        return due.map((row) =>
          cloneConnection({
            ...row,
            syncLeaseUntil: input.leaseUntil,
            lastSyncAttemptAt: input.now,
            updatedAt: input.now,
            nextSyncAt: undefined,
          }),
        );
      },
      async finishScheduledSync(input): Promise<boolean> {
        const current = connections.get(input.id);
        if (
          !current ||
          current.userId !== input.userId ||
          (current.status !== 'active' && current.status !== 'partial') ||
          !current.syncLeaseUntil ||
          current.syncLeaseUntil.getTime() !== input.leaseUntil.getTime()
        ) {
          return false;
        }
        const keepDue = current.nextSyncAt && current.nextSyncAt.getTime() <= input.now.getTime();
        connections.set(
          current.id,
          cloneConnection({
            ...current,
            nextSyncAt: keepDue ? current.nextSyncAt : input.nextSyncAt,
            syncRetryCount: keepDue ? current.syncRetryCount : input.syncRetryCount,
            syncLeaseUntil: undefined,
            lastErrorCode: keepDue ? current.lastErrorCode : input.lastErrorCode,
            updatedAt: input.now,
          }),
        );
        return true;
      },
      async expireIfSyncable(input): Promise<boolean> {
        const current = connections.get(input.id);
        if (
          !current ||
          current.userId !== input.userId ||
          (current.status !== 'active' && current.status !== 'partial') ||
          !current.syncLeaseUntil ||
          current.syncLeaseUntil.getTime() !== input.leaseUntil.getTime() ||
          !envelopesEqual(current.tokenEnvelopeCiphertext, input.tokenEnvelopeCiphertext)
        ) {
          return false;
        }
        connections.set(
          current.id,
          cloneConnection({
            ...current,
            status: 'expired',
            nextSyncAt: undefined,
            syncRetryCount: 0,
            syncLeaseUntil: undefined,
            lastErrorCode: input.lastErrorCode,
            updatedAt: input.now,
          }),
        );
        return true;
      },
      async clearSyncLeaseIfHeld(input): Promise<boolean> {
        const current = connections.get(input.id);
        if (
          !current ||
          current.userId !== input.userId ||
          !current.syncLeaseUntil ||
          current.syncLeaseUntil.getTime() !== input.leaseUntil.getTime()
        ) {
          return false;
        }
        connections.set(current.id, cloneConnection({ ...current, syncLeaseUntil: undefined, updatedAt: input.now }));
        return true;
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
    healthSnapshots: {
      async deleteForUser(userId: string): Promise<void> {
        deletedHealthSnapshotUserIds.push(userId);
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

  return Object.assign(store, { deletedHealthSnapshotUserIds });
}
