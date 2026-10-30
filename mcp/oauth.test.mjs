import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { HealthOAuthProvider } from './oauth.mjs';
import { createRemoteServer } from './server.mjs';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('OAuth binds one-time codes and rotating tokens to client, redirect and resource', async () => {
  const provider = new HealthOAuthProvider({ resource: 'https://example.com/mcp', userId: 'owner' });
  const client = await provider.clientsStore.registerClient({ redirect_uris: ['http://localhost:1234/callback'], token_endpoint_auth_method: 'none' });
  let location;
  await provider.authorize(client, { redirectUri: client.redirect_uris[0], codeChallenge: createHash('sha256').update('verifier').digest('base64url'), resource: new URL('https://example.com/mcp'), state: 'state' }, { redirect: (url) => { location = url; } });
  const request = new URL(location, 'https://example.com').searchParams.get('request');
  assert.throws(() => provider.approve(request, 'other'), /account/);
  const redirect = new URL(provider.approve(request, 'owner'));
  assert.equal(redirect.searchParams.get('state'), 'state');
  const code = redirect.searchParams.get('code');
  await assert.rejects(provider.exchangeAuthorizationCode({ ...client, client_id: 'other' }, code, undefined, client.redirect_uris[0]), /code/);
  await assert.rejects(provider.exchangeAuthorizationCode(client, code, undefined, 'https://evil.example'), /redirect/);
  const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0]);
  await assert.rejects(provider.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0]), /code/);
  assert.equal((await provider.verifyAccessToken(tokens.access_token)).clientId, client.client_id);
  await assert.rejects(provider.exchangeRefreshToken(client, tokens.refresh_token, ['write']), /scope/);
  const refreshed = await provider.exchangeRefreshToken(client, tokens.refresh_token);
  await assert.rejects(provider.exchangeRefreshToken(client, tokens.refresh_token), /refresh/);
  await provider.revokeToken(client, { token: refreshed.refresh_token });
  await assert.rejects(provider.verifyAccessToken(refreshed.access_token), /token/);
});

test('OAuth rejects untrusted redirect schemes and wrong resources', async () => {
  const provider = new HealthOAuthProvider({ resource: 'https://example.com/mcp', userId: 'owner' });
  await assert.rejects(provider.clientsStore.registerClient({ redirect_uris: ['http://evil.example/callback'] }), /redirect/);
  const client = await provider.clientsStore.registerClient({ redirect_uris: ['https://chatgpt.com/callback'], token_endpoint_auth_method: 'none' });
  await assert.rejects(provider.authorize(client, { redirectUri: client.redirect_uris[0], codeChallenge: 'x', resource: new URL('https://evil.example') }, {}), /resource/);
});

test('discovery, registration, consent, PKCE, refresh and revocation work over HTTP', async () => {
  const provider = new HealthOAuthProvider({ resource: 'http://localhost/mcp', userId: 'owner' });
  const server = createRemoteServer({ provider, publicUrl: 'http://localhost/mcp',
    resolveSession: async (cookie) => cookie === 'test=owner' ? 'owner' : undefined,
    reader: { status: async () => ({ connection: 'active' }), history: async () => ({}), summary: async () => ({}) } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', body: new URLSearchParams(body) });
  try {
    const unauthorized = await fetch(`${base}/mcp`, { method: 'POST' });
    assert.match(unauthorized.headers.get('www-authenticate'), /resource_metadata=/);
    const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(resource.resource, 'http://localhost/mcp');
    const metadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
    const registration = await fetch(`${base}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Codex test', redirect_uris: ['http://localhost:1234/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
    assert.equal(registration.status, 201);
    const client = await registration.json();
    const verifier = 'v'.repeat(64);
    const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code',
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), scope: 'health:read', state: 'original-state', resource: resource.resource });
    const auth = await fetch(`${base}/authorize?${params}`, { redirect: 'manual' });
    assert.equal(auth.status, 302);
    const consentPath = auth.headers.get('location');
    assert.equal((await fetch(`${base}${consentPath}`)).status, 401);
    const page = await (await fetch(`${base}${consentPath}`, { headers: { Cookie: 'test=owner' } })).text();
    const csrf = page.match(/name="csrf" value="([^"]+)"/)[1];
    const request = new URL(consentPath, base).searchParams.get('request');
    const body = new URLSearchParams({ request, csrf, decision: 'approve' });
    assert.equal((await fetch(`${base}/rhythm/mcp/consent`, { method: 'POST', headers: { Origin: 'http://evil.example', Cookie: 'test=owner' }, body })).status, 403);
    const approved = await fetch(`${base}/rhythm/mcp/consent`, { method: 'POST', headers: { Origin: 'http://localhost', Cookie: 'test=owner' }, body, redirect: 'manual' });
    assert.equal(approved.status, 302);
    const redirect = new URL(approved.headers.get('location'));
    assert.equal(redirect.searchParams.get('state'), 'original-state');
    const grant = { grant_type: 'authorization_code', code: redirect.searchParams.get('code'), client_id: client.client_id, redirect_uri: client.redirect_uris[0], resource: resource.resource };
    assert.equal((await post('/token', { ...grant, code_verifier: 'wrong' })).status, 400);
    const exchange = await post('/token', { ...grant, code_verifier: verifier });
    assert.equal(exchange.status, 200);
    const tokens = await exchange.json();
    assert.equal((await post('/token', { ...grant, code_verifier: verifier })).status, 400);
    const refreshed = await (await post('/token', { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token })).json();
    assert.ok(refreshed.access_token);
    await post('/revoke', { client_id: client.client_id, token: refreshed.refresh_token });
    await assert.rejects(provider.verifyAccessToken(refreshed.access_token));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('OAuth survives restart, stores hashed tokens and consumes concurrent refresh only once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rhythm-oauth-'));
  const stateFile = join(directory, 'oauth.json');
  try {
    const provider = new HealthOAuthProvider({ resource: 'https://example.com/mcp', userId: 'owner', stateFile });
    const tokens = provider.issue('client', 'owner');
    assert.equal(readFileSync(stateFile, 'utf8').includes(tokens.access_token), false);
    assert.equal(statSync(stateFile).mode & 0o777, 0o600);
    const restarted = new HealthOAuthProvider({ resource: 'https://example.com/mcp', userId: 'owner', stateFile });
    assert.equal((await restarted.verifyAccessToken(tokens.access_token)).clientId, 'client');
    const results = await Promise.allSettled([1, 2].map(() => restarted.exchangeRefreshToken({ client_id: 'client' }, tokens.refresh_token)));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
