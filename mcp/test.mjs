import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHealthReader, rangeSchema } from './health.mjs';
import { createRemoteServer } from './server.mjs';
import { HealthOAuthProvider } from './oauth.mjs';

test('remote MCP requires a bearer token and supports SDK initialize/list/call', async () => {
  const reader = { status: async () => ({ connection: 'active', stale: false }),
    history: async () => ({ sleep: [] }), summary: async ({ date }) => ({ date }) };
  const provider = new HealthOAuthProvider({ resource: 'http://localhost/mcp', userId: 'owner' });
  const token = provider.issue('test-client', 'owner').access_token;
  const server = createRemoteServer({ reader, provider, resolveSession: async () => undefined, publicUrl: 'http://localhost/mcp' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const client = new Client({ name: 'test-dot', version: '1' });
  try {
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' } })).status, 403);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    assert.equal((await client.listTools()).tools.length, 3);
    const result = await client.callTool({ name: 'get_sync_status', arguments: {} });
    assert.equal(result.structuredContent.connection, 'active');
    const invalid = await client.callTool({ name: 'get_health_data', arguments: { from: '2026-10-01', to: '2026-10-30', userId: 'other' } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('history enforces user scope, removes identifiers and reports missing data honestly', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => {
    queries.push({ sql, params });
    if (sql.startsWith('SELECT records')) return { rows: [{ records: {
      dailyRhr: [{ userId: 'owner', date: '2026-10-29', valueBpm: 55, sourceRecordId: 'secret' },
        { userId: 'other', date: '2026-10-29', valueBpm: 88 }],
    } }] };
    return { rows: [] };
  } };
  const result = await createHealthReader(pool, 'owner', 'https://example.com/rhythm/account').history({ from: '2026-10-29', to: '2026-10-30' });
  assert.deepEqual(result.restingHeartRate, [{ date: '2026-10-29', valueBpm: 55 }]);
  assert.equal(result.sync.stale, true);
  assert.deepEqual(result.sleep, []);
  assert.ok(queries.every(({ params }) => params[0] === 'owner'));
  assert.ok(queries.every(({ sql }) => sql.includes('user_id = $1')));
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('date range rejects impossible dates, reverse ranges and unbounded history', () => {
  for (const [from, to] of [['2026-02-30', '2026-03-01'], ['2026-10-30', '2026-10-01'], ['2026-01-01', '2026-10-30']]) {
    assert.equal(rangeSchema.safeParse({ from, to }).success, false);
  }
});

test('daily summary reads only the bound user and includes freshness with absent metrics', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };
  const result = await createHealthReader(pool, 'owner', 'https://example.com/rhythm/account').summary({ date: '2026-10-30' });
  assert.equal(result.cardioLoad, null);
  assert.equal(result.capacity, null);
  assert.equal(result.sync.connection, 'not_connected');
  assert.equal(result.sync.stale, true);
  assert.ok(queries.every(({ sql, params }) => sql.includes('user_id = $1') && params[0] === 'owner'));
  assert.ok(queries.every(({ sql }) => sql.trim().startsWith('SELECT')));
});
