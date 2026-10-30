import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { InvalidGrantError, InvalidTokenError, InvalidScopeError, InvalidTargetError, InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
export const HEALTH_SCOPE = 'health:read';
export const CONSENT_PATH = '/rhythm/mcp/consent';

export class HealthOAuthProvider {
  constructor({ resource, userId, stateFile, isConnected = async () => true }) {
    this.resource = resource;
    this.userId = userId;
    this.stateFile = stateFile;
    this.isConnected = isConnected;
    this.state = stateFile && existsSync(stateFile)
      ? JSON.parse(readFileSync(stateFile, 'utf8'))
      : { clients: {}, pending: {}, codes: {}, tokens: {} };
    if (stateFile && existsSync(stateFile)) chmodSync(stateFile, 0o600);
    this.clientsStore = {
      getClient: async (id) => this.state.clients[id],
      registerClient: async (client) => {
        if (!client.redirect_uris?.length || client.redirect_uris.some((uri) => {
          try {
            const url = new URL(uri);
            return url.hash || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
          } catch { return true; }
        })) throw new InvalidClientMetadataError('Invalid redirect URI');
        if (Object.keys(this.state.clients).length >= 1000) throw new InvalidClientMetadataError('Client registration limit reached');
        const registered = { ...client, client_id: randomUUID(), client_id_issued_at: now() };
        this.state.clients[registered.client_id] = registered;
        this.save();
        return registered;
      },
    };
  }
  save() {
    for (const type of ['pending', 'codes', 'tokens']) {
      for (const [id, value] of Object.entries(this.state[type])) if (value.expiresAt <= now()) delete this.state[type][id];
    }
    if (!this.stateFile) return;
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(`${this.stateFile}.tmp`, this.stateFile);
  }
  checkResource(resource) {
    if (resource && resource.href !== this.resource) throw new InvalidTargetError('Invalid resource');
  }
  checkScopes(scopes) {
    if (scopes?.some((scope) => scope !== HEALTH_SCOPE)) throw new InvalidScopeError('Invalid scope');
  }
  async authorize(client, params, res) {
    this.checkResource(params.resource);
    this.checkScopes(params.scopes);
    this.save();
    if (Object.keys(this.state.pending).length >= 1000) throw new InvalidGrantError('Authorization request limit reached');
    const request = secret();
    this.state.pending[request] = { clientId: client.client_id, redirectUri: params.redirectUri,
      challenge: params.codeChallenge, state: params.state, expiresAt: now() + 600, csrf: secret() };
    this.save();
    res.redirect(`${CONSENT_PATH}?request=${request}`);
  }
  pending(request) {
    const entry = this.state.pending[request];
    if (!entry || entry.expiresAt <= now()) throw new InvalidGrantError('Authorization request expired');
    return entry;
  }
  approve(request, userId) {
    if (userId !== this.userId) throw new InvalidGrantError('Wrong account');
    const entry = this.pending(request);
    const code = secret();
    this.state.codes[hash(code)] = { ...entry, userId, expiresAt: now() + 120 };
    delete this.state.pending[request];
    this.save();
    const redirect = new URL(entry.redirectUri);
    redirect.searchParams.set('code', code);
    if (entry.state !== undefined) redirect.searchParams.set('state', entry.state);
    return redirect.href;
  }
  code(client, code) {
    const entry = this.state.codes[hash(code)];
    if (!entry || entry.expiresAt <= now() || entry.clientId !== client.client_id) throw new InvalidGrantError('Invalid code');
    return entry;
  }
  async challengeForAuthorizationCode(client, code) { return this.code(client, code).challenge; }
  issue(clientId, userId, family = secret()) {
    const access = secret();
    const refresh = secret();
    const base = { clientId, userId, family };
    this.state.tokens[hash(access)] = { ...base, type: 'access', expiresAt: now() + 3600 };
    this.state.tokens[hash(refresh)] = { ...base, type: 'refresh', expiresAt: now() + 30 * 86400 };
    this.save();
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: HEALTH_SCOPE };
  }
  async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
    const entry = this.code(client, code);
    this.checkResource(resource);
    if (redirectUri !== entry.redirectUri) throw new InvalidGrantError('Invalid redirect URI');
    delete this.state.codes[hash(code)];
    return this.issue(client.client_id, entry.userId);
  }
  async exchangeRefreshToken(client, refresh, scopes, resource) {
    this.checkScopes(scopes);
    this.checkResource(resource);
    const entry = this.state.tokens[hash(refresh)];
    if (!entry || entry.type !== 'refresh' || entry.expiresAt <= now() || entry.clientId !== client.client_id || !(await this.isConnected(entry.userId))) throw new InvalidGrantError('Invalid refresh token');
    if (this.state.tokens[hash(refresh)] !== entry) throw new InvalidGrantError('Invalid refresh token');
    delete this.state.tokens[hash(refresh)];
    return this.issue(client.client_id, entry.userId, entry.family);
  }
  async verifyAccessToken(token) {
    const entry = this.state.tokens[hash(token)];
    if (!entry || entry.type !== 'access' || entry.expiresAt <= now() || entry.userId !== this.userId || !(await this.isConnected(entry.userId))) throw new InvalidTokenError('Invalid token');
    return { token, clientId: entry.clientId, scopes: [HEALTH_SCOPE], expiresAt: entry.expiresAt, resource: new URL(this.resource) };
  }
  async revokeToken(client, { token }) {
    const entry = this.state.tokens[hash(token)];
    if (!entry || entry.clientId !== client.client_id) return;
    for (const [key, value] of Object.entries(this.state.tokens)) if (value.family === entry.family) delete this.state.tokens[key];
    this.save();
  }
}

export async function sessionUser(pool, cookie = '') {
  const token = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('rhythm_session='))?.slice('rhythm_session='.length);
  if (!token) return undefined;
  const result = await pool.query('SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now()', [Buffer.from(hash(token), 'hex')]);
  return result.rows[0]?.user_id;
}
