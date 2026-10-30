// Optional real-database smoke test. Never prints health values or credentials.
import assert from 'node:assert/strict';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHealthReader } from './health.mjs';
import { createRemoteServer } from './server.mjs';
import { HealthOAuthProvider } from './oauth.mjs';

const pool = new pg.Pool({
  host: process.env.POSTGRES_HOST ?? 'db', user: process.env.POSTGRES_USER ?? 'rhythm',
  password: process.env.POSTGRES_PASSWORD, database: process.env.POSTGRES_DB ?? 'rhythm',
  options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 5000,
});
let server;
const client = new Client({ name: 'local-smoke-test', version: '1' });
try {
  assert.equal((await pool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only, 'on');
  const users = (await pool.query('SELECT user_id FROM google_health_connections')).rows;
  const userId = process.env.MCP_USER_ID || (users.length === 1 ? users[0].user_id : undefined);
  assert.ok(userId, 'Set MCP_USER_ID when no account or multiple accounts exist.');
  const dates = (await pool.query(`SELECT max(civil_date)::text AS date
    FROM heart_rate_minute_aggregates WHERE user_id = $1`, [userId])).rows;
  const date = dates[0]?.date ?? new Date().toISOString().slice(0, 10);
  const provider = new HealthOAuthProvider({ resource: 'http://localhost/mcp', userId });
  const token = provider.issue('smoke-client', userId).access_token;
  server = createRemoteServer({ reader: createHealthReader(pool, userId, 'http://localhost:3000/rhythm/account'),
    provider, resolveSession: async () => undefined, publicUrl: 'http://localhost/mcp' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  await client.connect(new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  assert.equal((await client.listTools()).tools.length, 3);
  for (const [name, args] of [['get_sync_status', {}], ['get_health_data', { from: date, to: date }], ['get_daily_summary', { date }]]) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, `${name} failed`);
    assert.ok(result.structuredContent);
    console.log(`${name}: PASS`);
  }
  console.log('Real PostgreSQL + authenticated HTTP MCP: PASS (read-only)');
} finally {
  await client.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
