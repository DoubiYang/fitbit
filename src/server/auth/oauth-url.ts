import { createHash, randomBytes } from 'node:crypto';

import { requestedScopeString } from './scopes';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export type GoogleAuthUrlInput = {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  promptConsent: boolean;
};

export function toBase64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

export function sha256Buffer(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

export function generatePkcePair(entropy: Buffer = randomBytes(32)): { verifier: string; challenge: string } {
  const verifier = toBase64Url(entropy);
  return { verifier, challenge: toBase64Url(sha256Buffer(verifier)) };
}

export function generateOAuthState(entropy: Buffer = randomBytes(32)): string {
  return toBase64Url(entropy);
}

export function buildGoogleAuthUrl(input: GoogleAuthUrlInput): URL {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('scope', requestedScopeString());
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (input.promptConsent) {
    url.searchParams.set('prompt', 'consent');
  }
  return url;
}

export function assertSafeAuthUrl(url: URL): void {
  if (url.searchParams.get('include_granted_scopes') === 'true') {
    throw new Error('include_granted_scopes must not be true.');
  }
}
