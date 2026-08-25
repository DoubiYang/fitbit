import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type { OAuthConfig } from '../config/env';
import { redirectUri } from '../config/env';
import {
  CURRENT_KEY_VERSION,
  decryptPkceVerifier,
  decryptTokenEnvelope,
  encryptPkceVerifier,
  encryptTokenEnvelope,
} from '../crypto/token-envelope';
import { cookiePath, OAUTH_TX_TTL_MS, SESSION_TTL_MS } from './cookies';
import { assertSafeAuthUrl, buildGoogleAuthUrl, generateOAuthState, generatePkcePair, sha256Buffer } from './oauth-url';
import { connectionStatusFromGrant, hasAllRequestedScopes } from './scopes';
import type { AuthErrorCode, AuthStore, ConnectionRow, GoogleOAuthClient, GoogleTokenResponse, SessionRow } from './types';

export type StartOAuthResult =
  | { kind: 'not_configured' }
  | { kind: 'redirect'; url: string; transactionId: string; cookiePath: string };

export type CallbackOAuthResult = {
  authError?: AuthErrorCode;
  sessionToken?: string;
  userId?: string;
  keepExistingSession: boolean;
};

function hashesEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function nowOr(now: Date | undefined): Date {
  return now ?? new Date();
}

function shouldPromptConsent(connection: ConnectionRow | undefined, now: Date): boolean {
  if (!connection || connection.status === 'disconnected' || !connection.tokenEnvelopeCiphertext) {
    return true;
  }
  if (connection.status === 'expired' || connection.status === 'partial') {
    return true;
  }
  if (connection.refreshTokenExpiresAt && connection.refreshTokenExpiresAt.getTime() <= now.getTime()) {
    return true;
  }
  return !hasAllRequestedScopes(connection.grantedScopes);
}

function envelopeFrom(row: ConnectionRow) {
  if (!row.tokenEnvelopeCiphertext || !row.tokenEnvelopeIv || !row.tokenEnvelopeAuthTag) {
    return undefined;
  }
  return {
    ciphertext: row.tokenEnvelopeCiphertext,
    iv: row.tokenEnvelopeIv,
    authTag: row.tokenEnvelopeAuthTag,
  };
}

function applyTokens(
  row: ConnectionRow,
  tokens: GoogleTokenResponse,
  refreshToken: string,
  identity: { healthUserId: string; legacyUserId: string | undefined },
  key: Buffer,
  now: Date,
): ConnectionRow {
  const encrypted = encryptTokenEnvelope({ accessToken: tokens.accessToken, refreshToken }, key, row.id, row.userId);
  const status = connectionStatusFromGrant({
    granted: tokens.grantedScopes,
    hasRefreshToken: true,
    refreshTokenExpiresAt: tokens.refreshExpiresAt,
    now,
  });
  const liveLease = row.syncLeaseUntil && row.syncLeaseUntil.getTime() > now.getTime() ? row.syncLeaseUntil : undefined;
  return {
    ...row,
    healthUserId: identity.healthUserId,
    legacyUserId: identity.legacyUserId ?? row.legacyUserId,
    tokenEnvelopeCiphertext: encrypted.ciphertext,
    tokenEnvelopeIv: encrypted.iv,
    tokenEnvelopeAuthTag: encrypted.authTag,
    encryptionKeyVersion: CURRENT_KEY_VERSION,
    accessTokenExpiresAt: tokens.expiresAt,
    refreshTokenExpiresAt: tokens.refreshExpiresAt ?? row.refreshTokenExpiresAt,
    grantedScopes: tokens.grantedScopes,
    status,
    lastErrorCode: undefined,
    connectedAt: now,
    updatedAt: now,
    nextSyncAt: now,
    syncRetryCount: 0,
    syncLeaseUntil: liveLease,
    lastSyncAttemptAt: liveLease ? row.lastSyncAttemptAt : undefined,
  };
}

function clearTokens(row: ConnectionRow, now: Date): ConnectionRow {
  return {
    ...row,
    tokenEnvelopeCiphertext: undefined,
    tokenEnvelopeIv: undefined,
    tokenEnvelopeAuthTag: undefined,
    encryptionKeyVersion: undefined,
    accessTokenExpiresAt: undefined,
    refreshTokenExpiresAt: undefined,
    grantedScopes: [],
    status: 'disconnected',
    lastErrorCode: 'disconnected',
    updatedAt: now,
    nextSyncAt: undefined,
    syncRetryCount: 0,
    syncLeaseUntil: undefined,
    lastSyncAttemptAt: undefined,
  };
}

async function createSession(store: AuthStore, userId: string, now: Date): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const row: SessionRow = {
    id: randomUUID(),
    userId,
    tokenHash: sha256Buffer(token),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    createdAt: now,
    lastSeenAt: now,
  };
  await store.sessions.insert(row);
  return token;
}

