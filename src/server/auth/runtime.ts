import { cookies } from 'next/headers';

import { loadConfig } from '../config/env';
import { createGoogleOAuthClient } from './google-client';
import type { HttpDeps } from './http';
import { SESSION_COOKIE } from './cookies';
import { ensurePostgresReady } from '../db/postgres-store';
import { syncUserConnection } from '../health/run-sync';

export async function createRequestDeps(): Promise<HttpDeps> {
  const config = loadConfig();
  if (config.kind !== 'oauth') {
    return { config };
  }
  const store = await ensurePostgresReady(config.databaseUrl);
  return {
    config,
    store,
    google: createGoogleOAuthClient(config),
    afterSuccessfulConnect: (userId) => {
      void syncUserConnection({ config, store, userId }).catch(() => undefined);
    },
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
