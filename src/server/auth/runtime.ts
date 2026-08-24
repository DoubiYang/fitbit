import { cookies } from 'next/headers';

import { loadConfig } from '../config/env';
import { createGoogleOAuthClient } from './google-client';
import type { HttpDeps } from './http';
import { SESSION_COOKIE } from './cookies';
import { ensurePostgresReady } from '../db/postgres-store';

export async function createRequestDeps(): Promise<HttpDeps> {
  const config = loadConfig();
  if (config.kind !== 'oauth') {
    return { config };
  }
  return {
    config,
    store: await ensurePostgresReady(config.databaseUrl),
    google: createGoogleOAuthClient(config),
  };
}

export async function requestCookieHeader(): Promise<string> {
  const jar = await cookies();
  return jar
    .getAll()
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

export async function sessionCookieValue(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}