export async function startGoogleOAuth(input: {
  config: OAuthConfig | { kind: 'demo' | 'unconfigured' };
  store: AuthStore;
  sessionUserId?: string;
  now?: Date;
}): Promise<StartOAuthResult> {
  if (input.config.kind !== 'oauth') {
    return { kind: 'not_configured' };
  }

  const now = nowOr(input.now);
  await input.store.transactions.deleteExpired(now);

  let existing: ConnectionRow | undefined;
  if (input.sessionUserId) {
    existing = await input.store.connections.findByUserId(input.sessionUserId);
  }

  const state = generateOAuthState();
  const pkce = generatePkcePair();
  const transactionId = randomUUID();
  const encrypted = encryptPkceVerifier(pkce.verifier, input.config.tokenEncryptionKey, transactionId);

  await input.store.transactions.insert({
    id: transactionId,
    stateHash: sha256Buffer(state),
    pkceVerifierCiphertext: encrypted.ciphertext,
    pkceVerifierIv: encrypted.iv,
    pkceVerifierAuthTag: encrypted.authTag,
    pkceKeyVersion: CURRENT_KEY_VERSION,
    initiatingUserId: input.sessionUserId,
    expiresAt: new Date(now.getTime() + OAUTH_TX_TTL_MS),
  });

  const url = buildGoogleAuthUrl({
    clientId: input.config.googleClientId,
    redirectUri: redirectUri(input.config),
    state,
    codeChallenge: pkce.challenge,
    promptConsent: shouldPromptConsent(existing, now),
  });
  assertSafeAuthUrl(url);

  return { kind: 'redirect', url: url.toString(), transactionId, cookiePath: cookiePath() };
}

export async function completeGoogleOAuth(input: {
  config: OAuthConfig;
  store: AuthStore;
  google: GoogleOAuthClient;
  query: { code?: string; state?: string; error?: string };
  transactionId?: string;
  now?: Date;
}): Promise<CallbackOAuthResult> {
  const now = nowOr(input.now);
  const fail = async (authError: AuthErrorCode): Promise<CallbackOAuthResult> => {
    if (input.transactionId) {
      await input.store.transactions.deleteById(input.transactionId);
    }
    return { authError, keepExistingSession: true };
  };

  if (input.query.error === 'access_denied') {
    return fail('access_denied');
  }
  if (!input.query.code || !input.query.state || !input.transactionId) {
    return fail('invalid_state');
  }

  const transaction = await input.store.transactions.findById(input.transactionId);
  if (!transaction) {
    return fail('invalid_state');
  }
  if (transaction.expiresAt.getTime() <= now.getTime()) {
    await input.store.transactions.deleteById(transaction.id);
    return { authError: 'transaction_expired', keepExistingSession: true };
  }
  if (!hashesEqual(transaction.stateHash, sha256Buffer(input.query.state))) {
    return fail('invalid_state');
  }

  let verifier: string;
  try {
    verifier = decryptPkceVerifier(
      {
        ciphertext: transaction.pkceVerifierCiphertext,
        iv: transaction.pkceVerifierIv,
        authTag: transaction.pkceVerifierAuthTag,
      },
      { current: input.config.tokenEncryptionKey, previous: input.config.tokenEncryptionKeyPrevious },
      transaction.id,
      transaction.pkceKeyVersion,
    );
  } catch {
    return fail('invalid_state');
  }

  await input.store.transactions.deleteById(transaction.id);

  let tokens: GoogleTokenResponse;
  try {
    tokens = await input.google.exchangeCode({
      code: input.query.code,
      codeVerifier: verifier,
      redirectUri: redirectUri(input.config),
    });
  } catch {
    return { authError: 'token_exchange_failed', keepExistingSession: true };
  }

  const revokeBestEffort = async (): Promise<void> => {
    try {
      await input.google.revoke(tokens.refreshToken ?? tokens.accessToken);
    } catch {
      // Local failure handling continues without Google's revoke result.
    }
  };

  let identity: { healthUserId: string; legacyUserId: string | undefined };
  try {
    identity = await input.google.getIdentity(tokens.accessToken);
  } catch {
    await revokeBestEffort();
    return { authError: 'identity_unavailable', keepExistingSession: true };
  }
  if (!identity.healthUserId) {
    await revokeBestEffort();
    return { authError: 'identity_unavailable', keepExistingSession: true };
  }

  const keyring = { current: input.config.tokenEncryptionKey, previous: input.config.tokenEncryptionKeyPrevious };

  try {
    return await input.store.withTransaction(async (store) => {
      const existing = await store.connections.findByHealthUserId(identity.healthUserId);

      if (transaction.initiatingUserId) {
        const mine = await store.connections.findByUserId(transaction.initiatingUserId);
        if (!mine || mine.healthUserId !== identity.healthUserId || (existing && existing.userId !== transaction.initiatingUserId)) {
          await revokeBestEffort();
          return { authError: 'identity_mismatch' as const, keepExistingSession: true };
        }

        let refreshToken = tokens.refreshToken;
        if (!refreshToken) {
          const envelope = envelopeFrom(mine);
          if (!envelope) {
            await revokeBestEffort();
            return { authError: 'missing_refresh_token' as const, keepExistingSession: true };
          }
          try {
            refreshToken = decryptTokenEnvelope(envelope, keyring, mine.id, mine.userId, mine.encryptionKeyVersion ?? CURRENT_KEY_VERSION).refreshToken;
          } catch {
            await store.connections.update({ ...mine, status: 'expired', lastErrorCode: 'missing_refresh_token', updatedAt: now });
            return { authError: 'missing_refresh_token' as const, keepExistingSession: true };
          }
        }

        await store.connections.update(applyTokens(mine, tokens, refreshToken, identity, keyring.current, now));
        return { keepExistingSession: true, userId: mine.userId };
      }

      if (existing) {
        let refreshToken = tokens.refreshToken;
        if (!refreshToken) {
          const envelope = envelopeFrom(existing);
          if (!envelope) {
            await revokeBestEffort();
            return { authError: 'missing_refresh_token' as const, keepExistingSession: true };
          }
          try {
            refreshToken = decryptTokenEnvelope(
              envelope,
              keyring,
              existing.id,
              existing.userId,
              existing.encryptionKeyVersion ?? CURRENT_KEY_VERSION,
            ).refreshToken;
          } catch {
            await store.connections.update({ ...existing, status: 'expired', lastErrorCode: 'missing_refresh_token', updatedAt: now });
            return { authError: 'missing_refresh_token' as const, keepExistingSession: true };
          }
        }
        await store.connections.update(applyTokens(existing, tokens, refreshToken, identity, keyring.current, now));
        const sessionToken = await createSession(store, existing.userId, now);
        return { sessionToken, userId: existing.userId, keepExistingSession: false };
      }

      if (!tokens.refreshToken) {
        await revokeBestEffort();
        return { authError: 'missing_refresh_token' as const, keepExistingSession: true };
      }

      const userId = randomUUID();
      const connectionId = randomUUID();
      await store.users.insert(userId);
      const created: ConnectionRow = {
        id: connectionId,
        userId,
        healthUserId: identity.healthUserId,
        legacyUserId: identity.legacyUserId,
        tokenEnvelopeCiphertext: undefined,
        tokenEnvelopeIv: undefined,
        tokenEnvelopeAuthTag: undefined,
        encryptionKeyVersion: undefined,
        accessTokenExpiresAt: undefined,
        refreshTokenExpiresAt: undefined,
        grantedScopes: [],
        status: 'disconnected',
        lastErrorCode: undefined,
        connectedAt: now,
        updatedAt: now,
        lastSuccessfulSyncAt: undefined,
        nextSyncAt: undefined,
        syncRetryCount: 0,
        syncLeaseUntil: undefined,
        lastSyncAttemptAt: undefined,
      };
      await store.connections.insert(applyTokens(created, tokens, tokens.refreshToken, identity, keyring.current, now));
      const sessionToken = await createSession(store, userId, now);
      return { sessionToken, userId, keepExistingSession: false };
    });
  } catch {
    await revokeBestEffort();
    return { authError: 'token_exchange_failed', keepExistingSession: true };
  }
}

