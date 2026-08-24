export const APP_BASE_PATH = '/rhythm';
export const DEFAULT_APP_ORIGIN = 'http://localhost:3000';

export type OAuthConfig = {
  kind: 'oauth';
  databaseUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  appOrigin: string;
  appBasePath: typeof APP_BASE_PATH;
  tokenEncryptionKey: Buffer;
  tokenEncryptionKeyPrevious: Buffer | undefined;
};

export type AppConfig =
  | { kind: 'demo'; appOrigin: string }
  | { kind: 'unconfigured'; reason: string; appOrigin: string }
  | OAuthConfig;

const SECRET_KEYS = [
  'DATABASE_URL',
  'GOOGLE_HEALTH_CLIENT_ID',
  'GOOGLE_HEALTH_CLIENT_SECRET',
  'TOKEN_ENCRYPTION_KEY',
] as const;

export function parseEncryptionKey(value: string, label = 'TOKEN_ENCRYPTION_KEY'): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) {
    throw new Error(`${label} must be base64 that decodes to exactly 32 bytes.`);
  }
  return key;
}

function present(value: string | undefined): value is string {
  return Boolean(value && value.trim() !== '');
}

export function resolveDatabaseUrl(env: NodeJS.Dict<string>): string | undefined {
  if (present(env.DATABASE_URL)) {
    return env.DATABASE_URL.trim();
  }
  if (present(env.POSTGRES_USER) && present(env.POSTGRES_PASSWORD) && present(env.POSTGRES_DB)) {
    const host = present(env.POSTGRES_HOST) ? env.POSTGRES_HOST.trim() : 'db';
    const user = encodeURIComponent(env.POSTGRES_USER.trim());
    const password = encodeURIComponent(env.POSTGRES_PASSWORD.trim());
    const database = encodeURIComponent(env.POSTGRES_DB.trim());
    return `postgresql://${user}:${password}@${host}:5432/${database}`;
  }
  return undefined;
}

function parseOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.pathname !== '/' && url.pathname !== '') {
      return undefined;
    }
    if (url.search || url.hash) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

export function publicPath(origin: string, path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${origin}${APP_BASE_PATH}${suffix}`;
}

function originFromEnv(env: NodeJS.Dict<string>): string {
  return parseOrigin((env.APP_ORIGIN || DEFAULT_APP_ORIGIN).trim()) ?? DEFAULT_APP_ORIGIN;
}

export function loadConfig(env: NodeJS.Dict<string> = process.env): AppConfig {
  const appOrigin = originFromEnv(env);
  const databaseUrl = resolveDatabaseUrl(env);
  const resolved: NodeJS.Dict<string> = {
    ...env,
    DATABASE_URL: databaseUrl,
  };
  const presentSecrets = SECRET_KEYS.filter((key) => present(resolved[key]));
  if (presentSecrets.length === 0) {
    return { kind: 'demo', appOrigin };
  }

  const missing = SECRET_KEYS.filter((key) => !present(resolved[key]));
  if (missing.length > 0) {
    return { kind: 'unconfigured', reason: `missing ${missing.join(', ')}`, appOrigin };
  }

  let tokenEncryptionKey: Buffer;
  try {
    tokenEncryptionKey = parseEncryptionKey(env.TOKEN_ENCRYPTION_KEY ?? '');
  } catch {
    return { kind: 'unconfigured', reason: 'invalid TOKEN_ENCRYPTION_KEY', appOrigin };
  }

  let tokenEncryptionKeyPrevious: Buffer | undefined;
  if (present(env.TOKEN_ENCRYPTION_KEY_PREVIOUS)) {
    try {
      tokenEncryptionKeyPrevious = parseEncryptionKey(env.TOKEN_ENCRYPTION_KEY_PREVIOUS, 'TOKEN_ENCRYPTION_KEY_PREVIOUS');
    } catch {
      return { kind: 'unconfigured', reason: 'invalid TOKEN_ENCRYPTION_KEY_PREVIOUS', appOrigin };
    }
    if (tokenEncryptionKey.equals(tokenEncryptionKeyPrevious)) {
      return { kind: 'unconfigured', reason: 'TOKEN_ENCRYPTION_KEY_PREVIOUS must differ from TOKEN_ENCRYPTION_KEY', appOrigin };
    }
  }

  if (!parseOrigin((env.APP_ORIGIN || DEFAULT_APP_ORIGIN).trim())) {
    return { kind: 'unconfigured', reason: 'invalid APP_ORIGIN', appOrigin };
  }

  return {
    kind: 'oauth',
    databaseUrl: databaseUrl!,
    googleClientId: env.GOOGLE_HEALTH_CLIENT_ID!.trim(),
    googleClientSecret: env.GOOGLE_HEALTH_CLIENT_SECRET!.trim(),
    appOrigin,
    appBasePath: APP_BASE_PATH,
    tokenEncryptionKey,
    tokenEncryptionKeyPrevious,
  };
}

export function redirectUri(config: OAuthConfig): string {
  return publicPath(config.appOrigin, '/api/auth/google/callback');
}

export function isHttpsOrigin(origin: string): boolean {
  return origin.startsWith('https:');
}
