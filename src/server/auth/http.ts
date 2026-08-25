import type { AppConfig, OAuthConfig } from '../config/env';
import { publicPath } from '../config/env';
import { cookiePath, expireCookie, OAUTH_TX_COOKIE, OAUTH_TX_TTL_MS, readCookie, serializeCookie, SESSION_COOKIE, SESSION_TTL_MS } from './cookies';
import { completeGoogleOAuth, disconnectUser, logoutCurrentSession, readSessionUserId, startGoogleOAuth } from './oauth-service';
import type { AuthErrorCode, AuthStore, GoogleOAuthClient } from './types';

export type HttpDeps = {
  config: AppConfig;
  store?: AuthStore;
  google?: GoogleOAuthClient;
  now?: () => Date;
  snapshotForUser?: (userId: string) => Promise<{ records: import('../health/provider').UserHealthRecords; syncedAt: Date } | undefined>;
  afterSuccessfulConnect?: (userId: string) => void;
};

function originOf(config: AppConfig): string {
  return config.appOrigin;
}

function secureCookies(config: AppConfig): boolean {
  return originOf(config).startsWith('https:');
}

function accountLocation(config: AppConfig, authError?: AuthErrorCode): string {
  const origin = originOf(config);
  const path = authError ? `/account?auth_error=${authError}` : '/account';
  return publicPath(origin, path);
}

function appendCookies(headers: Headers, values: string[]): void {
  for (const value of values) {
    headers.append('Set-Cookie', value);
  }
}

function redirect(location: string, cookies: string[] = [], extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set('Location', location);
  headers.set('Cache-Control', 'no-store');
  appendCookies(headers, cookies);
  return new Response(null, { status: 303, headers });
}

function jsonError(status: number, code: AuthErrorCode): Response {
  return Response.json({ error: code }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function checkPostOrigin(request: Request, config: AppConfig): AuthErrorCode | undefined {
  const origin = request.headers.get('Origin');
  const expected = originOf(config);
  const production = expected.startsWith('https:');
  if (!origin) {
    return production ? 'origin_rejected' : undefined;
  }
  if (origin !== expected) {
    return 'origin_rejected';
  }
  return undefined;
}

function requireOAuth(config: AppConfig): OAuthConfig | undefined {
  return config.kind === 'oauth' ? config : undefined;
}

async function sessionUser(deps: HttpDeps, request: Request): Promise<string | undefined> {
  if (!deps.store || deps.config.kind !== 'oauth') {
    return undefined;
  }
  return readSessionUserId(deps.store, readCookie(request.headers.get('Cookie'), SESSION_COOKIE), deps.now?.());
}

export async function handleGoogleStart(request: Request, deps: HttpDeps): Promise<Response> {
  if (request.method === 'GET') {
    return new Response(null, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } });
  }
  const originError = checkPostOrigin(request, deps.config);
  if (originError) {
    return redirect(accountLocation(deps.config, originError));
  }
  const oauth = requireOAuth(deps.config);
  if (!oauth || !deps.store) {
    return redirect(accountLocation(deps.config, 'not_configured'));
  }
  const started = await startGoogleOAuth({
    config: oauth,
    store: deps.store,
    sessionUserId: await sessionUser(deps, request),
    now: deps.now?.(),
  });
  if (started.kind !== 'redirect') {
    return redirect(accountLocation(deps.config, 'not_configured'));
  }
  return redirect(started.url, [
    serializeCookie(OAUTH_TX_COOKIE, started.transactionId, {
      path: cookiePath(),
      maxAgeSeconds: Math.floor(OAUTH_TX_TTL_MS / 1000),
      secure: secureCookies(deps.config),
    }),
  ]);
}

export async function handleGoogleCallback(request: Request, deps: HttpDeps): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  const oauth = requireOAuth(deps.config);
  if (!oauth || !deps.store || !deps.google) {
    return redirect(accountLocation(deps.config, 'not_configured'), [], headers);
  }
  const url = new URL(request.url);
  const result = await completeGoogleOAuth({
    config: oauth,
    store: deps.store,
    google: deps.google,
    query: {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
      error: url.searchParams.get('error') ?? undefined,
    },
    transactionId: readCookie(request.headers.get('Cookie'), OAUTH_TX_COOKIE),
    now: deps.now?.(),
  });
  const cookies = [expireCookie(OAUTH_TX_COOKIE, cookiePath(), secureCookies(deps.config))];
  if (result.sessionToken) {
    cookies.push(
      serializeCookie(SESSION_COOKIE, result.sessionToken, {
        path: cookiePath(),
        maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
        secure: secureCookies(deps.config),
      }),
    );
  }
  if (!result.authError && result.userId) {
    deps.afterSuccessfulConnect?.(result.userId);
  }
  return redirect(accountLocation(deps.config, result.authError), cookies, headers);
}

export async function handleReauthorize(request: Request, deps: HttpDeps): Promise<Response> {
  const originError = checkPostOrigin(request, deps.config);
  if (originError) {
    return jsonError(403, originError);
  }
  const userId = await sessionUser(deps, request);
  if (!userId) {
    return jsonError(401, 'unauthorized');
  }
  return handleGoogleStart(request, deps);
}

export async function handleLogout(request: Request, deps: HttpDeps): Promise<Response> {
  const originError = checkPostOrigin(request, deps.config);
  if (originError) {
    return jsonError(403, originError);
  }
  if (deps.store) {
    await logoutCurrentSession(deps.store, readCookie(request.headers.get('Cookie'), SESSION_COOKIE));
  }
  return redirect(accountLocation(deps.config), [expireCookie(SESSION_COOKIE, cookiePath(), secureCookies(deps.config))]);
}

export async function handleDisconnect(request: Request, deps: HttpDeps): Promise<Response> {
  const originError = checkPostOrigin(request, deps.config);
  if (originError) {
    return jsonError(403, originError);
  }
  const oauth = requireOAuth(deps.config);
  const userId = await sessionUser(deps, request);
  if (!oauth || !deps.store || !deps.google || !userId) {
    return jsonError(401, 'unauthorized');
  }
  await disconnectUser({ store: deps.store, google: deps.google, config: oauth, userId, now: deps.now?.() });
  return redirect(accountLocation(deps.config), [expireCookie(SESSION_COOKIE, cookiePath(), secureCookies(deps.config))]);
}