export async function readSessionUserId(store: AuthStore, sessionToken: string | undefined, now = new Date()): Promise<string | undefined> {
  if (!sessionToken) {
    return undefined;
  }
  const row = await store.sessions.findByTokenHash(sha256Buffer(sessionToken));
  if (!row) {
    return undefined;
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    await store.sessions.deleteByTokenHash(row.tokenHash);
    return undefined;
  }
  return row.userId;
}

export async function logoutCurrentSession(store: AuthStore, sessionToken: string | undefined): Promise<void> {
  if (!sessionToken) {
    return;
  }
  await store.sessions.deleteByTokenHash(sha256Buffer(sessionToken));
}

export async function disconnectUser(input: {
  store: AuthStore;
  google: GoogleOAuthClient;
  config: OAuthConfig;
  userId: string;
  now?: Date;
}): Promise<{ googleRevokeFailed: boolean }> {
  const now = nowOr(input.now);
  const connection = await input.store.connections.findByUserId(input.userId);
  let revokeToken: string | undefined;
  if (connection) {
    const envelope = envelopeFrom(connection);
    if (envelope) {
      try {
        const tokens = decryptTokenEnvelope(
          envelope,
          { current: input.config.tokenEncryptionKey, previous: input.config.tokenEncryptionKeyPrevious },
          connection.id,
          connection.userId,
          connection.encryptionKeyVersion ?? CURRENT_KEY_VERSION,
        );
        revokeToken = tokens.refreshToken ?? tokens.accessToken;
      } catch {
        revokeToken = undefined;
      }
    }
    await input.store.withTransaction(async (store) => {
      await store.connections.update(clearTokens(connection, now));
      await store.healthSnapshots.deleteForUser(input.userId);
      await store.sessions.deleteAllForUser(input.userId);
    });
  } else {
    await input.store.sessions.deleteAllForUser(input.userId);
  }

  if (!revokeToken) {
    return { googleRevokeFailed: false };
  }
  try {
    await input.google.revoke(revokeToken);
    return { googleRevokeFailed: false };
  } catch {
    return { googleRevokeFailed: true };
  }
}
