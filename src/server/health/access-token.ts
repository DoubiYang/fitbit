import type { OAuthConfig } from '../config/env';
import type { AuthStore, ConnectionRow, GoogleTokenResponse } from '../auth/types';
import { CURRENT_KEY_VERSION, decryptTokenEnvelope, encryptTokenEnvelope } from '../crypto/token-envelope';

const SKEW_MS = 60_000;

function envelopeFrom(row: ConnectionRow) {
  if (!row.tokenEnvelopeCiphertext || !row.tokenEnvelopeIv || !row.tokenEnvelopeAuthTag) {
    return undefined;
  }
  return { ciphertext: row.tokenEnvelopeCiphertext, iv: row.tokenEnvelopeIv, authTag: row.tokenEnvelopeAuthTag };
}

export type TokenRefresher = {
  refresh(refreshToken: string): Promise<Pick<GoogleTokenResponse, 'accessToken' | 'refreshToken' | 'expiresAt' | 'refreshExpiresAt'>>;
};

export function createGoogleTokenRefresher(config: OAuthConfig): TokenRefresher {
  return {
    async refresh(refreshToken: string) {
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.googleClientId,
          client_secret: config.googleClientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      });
      if (!response.ok) {
        throw new Error('refresh failed');
      }
      const body = (await response.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        refresh_token_expires_in?: number;
      };
      if (!body.access_token) {
        throw new Error('refresh missing access token');
      }
      return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000),
        refreshExpiresAt: body.refresh_token_expires_in ? new Date(Date.now() + body.refresh_token_expires_in * 1000) : undefined,
      };
    },
  };
}

export async function resolveAccessToken(input: {
  config: OAuthConfig;
  store: AuthStore;
  connection: ConnectionRow;
  refresher: TokenRefresher;
  now?: Date;
}): Promise<string> {
  const now = input.now ?? new Date();
  const envelope = envelopeFrom(input.connection);
  if (!envelope) {
    throw new Error('connection has no token envelope');
  }
  const tokens = decryptTokenEnvelope(
    envelope,
    { current: input.config.tokenEncryptionKey, previous: input.config.tokenEncryptionKeyPrevious },
    input.connection.id,
    input.connection.userId,
    input.connection.encryptionKeyVersion ?? CURRENT_KEY_VERSION,
  );
  const expiresAt = input.connection.accessTokenExpiresAt;
  if (expiresAt && expiresAt.getTime() - SKEW_MS > now.getTime()) {
    return tokens.accessToken;
  }

  const refreshed = await input.refresher.refresh(tokens.refreshToken);
  const refreshToken = refreshed.refreshToken ?? tokens.refreshToken;
  const encrypted = encryptTokenEnvelope(
    { accessToken: refreshed.accessToken, refreshToken },
    input.config.tokenEncryptionKey,
    input.connection.id,
    input.connection.userId,
  );
  const updated = await input.store.connections.updateAccessTokenIfSyncable({
    id: input.connection.id,
    userId: input.connection.userId,
    tokenEnvelopeCiphertext: encrypted.ciphertext,
    tokenEnvelopeIv: encrypted.iv,
    tokenEnvelopeAuthTag: encrypted.authTag,
    encryptionKeyVersion: CURRENT_KEY_VERSION,
    accessTokenExpiresAt: refreshed.expiresAt,
    refreshTokenExpiresAt: refreshed.refreshExpiresAt,
    updatedAt: now,
  });
  if (!updated) {
    throw new Error('connection no longer syncable');
  }
  return refreshed.accessToken;
}
