import { timingSafeEqual } from 'node:crypto';

export function hasValidSyncBearerToken(value: string | undefined, secret: string): boolean {
  if (!value?.startsWith('Bearer ')) {
    return false;
  }
  const supplied = Buffer.from(value.slice('Bearer '.length), 'utf8');
  const expected = Buffer.from(secret, 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
