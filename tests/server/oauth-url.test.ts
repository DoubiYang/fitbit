import assert from 'node:assert/strict';
import test from 'node:test';

import { REQUESTED_SCOPES } from '../../src/server/auth/scopes';
import { buildGoogleAuthUrl, generatePkcePair } from '../../src/server/auth/oauth-url';

const redirectUri = 'http://localhost:3000/rhythm/api/auth/google/callback';
const pkce = generatePkcePair(Buffer.alloc(32, 5));

function params(promptConsent: boolean): URLSearchParams {
  return buildGoogleAuthUrl({
    clientId: 'client.apps.googleusercontent.com',
    redirectUri,
    state: 'state-token',
    codeChallenge: pkce.challenge,
    promptConsent,
  }).searchParams;
}

test('authorization URL includes all requested scopes, offline access, state and S256 PKCE', () => {
  const query = params(true);
  assert.equal(query.get('response_type'), 'code');
  assert.equal(query.get('access_type'), 'offline');
  assert.equal(query.get('redirect_uri'), redirectUri);
  assert.equal(query.get('state'), 'state-token');
  assert.equal(query.get('code_challenge_method'), 'S256');
  assert.equal(query.get('code_challenge'), pkce.challenge);
  assert.equal(query.get('prompt'), 'consent');
  const scopes = query.get('scope')?.split(' ') ?? [];
  assert.deepEqual(scopes, [...REQUESTED_SCOPES]);
});

test('never sets include_granted_scopes=true', () => {
  const query = params(false);
  assert.equal(query.has('include_granted_scopes'), false);
  assert.equal(query.get('prompt'), null);
});
