import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createRemoteServer } from './server.mjs';
import { HealthOAuthProvider } from './oauth.mjs';

const chrome = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
test('real Chrome consent form retains its Origin and authorizes successfully', {
  skip: !existsSync(chrome), timeout: 30000,
}, async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const provider = new HealthOAuthProvider({ resource: `${origin}/mcp`, userId: 'owner' });
  const client = await provider.clientsStore.registerClient({ redirect_uris: [`${origin}/complete`], token_endpoint_auth_method: 'none' });
  let path;
  await provider.authorize(client, { redirectUri: client.redirect_uris[0], codeChallenge: 'test' }, { redirect: (value) => { path = value; } });
  const server = createRemoteServer({ provider, resolveSession: async () => 'owner', publicUrl: `${origin}/mcp`, reader: {} });
  let submission;
  server.prependListener('request', (req, res) => {
    if (req.method === 'POST' && req.url.includes('/consent')) res.on('finish', () => {
      submission = { origin: req.headers.origin, status: res.statusCode };
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const profile = mkdtempSync(join(tmpdir(), 'rhythm-consent-chrome-'));
  const browser = spawn(chrome, ['--headless', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let sequence = 0;
  const pending = new Map();
  let buffer = '';
  browser.stdio[4].on('data', (chunk) => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    }
  });
  const command = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    browser.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  });
  const until = async (check) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Chrome consent timed out');
  };
  try {
    const { targetId } = await command('Target.createTarget', { url: `${origin}${path}` });
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    await until(async () => (await command('Runtime.evaluate', { expression: '!!document.querySelector("button[value=approve]")', returnByValue: true }, sessionId)).result?.value);
    await command('Runtime.evaluate', { expression: 'document.querySelector("button[value=approve]").click()' }, sessionId);
    await until(() => submission);
    assert.equal(submission.origin, origin);
    assert.equal(submission.status, 302);
  } finally {
    browser.kill('SIGTERM');
    if (browser.exitCode === null) await new Promise((resolve) => browser.once('exit', resolve));
    await new Promise((resolve) => server.close(resolve));
    rmSync(profile, { recursive: true, force: true });
  }
});
