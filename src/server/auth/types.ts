import type { VisionMeal } from '../../domain/meal-vision';
import type { ConfirmMealInput, ConfirmMealResult, CurrentMealStore, MealDraftRow, MealIngredientRow, MealNutrientRow, MealSyncGenerationRow, MealSyncPointRow, MealSyncPointStatus, MealType, MealVersionRow, OutboxRow } from '../meals/types';
import type { LocalTwFdaFood } from '../nutrition/tw-fda';
import type { ConnectionStatus } from './scopes';

export type TokenEnvelopeFields = {
  tokenEnvelopeCiphertext: Buffer | undefined;
  tokenEnvelopeIv: Buffer | undefined;
  tokenEnvelopeAuthTag: Buffer | undefined;
  encryptionKeyVersion: number | undefined;
};

export type ConnectionRow = TokenEnvelopeFields & {
  id: string;
  userId: string;
  healthUserId: string;
  legacyUserId: string | undefined;
  accessTokenExpiresAt: Date | undefined;
  refreshTokenExpiresAt: Date | undefined;
  grantedScopes: string[];
  status: ConnectionStatus;
  lastErrorCode: string | undefined;
  connectedAt: Date;
  updatedAt: Date;
  lastSuccessfulSyncAt: Date | undefined;
  nextSyncAt?: Date | undefined;
  syncRetryCount?: number;
  syncLeaseUntil?: Date | undefined;
  lastSyncAttemptAt?: Date | undefined;
};

export type ScheduledSyncFinish = {
  id: string;
  userId: string;
  leaseUntil: Date;
  now: Date;
  nextSyncAt: Date;
  syncRetryCount: number;
  lastErrorCode: string | undefined;
};

export type DueSyncClaim = {
  now: Date;
  leaseUntil: Date;
  limit: number;
  userId?: string;
};

export type AccessTokenUpdate = {
  id: string;
  userId: string;
  tokenEnvelopeCiphertext: Buffer;
  tokenEnvelopeIv: Buffer;
  tokenEnvelopeAuthTag: Buffer;
  encryptionKeyVersion: number;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date | undefined;
  updatedAt: Date;
};

export type LastSuccessfulSyncUpdate = {
  id: string;
  userId: string;
  syncedAt: Date;
};

export type ConnectionExpire = {
  id: string;
  userId: string;
  now: Date;
  lastErrorCode: string;
  leaseUntil: Date;
  tokenEnvelopeCiphertext: Buffer | undefined;
};

export type SyncLeaseRelease = {
  id: string;
  userId: string;
  leaseUntil: Date;
  now: Date;
};

export type NutritionOutboxClaim = {
  now: Date;
  leaseUntil: Date;
  limit: number;
};

export type NutritionOutboxLease = {
  id: string;
  userId: string;
  leaseUntil: Date;
  now: Date;
};

export type MealSyncPointClaim = {
  now: Date;
  leaseUntil: Date;
  limit: number;
};

export type MealSyncPointLease = {
  id: string;
  generationId: string;
  userId: string;
  leaseUntil: Date;
  now: Date;
};

export type MealSyncGenerationState = {
  generation: MealSyncGenerationRow;
  pointStatusCounts: Partial<Record<MealSyncPointStatus, number>>;
  hasUnknownPoint: boolean;
  recoveryRequestedAt: Date | undefined;
};

/** Future sync-worker persistence contract. It deliberately does not surface any UI view. */
export type MealSyncStore = {
  startGeneration(input: { mealId: string; userId: string; now: Date }): Promise<MealSyncGenerationRow | undefined>;
  beginRecovery(input: { mealId: string; userId: string; now: Date; reason: string }): Promise<MealSyncGenerationRow | undefined>;
  claimDuePoints(input: MealSyncPointClaim): Promise<MealSyncPointRow[]>;
  finishPoint(input: MealSyncPointLease): Promise<boolean>;
  retryPoint(input: MealSyncPointLease & { nextAttemptAt: Date; errorCode: string }): Promise<boolean>;
  markPointUnknown(input: MealSyncPointLease & { errorCode: string }): Promise<boolean>;
  markPointFailedActionRequired(input: MealSyncPointLease & { errorCode: string }): Promise<boolean>;
  markPointOperationPending(input: MealSyncPointLease & { operationName: string; nextAttemptAt: Date }): Promise<boolean>;
  requestUnknownRecovery(input: { generationId: string; pointId: string; userId: string; now: Date }): Promise<boolean>;
  readGenerationState(input: { mealId: string; userId: string }): Promise<MealSyncGenerationState | undefined>;
};

