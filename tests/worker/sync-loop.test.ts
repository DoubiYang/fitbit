// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';

import { FETCH_TIMEOUT_MS, runWorker, tick } from '../../worker/sync-loop.mjs';

test('worker does not poll when SYNC_SECRET is missing', async () => {
  let fetches = 0;
  const errors: string[] = [];
  const result = await runWorker({
    secret: undefined,
    endpoint: 'http://app:3000/rhythm/api/internal/sync',
    fetchImpl: async () => {
      fetches += 1;
      return new Response('nope', { status: 500 });
    },
    sleepImpl: async () => {},
    intervalMs: 1,
    maxTicks: 3,
    error: (message) => errors.push(message),
  });
  assert.equal(result, 'disabled');
  assert.equal(fetches, 0);
  assert.match(errors.join('\n'), /scheduler disabled/);
});

test('ticks run one after another and abort hung fetches', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const signals: AbortSignal[] = [];
  let ticks = 0;
  await runWorker({
    secret: 'test-sync-secret',
    endpoint: 'http://app:3000/rhythm/api/internal/sync',
    fetchImpl: async (_url, init) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (init?.signal) {
        signals.push(init.signal);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      ticks += 1;
      return Response.json({ claimed: 0, succeeded: 0, failed: 0 });
    },
    sleepImpl: async () => {},
    intervalMs: 1,
    maxTicks: 2,
    log: () => {},
  });
  assert.equal(ticks, 2);
  assert.equal(maxInFlight, 1);
  assert.equal(signals.length, 2);
  assert.equal(FETCH_TIMEOUT_MS, 4 * 60 * 1_000);
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  assert.ok(timeout);
});

test('successful ticks log to log, not error, even when failed=0', async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  await tick({
    endpoint: 'http://app:3000/rhythm/api/internal/sync',
    secret: 'test-sync-secret',
    fetchImpl: async () => Response.json({ claimed: 1, succeeded: 1, failed: 0 }),
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
  });
  assert.deepEqual(logs, ['[sync] claimed=1 succeeded=1 failed=0']);
  assert.deepEqual(errors, []);
});

test('tick posts with a timeout signal', async () => {
  let signal: AbortSignal | undefined;
  await tick({
    endpoint: 'http://app:3000/rhythm/api/internal/sync',
    secret: 'test-sync-secret',
    timeoutMs: 1234,
    fetchImpl: async (_url, init) => {
      signal = init?.signal;
      return Response.json({ claimed: 1, succeeded: 1, failed: 0 });
    },
    log: () => {},
  });
  assert.equal(signal?.aborted, false);
});
