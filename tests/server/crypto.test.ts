import assert from 'node:assert/strict';
import test from 'node:test';

import { parseEncryptionKey } from '../../src/server/config/env';
import {
  decryptAesGcm,
  decryptTokenEnvelope,
  decryptWithKeyring,
  encryptAesGcm,
  encryptTokenEnvelope,
  pkceAad,
  tokenAad,
} from '../../src/server/crypto/token-envelope';

const current = parseEncryptionKey(Buffer.alloc(32, 3).toString('base64'));
const previous = parseEncryptionKey(Buffer.alloc(32, 4).toString('base64'));
const plaintext = Buffer.from(JSON.stringify({ accessToken: 'a', refreshToken: 'r' }), 'utf8');

test('round-trips AES-GCM with bound AAD', () => {
  const envelope = encryptAesGcm(plaintext, current, tokenAad('c1', 'u1', 1));
  const decoded = decryptAesGcm(envelope, current, tokenAad('c1', 'u1', 1));
  assert.equal(decoded.toString('utf8'), plaintext.toString('utf8'));
});

test('rejects a tampered auth tag', () => {
  const envelope = encryptAesGcm(plaintext, current, tokenAad('c1', 'u1', 1));
  envelope.authTag[0] ^= 0xff;
  assert.throws(() => decryptAesGcm(envelope, current, tokenAad('c1', 'u1', 1)));
});

test('rejects swapped connection, user, kind, or key version AAD', () => {
  const envelope = encryptAesGcm(plaintext, current, tokenAad('c1', 'u1', 1));
  assert.throws(() => decryptAesGcm(envelope, current, tokenAad('c2', 'u1', 1)));
  assert.throws(() => decryptAesGcm(envelope, current, tokenAad('c1', 'u2', 1)));
  assert.throws(() => decryptAesGcm(envelope, current, pkceAad('c1', 1)));
  assert.throws(() => decryptAesGcm(envelope, current, tokenAad('c1', 'u1', 2)));
});

test('decrypts previous-key envelopes and writes with the current key', () => {
  const oldEnvelope = encryptTokenEnvelope({ accessToken: 'old-a', refreshToken: 'old-r' }, previous, 'c1', 'u1');
  const restored = decryptTokenEnvelope(oldEnvelope, { current, previous }, 'c1', 'u1');
  assert.equal(restored.refreshToken, 'old-r');

  const fresh = encryptTokenEnvelope({ accessToken: 'new-a', refreshToken: 'old-r' }, current, 'c1', 'u1');
  const roundTrip = decryptWithKeyring(fresh, tokenAad('c1', 'u1', 1), current, previous);
  assert.match(roundTrip.toString('utf8'), /new-a/);
});
