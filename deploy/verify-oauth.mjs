// Run inside the MCP image. Creates and then deletes a short-lived test login.
// Prints only verification outcomes, never tokens, identifiers or health data.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const resource = process.env.MCP_PUBLIC_URL;
const origin = new URL(resource).origin;
const pool = new pg.Pool({ host: 'db', user: 'rhythm', database: 'rhythm', password: process.env.POSTGRES_PASSWORD });
const sessionId = randomUUID();
const sessionToken = randomBytes(32).toString('base64url');
const client = new Client({ name: 'deployment-verification', version: '1' });
let registered;
let tokens;
const form = (path, body) => fetch(`${origin}${path}`, { method: 'POST', body: new URLSearchParams(body) });
try {
  await pool.query('INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,now()+interval \'5 minutes\')',
    [sessionId, process.env.MCP_USER_ID, createHash('sha256').update(sessionToken).digest()]);
  const metadata = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
  assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
  const registration = await fetch(metadata.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Deployment verification', redirect_uris: ['http://localhost:1234/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  assert.equal(registration.status, 201);
  registered = await registration.json();
  const verifier = randomBytes(48).toString('base64url');
  const params = new URLSearchParams({ client_id: registered.client_id, redirect_uri: registered.redirect_uris[0], response_type: 'code',
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), scope: 'health:read', state: 'deployment-test', resource });
  const authorization = await fetch(`${metadata.authorization_endpoint}?${params}`, { redirect: 'manual' });
  assert.equal(authorization.status, 302);
  const consent = new URL(authorization.headers.get('location'), origin);
  const page = await fetch(consent, { headers: { Cookie: `rhythm_session=${sessionToken}` } });
  assert.equal(page.status, 200);
  const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)[1];
  const approval = await fetch(consent, { method: 'POST', redirect: 'manual',
    headers: { Cookie: `rhythm_session=${sessionToken}`, Origin: origin },
    body: new URLSearchParams({ request: consent.searchParams.get('request'), csrf, decision: 'approve' }) });
  assert.equal(approval.status, 302);
  const callback = new URL(approval.headers.get('location'));
  assert.equal(callback.searchParams.get('state'), 'deployment-test');
  const exchanged = await form('/token', { grant_type: 'authorization_code', client_id: registered.client_id,
    redirect_uri: registered.redirect_uris[0], code: callback.searchParams.get('code'), code_verifier: verifier, resource });
  assert.equal(exchanged.status, 200);
  tokens = await exchanged.json();
  await client.connect(new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
  assert.equal((await client.listTools()).tools.length, 3);
  const { rows } = await pool.query('SELECT max(civil_date)::text AS date FROM heart_rate_minute_aggregates WHERE user_id=$1', [process.env.MCP_USER_ID]);
  const date = rows[0].date ?? new Date().toISOString().slice(0, 10);
  for (const [name, args] of [['get_sync_status', {}], ['get_health_data', { from: date, to: date }], ['get_daily_summary', { date }]]) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, name);
    assert.ok(result.structuredContent);
    console.log(`${name}: PASS`);
  }
  const refreshed = await form('/token', { grant_type: 'refresh_token', client_id: registered.client_id, refresh_token: tokens.refresh_token, resource });
  assert.equal(refreshed.status, 200);
  tokens = await refreshed.json();
  console.log('Public HTTPS OAuth + database-backed MCP: PASS');
} finally {
  if (tokens && registered) await form('/revoke', { client_id: registered.client_id, token: tokens.refresh_token });
  await client.close();
  await pool.query('DELETE FROM sessions WHERE id=$1', [sessionId]);
  await pool.end();
}
