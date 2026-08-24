export const SESSION_COOKIE = 'rhythm_session';
export const OAUTH_TX_COOKIE = 'rhythm_oauth_tx';
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const OAUTH_TX_TTL_MS = 10 * 60 * 1000;

export type CookieOptions = {
  path: string;
  maxAgeSeconds: number;
  secure: boolean;
  httpOnly?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
};

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${value}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAgeSeconds}`,
    `SameSite=${options.sameSite ?? 'Lax'}`,
  ];
  if (options.httpOnly !== false) {
    parts.push('HttpOnly');
  }
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function expireCookie(name: string, path: string, secure: boolean): string {
  return serializeCookie(name, '', { path, maxAgeSeconds: 0, secure });
}

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === name) {
      return rest.join('=');
    }
  }
  return undefined;
}

export function cookiePath(): string {
  return '/rhythm';
}
