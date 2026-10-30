import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createHealthReader, dateSchema, rangeSchema } from './health.mjs';
import { oauthApp } from './oauth-http.mjs';
import { HealthOAuthProvider, sessionUser } from './oauth.mjs';

export function createMcp(reader) {
  const server = new McpServer({ name: 'rhythm-health', version: '0.1.0' });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const wrap = (fn) => async (args) => {
    try {
      const result = await fn(args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch {
      return { isError: true, content: [{ type: 'text', text: 'Health query failed. Check the connection and date arguments; retry later.' }] };
    }
  };
  server.registerTool('get_sync_status', {
    description: 'Read Google connection status, sync freshness, errors and the account reconnect URL. Check before monitoring health data.',
    inputSchema: z.object({}).strict(), annotations,
  }, wrap(reader.status));
  server.registerTool('get_health_data', {
    description: 'Read local sleep, HRV (ms), resting HR (bpm), activity and daily heart-rate summaries for YYYY-MM-DD dates. Maximum 42 days. Missing data is unknown.',
    inputSchema: rangeSchema, annotations,
  }, wrap(reader.history));
  server.registerTool('get_daily_summary', {
    description: 'Read stored recovery, sleep performance, actual TRIMP and personal capacity for a YYYY-MM-DD date, including quality and sync freshness.',
    inputSchema: z.object({ date: dateSchema }).strict(), annotations,
  }, wrap(reader.summary));
  return server;
}

export function createRemoteServer({ reader, provider, resolveSession, publicUrl, accountUrl = '/rhythm/account' }) {
  const endpoint = new URL(publicUrl);
  if (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(endpoint.hostname)) {
    throw new Error('A remote MCP_PUBLIC_URL must use HTTPS.');
  }
  const app = oauthApp({ provider, resolveSession, endpoint, accountUrl });
  app.post(endpoint.pathname, async (req, res) => {
    const mcp = createMcp(reader);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void mcp.close(); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    }
  });
  app.all(endpoint.pathname, (_req, res) => res.status(405).set('Allow', 'POST').end());
  app.use((_error, _req, res, _next) => { res.status(500).json({ error: 'server_error' }); });
  return createHttpServer(app);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const userId = z.uuid().parse(process.env.MCP_USER_ID);
  const publicUrl = process.env.MCP_PUBLIC_URL ?? 'http://localhost:3001/mcp';
  const databaseUrl = process.env.DATABASE_URL || `postgresql://${encodeURIComponent(process.env.POSTGRES_USER ?? 'rhythm')}:${encodeURIComponent(process.env.POSTGRES_PASSWORD ?? '')}@${process.env.POSTGRES_HOST ?? 'db'}:5432/${process.env.POSTGRES_DB ?? 'rhythm'}`;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, statement_timeout: 10000,
    options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 5000 });
  const accountUrl = new URL('/rhythm/account', process.env.APP_ORIGIN ?? 'http://localhost:3000').href;
  const provider = new HealthOAuthProvider({ resource: publicUrl, userId,
    stateFile: process.env.MCP_OAUTH_STATE_FILE ?? '/data/oauth.json',
    isConnected: async (id) => (await pool.query("SELECT 1 FROM google_health_connections WHERE user_id = $1 AND status <> 'disconnected'", [id])).rowCount > 0 });
  const server = createRemoteServer({ reader: createHealthReader(pool, userId, accountUrl), provider,
    resolveSession: (cookie) => sessionUser(pool, cookie), publicUrl, accountUrl });
  server.requestTimeout = 30000;
  server.listen(Number(process.env.MCP_PORT ?? 3001), '0.0.0.0', () => console.error('Health MCP listening'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    server.close(() => { void pool.end(); });
    server.closeIdleConnections();
  });
}
