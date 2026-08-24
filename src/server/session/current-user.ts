import { readCookie, SESSION_COOKIE } from '../auth/cookies';
import { readSessionUserId } from '../auth/oauth-service';
import type { AuthStore } from '../auth/types';
import { loadConfig, type AppConfig } from '../config/env';

export type CurrentUser =
  | { mode: 'demo'; id: 'demo_user' }
  | { mode: 'unconfigured' }
  | { mode: 'unauthenticated' }
  | { mode: 'oauth'; id: string };

export function resolveCurrentUser(config: AppConfig, sessionUserId: string | undefined): CurrentUser {
  if (config.kind === 'demo') {
    return { mode: 'demo', id: 'demo_user' };
  }
  if (config.kind === 'unconfigured') {
    return { mode: 'unconfigured' };
  }
  if (!sessionUserId) {
    return { mode: 'unauthenticated' };
  }
  return { mode: 'oauth', id: sessionUserId };
}

export async function getCurrentUser(input?: {
  config?: AppConfig;
  store?: AuthStore;
  cookieHeader?: string | null;
  now?: Date;
}): Promise<CurrentUser> {
  const config = input?.config ?? loadConfig();
  if (config.kind !== 'oauth' || !input?.store) {
    return resolveCurrentUser(config, undefined);
  }
  const token = readCookie(input.cookieHeader ?? null, SESSION_COOKIE);
  const userId = await readSessionUserId(input.store, token, input.now);
  return resolveCurrentUser(config, userId);
}
