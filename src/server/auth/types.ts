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
  };
  connections: {
    findByHealthUserId(healthUserId: string): Promise<ConnectionRow | undefined>;
    findByUserId(userId: string): Promise<ConnectionRow | undefined>;
    insert(row: ConnectionRow): Promise<void>;
    update(row: ConnectionRow): Promise<void>;
    updateAccessTokenIfSyncable(input: AccessTokenUpdate): Promise<boolean>;
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
