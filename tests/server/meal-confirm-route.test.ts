import assert from 'node:assert/strict';
import test from 'node:test';

import { POST } from '../../app/api/meals/drafts/[id]/confirm/route';

test('retired confirm route returns its fixed 410 response before configuration or dependency setup', async () => {
  const response = await POST(
    new Request('http://localhost:3000/rhythm/api/meals/drafts/arbitrary/confirm', { method: 'POST' }),
    { params: Promise.resolve({ id: 'arbitrary' }) },
  );

  assert.equal(response.status, 410);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'meal_confirm_replaced' });
});