export type SessionRow = {
  id: string;
  userId: string;
  tokenHash: Buffer;
  expiresAt: Date;
  createdAt: Date;
  lastSeenAt: Date;
};

export type OauthTransactionRow = {
  id: string;
  stateHash: Buffer;
  pkceVerifierCiphertext: Buffer;
  pkceVerifierIv: Buffer;
  pkceVerifierAuthTag: Buffer;
  pkceKeyVersion: number;
  initiatingUserId: string | undefined;
  expiresAt: Date;
};

export type AuthStore = {
  withTransaction<T>(fn: (store: AuthStore) => Promise<T>): Promise<T>;
  users: {
    insert(id: string): Promise<void>;
    setNutritionWritebackEnabled(id: string, enabled: boolean): Promise<void>;
    nutritionWritebackEnabled(id: string): Promise<boolean>;
  };
  meals: {
    insertDraft(input: { userId: string; mealType: MealType; eatenAt: Date; vision: VisionMeal; now: Date }): Promise<MealDraftRow>;
    findDraft(userId: string, id: string): Promise<MealDraftRow | undefined>;
    confirmDraft(input: ConfirmMealInput): Promise<ConfirmMealResult>;
    listVersions(userId: string): Promise<MealVersionRow[]>;
    listIngredients(userId: string, versionId: string): Promise<MealIngredientRow[]>;
    listNutrients(userId: string, versionId: string): Promise<MealNutrientRow[]>;
  };
  currentMeals: CurrentMealStore;
  mealSync?: MealSyncStore;
  connections: {
    findByHealthUserId(healthUserId: string): Promise<ConnectionRow | undefined>;
    findByUserId(userId: string): Promise<ConnectionRow | undefined>;
    insert(row: ConnectionRow): Promise<void>;
    update(row: ConnectionRow): Promise<void>;
    updateAccessTokenIfSyncable(input: AccessTokenUpdate): Promise<boolean>;
    markLastSuccessfulSyncIfSyncable(input: LastSuccessfulSyncUpdate): Promise<boolean>;
    claimDueSyncs(input: DueSyncClaim): Promise<ConnectionRow[]>;
    finishScheduledSync(input: ScheduledSyncFinish): Promise<boolean>;
    expireIfSyncable(input: ConnectionExpire): Promise<boolean>;
    clearSyncLeaseIfHeld(input: SyncLeaseRelease): Promise<boolean>;
  };
  sessions: {
    insert(row: SessionRow): Promise<void>;
    findByTokenHash(tokenHash: Buffer): Promise<SessionRow | undefined>;
    deleteByTokenHash(tokenHash: Buffer): Promise<void>;
    deleteAllForUser(userId: string): Promise<void>;
  };
  healthSnapshots: {
    deleteForUser(userId: string): Promise<void>;
  };
  foodComposition: {
    findExactFood(nameZh: string): Promise<LocalTwFdaFood | undefined>;
  };
  nutritionOutbox: {
    claimDue(input: NutritionOutboxClaim): Promise<OutboxRow[]>;
    markSynced(input: NutritionOutboxLease): Promise<boolean>;
    markRetrying(input: NutritionOutboxLease & { nextAttemptAt: Date; errorCode: string }): Promise<boolean>;
    markFailedActionRequired(input: NutritionOutboxLease & { errorCode: string }): Promise<boolean>;
    markUnknown(input: NutritionOutboxLease & { errorCode: string }): Promise<boolean>;
    markOperationPending(input: NutritionOutboxLease & { operationName: string; nextAttemptAt: Date }): Promise<boolean>;
  };
  transactions: {
    insert(row: OauthTransactionRow): Promise<void>;
    findById(id: string): Promise<OauthTransactionRow | undefined>;
    deleteById(id: string): Promise<void>;
    deleteExpired(now: Date): Promise<void>;
  };
};

export type GoogleTokenResponse = {
  accessToken: string;
  refreshToken: string | undefined;
  expiresAt: Date;
  refreshExpiresAt: Date | undefined;
  grantedScopes: string[];
};

export type GoogleIdentity = {
  healthUserId: string;
  legacyUserId: string | undefined;
};

export type GoogleOAuthClient = {
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<GoogleTokenResponse>;
  getIdentity(accessToken: string): Promise<GoogleIdentity>;
  revoke(token: string): Promise<void>;
};

export const AUTH_ERROR_CODES = [
  'not_configured',
  'access_denied',
  'invalid_state',
  'transaction_expired',
  'missing_refresh_token',
  'identity_mismatch',
  'identity_unavailable',
  'token_exchange_failed',
  'origin_rejected',
  'unauthorized',
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];
