import assert from 'node:assert/strict';
import test from 'node:test';

import { createHealthApiClient } from '../../src/server/health/health-api';

test('reconcile requests only the Google wearable data source family', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return Response.json({ dataPoints: [] });
  };
  try {
    await createHealthApiClient().listDataPoints({
      accessToken: 'access',
      dataType: 'sleep',
      filter: 'sleep.interval.civil_end_time >= "2026-08-01"',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(new URL(urls[0] ?? '').searchParams.get('dataSourceFamily'), 'users/me/dataSourceFamilies/google-wearables');
});

test('does not turn a reconcile rate limit into a fallback list request', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('rate limited', { status: 429 });
  };
  try {
    await assert.rejects(
      () =>
        createHealthApiClient().listDataPoints({
          accessToken: 'access',
          dataType: 'sleep',
          filter: 'sleep.interval.civil_end_time >= "2026-08-01"',
        }),
      /health api 429/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls, 1);
});
