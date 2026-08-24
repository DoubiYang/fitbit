import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAccountView } from '../../src/server/auth/account-view';
import type { ConnectionRow } from '../../src/server/auth/types';

function connection(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: 'c1',
    userId: 'u1',
    healthUserId: 'h1',
    legacyUserId: undefined,
    tokenEnvelopeCiphertext: Buffer.from('x'),
    tokenEnvelopeIv: Buffer.from('y'),
    tokenEnvelopeAuthTag: Buffer.from('z'),
    encryptionKeyVersion: 1,
    accessTokenExpiresAt: new Date('2026-08-24T13:00:00.000Z'),
    refreshTokenExpiresAt: new Date('2026-08-31T12:00:00.000Z'),
    grantedScopes: [],
    status: 'active',
    lastErrorCode: undefined,
    connectedAt: new Date('2026-08-24T10:00:00.000Z'),
    updatedAt: new Date('2026-08-24T10:00:00.000Z'),
    ...overrides,
  };
}

test('treats a past refresh token expiry as expired even if status is still active', () => {
  const view = buildAccountView({
    mode: 'oauth',
    now: new Date('2026-08-24T12:00:00.000Z'),
    connection: connection({ refreshTokenExpiresAt: new Date('2026-08-24T11:00:00.000Z') }),
  });
  assert.equal(view.state, 'expired');
});
