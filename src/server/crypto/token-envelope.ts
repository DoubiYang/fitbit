import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
export const CURRENT_KEY_VERSION = 1;

export type AesGcmEnvelope = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
};

export function tokenAad(connectionId: string, userId: string, keyVersion: number): string {
  return `${connectionId}|${userId}|token-v1|${keyVersion}`;
}

export function pkceAad(transactionId: string, keyVersion: number): string {
  return `${transactionId}|pkce-v1|${keyVersion}`;
}

export function encryptAesGcm(plaintext: Buffer, key: Buffer, aad: string, iv: Buffer = randomBytes(IV_LENGTH)): AesGcmEnvelope {
  if (key.length !== 32) {
    throw new Error('AES-256-GCM key must be 32 bytes.');
  }
  if (iv.length !== IV_LENGTH) {
    throw new Error('AES-256-GCM iv must be 12 bytes.');
  }

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('AES-256-GCM auth tag must be 16 bytes.');
  }
  return { ciphertext, iv, authTag };
}

export function decryptAesGcm(envelope: AesGcmEnvelope, key: Buffer, aad: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, envelope.iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(envelope.authTag);
  return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
}

export function decryptWithKeyring(envelope: AesGcmEnvelope, aad: string, current: Buffer, previous: Buffer | undefined): Buffer {
  try {
    return decryptAesGcm(envelope, current, aad);
  } catch (error) {
    if (!previous) {
      throw error;
    }
    return decryptAesGcm(envelope, previous, aad);
  }
}

export type TokenEnvelopePlaintext = {
  accessToken: string;
  refreshToken: string;
};

export function encryptTokenEnvelope(
  plaintext: TokenEnvelopePlaintext,
  key: Buffer,
  connectionId: string,
  userId: string,
  keyVersion = CURRENT_KEY_VERSION,
): AesGcmEnvelope {
  return encryptAesGcm(Buffer.from(JSON.stringify(plaintext), 'utf8'), key, tokenAad(connectionId, userId, keyVersion));
}

export function decryptTokenEnvelope(
  envelope: AesGcmEnvelope,
  keyring: { current: Buffer; previous?: Buffer },
  connectionId: string,
  userId: string,
  keyVersion = CURRENT_KEY_VERSION,
): TokenEnvelopePlaintext {
  const parsed = JSON.parse(
    decryptWithKeyring(envelope, tokenAad(connectionId, userId, keyVersion), keyring.current, keyring.previous).toString('utf8'),
  ) as TokenEnvelopePlaintext;
  if (!parsed.accessToken || !parsed.refreshToken) {
    throw new Error('token envelope missing fields');
  }
  return parsed;
}

export function encryptPkceVerifier(verifier: string, key: Buffer, transactionId: string, keyVersion = CURRENT_KEY_VERSION): AesGcmEnvelope {
  return encryptAesGcm(Buffer.from(verifier, 'utf8'), key, pkceAad(transactionId, keyVersion));
}

export function decryptPkceVerifier(
  envelope: AesGcmEnvelope,
  keyring: { current: Buffer; previous?: Buffer },
  transactionId: string,
  keyVersion = CURRENT_KEY_VERSION,
): string {
  return decryptWithKeyring(envelope, pkceAad(transactionId, keyVersion), keyring.current, keyring.previous).toString('utf8');
}
