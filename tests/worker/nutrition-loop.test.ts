// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';

import { runWorker, tick } from '../../worker/nutrition-loop.mjs';

test('nutrition worker does not poll when SYNC_SECRET is missing', async () => {
  let fetches = 0;
  const errors: string[] = [];
  const result = await runWorker({
    secret: undefined,
    endpoint: 'http://app:3000/rhythm/api/internal/nutrition-sync',
    fetchImpl: async () => {
      fetches += 1;
      return new Response('nope', { status: 500 });
    },
    error: (message) => errors.push(message),
  });
  assert.equal(result, 'disabled');
  assert.equal(fetches, 0);
  assert.match(errors.join('\n'), /scheduler disabled/);
});

test('nutrition tick posts only a bearer token and aggregate counts', async () => {
  let authorization: string | undefined;
  const logs: string[] = [];
  await tick({
    endpoint: 'http://app:3000/rhythm/api/internal/nutrition-sync',
    secret: 'test-sync-secret',
    fetchImpl: async (_url, init) => {
      authorization = init?.headers?.Authorization;
      return Response.json({ claimed: 2, succeeded: 1, failed: 0, retrying: 1, unknown: 0 });
    },
    log: (message) => logs.push(message),
  });
  assert.equal(authorization, 'Bearer test-sync-secret');
  assert.deepEqual(logs, ['[nutrition-sync] claimed=2 succeeded=1 failed=0 retrying=1 unknown=0']);
  assert.equal(logs.join('').includes('payload'), false);
});
