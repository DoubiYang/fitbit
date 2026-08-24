import { OAuth2Client } from 'google-auth-library';

import type { OAuthConfig } from '../config/env';
import { redirectUri } from '../config/env';
import { normalizeGrantedScopes } from './scopes';
import type { GoogleIdentity, GoogleOAuthClient, GoogleTokenResponse } from './types';

function expiryDate(value: number | undefined, fallbackSeconds = 3600): Date {
  if (value && value > 0) {
    return new Date(value);
  }
  return new Date(Date.now() + fallbackSeconds * 1000);
}

export function createGoogleOAuthClient(config: OAuthConfig): GoogleOAuthClient {
  const client = new OAuth2Client(config.googleClientId, config.googleClientSecret, redirectUri(config));

  return {
    async exchangeCode(input): Promise<GoogleTokenResponse> {
      const { tokens } = await client.getToken({
        code: input.code,
        codeVerifier: input.codeVerifier,
        redirect_uri: input.redirectUri,
      });
      if (!tokens.access_token) {
        throw new Error('token exchange missing access token');
      }
      const refreshExpiresIn = (tokens as { refresh_token_expires_in?: number }).refresh_token_expires_in;
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? undefined,
        expiresAt: expiryDate(tokens.expiry_date ?? undefined),
        refreshExpiresAt: typeof refreshExpiresIn === 'number' ? new Date(Date.now() + refreshExpiresIn * 1000) : undefined,
        grantedScopes: normalizeGrantedScopes(tokens.scope),
      };
    },
    async getIdentity(accessToken: string): Promise<GoogleIdentity> {
      const response = await fetch('https://health.googleapis.com/v4/users/me/identity', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });
      if (!response.ok) {
        throw new Error('identity unavailable');
      }
      const body = (await response.json()) as { healthUserId?: string; legacyUserId?: string };
      return {
        healthUserId: body.healthUserId ?? '',
        legacyUserId: body.legacyUserId || undefined,
      };
    },
    async revoke(token: string): Promise<void> {
      const response = await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
      });
      if (!response.ok) {
        throw new Error('revoke failed');
      }
    },
  };
}
