import assert from 'node:assert/strict';
import test from 'node:test';

import { GET } from '../../app/api/today/route';

test('serves the user-scoped today view without cache or raw records', async () => {
  const response = await GET(new Request('http://localhost:3000/rhythm/api/today'));
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(body.userId, 'demo_user');
  assert.equal(JSON.stringify(body).includes('sourceRecordId'), false);
});
