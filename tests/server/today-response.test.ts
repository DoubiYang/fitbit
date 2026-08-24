import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTodayResponse } from '../../src/server/dashboard/today-response';

test('oauth today responses never fall back to demo_user', async () => {
  const response = await buildTodayResponse({ mode: 'oauth', id: '11111111-1111-1111-1111-111111111111' });
  const body = (await response.json()) as { userId: string };
  assert.equal(response.status, 200);
  assert.equal(body.userId, '11111111-1111-1111-1111-111111111111');
  assert.equal(JSON.stringify(body).includes('demo_user'), false);
});

test('unauthenticated today is 401 and unconfigured is 503', async () => {
  const unauthenticated = await buildTodayResponse({ mode: 'unauthenticated' });
  const unconfigured = await buildTodayResponse({ mode: 'unconfigured' });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unconfigured.status, 503);
  assert.equal(JSON.stringify(await unauthenticated.json()).includes('demo_user'), false);
  assert.equal(JSON.stringify(await unconfigured.json()).includes('demo_user'), false);
});
