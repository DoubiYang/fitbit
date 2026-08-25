import assert from 'node:assert/strict';
import test from 'node:test';

import { hasValidSyncBearerToken } from '../../src/server/health/sync-auth';

test('internal sync requires an exact bearer secret', () => {
  const secret = '2e9e56ce2ee5b4374d8e5bcf8df0f32a3f1ab6789e1b7f4aa03edfbd827a3045';
  assert.equal(hasValidSyncBearerToken(undefined, secret), false);
  assert.equal(hasValidSyncBearerToken('Bearer wrong-secret', secret), false);
  assert.equal(hasValidSyncBearerToken(`Bearer ${secret}`, secret), true);
});
