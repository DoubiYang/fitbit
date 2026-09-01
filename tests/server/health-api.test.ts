import assert from 'node:assert/strict';
import test from 'node:test';

import { HEALTH_HIGH_VOLUME_PAGE_SIZE } from '../../src/server/health/filters';
import { createHealthApiClient } from '../../src/server/health/health-api';

async function withMockedFetch<T>(
  handler: (input: string) => Promise<Response>,
  run: () => Promise<T>,
): Promise<{ value: T; urls: string[] }> {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    return handler(url);
  };
  try {
    return { value: await run(), urls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('reconcile requests only the Google wearable data source family', async () => {
  const { urls } = await withMockedFetch(
    async () => Response.json({ dataPoints: [] }),
    () =>
      createHealthApiClient().listDataPoints({
        accessToken: 'access',
        dataType: 'sleep',
        filter: 'sleep.interval.civil_end_time >= "2026-08-01"',
      }),
  );

  assert.equal(new URL(urls[0] ?? '').searchParams.get('dataSourceFamily'), 'users/me/dataSourceFamilies/google-wearables');
});

test('does not turn a reconcile rate limit into a fallback list request', async () => {
  const { urls } = await withMockedFetch(
    async () => new Response('rate limited', { status: 429 }),
    async () => {
      await assert.rejects(
        () =>
          createHealthApiClient().listDataPoints({
            accessToken: 'access',
            dataType: 'sleep',
            filter: 'sleep.interval.civil_end_time >= "2026-08-01"',
          }),
        /health api 429/,
      );
    },
  );

  assert.equal(urls.length, 1);
  assert.match(urls[0] ?? '', /dataPoints:reconcile/);
  assert.equal((urls[0] ?? '').includes('dataPoints:list'), false);
});

test('listDataPoints keeps the low-volume default page size of 25', async () => {
  const { urls } = await withMockedFetch(
    async () => Response.json({ dataPoints: [] }),
    () =>
      createHealthApiClient().listDataPoints({
        accessToken: 'access',
        dataType: 'sleep',
        filter: 'sleep.interval.civil_end_time >= "2026-08-01"',
      }),
  );

  assert.equal(new URL(urls[0] ?? '').searchParams.get('pageSize'), '25');
});

test('listDataPoints rejects every high-volume minute feed instead of collecting pages', async () => {
  const { urls } = await withMockedFetch(
    async () => Response.json({ dataPoints: [{ name: 'should-not-fetch' }] }),
    async () => {
      const client = createHealthApiClient();
      await assert.rejects(
        () =>
          client.listDataPoints({
            accessToken: 'access',
            dataType: 'heart-rate',
            filter: 'heart_rate.sample_time.physical_time >= "2026-08-30T00:00:00.000Z"',
          }),
        /heart-rate must use iterateReconciledDataPoints/,
      );
      await assert.rejects(
        () =>
          client.listDataPoints({
            accessToken: 'access',
            dataType: 'activity-level',
            filter: 'activity_level.interval.start_time >= "2026-08-30T00:00:00.000Z"',
          }),
        /activity-level must use iterateReconciledDataPoints/,
      );
      await assert.rejects(
        () =>
          client.listDataPoints({
            accessToken: 'access',
            dataType: 'time-in-heart-rate-zone',
            filter: 'time_in_heart_rate_zone.interval.start_time >= "2026-08-30T00:00:00.000Z"',
          }),
        /time-in-heart-rate-zone must use iterateReconciledDataPoints/,
      );
    },
  );

  assert.equal(urls.length, 0);
});

test('listDataPoints still concatenates every reconcile page for low-volume types', async () => {
  const { value } = await withMockedFetch(
    async (url) => {
      const token = new URL(url).searchParams.get('pageToken');
      if (!token) {
        return Response.json({ dataPoints: [{ name: 'sleep-1' }], nextPageToken: 'page-2' });
      }
      assert.equal(token, 'page-2');
      return Response.json({ dataPoints: [{ name: 'sleep-2' }] });
    },
    () =>
      createHealthApiClient().listDataPoints({
        accessToken: 'access',
        dataType: 'sleep',
        filter: 'sleep.interval.civil_end_time >= "2026-08-01"',
      }),
  );

  assert.deepEqual(
    value.map((point) => point.name),
    ['sleep-1', 'sleep-2'],
  );
});

test('iterateReconciledDataPoints yields one google-wearables reconcile page at a time', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    const token = new URL(url).searchParams.get('pageToken');
    if (!token) {
      return Response.json({ dataPoints: [{ heartRate: { beatsPerMinute: '72' } }], nextPageToken: 'hr-page-2' });
    }
    assert.equal(token, 'hr-page-2');
    return Response.json({ dataPoints: [{ heartRate: { beatsPerMinute: '80' } }] });
  };

  try {
    const iterator = createHealthApiClient().iterateReconciledDataPoints({
      accessToken: 'access',
      dataType: 'heart-rate',
      filter: 'heart_rate.sample_time.physical_time >= "2026-08-30T00:00:00.000Z"',
      pageSize: HEALTH_HIGH_VOLUME_PAGE_SIZE,
    });
    const first = await iterator.next();

    assert.equal(urls.length, 1);
    const firstUrl = new URL(urls[0] ?? '');
    assert.match(firstUrl.pathname, /\/dataTypes\/heart-rate\/dataPoints:reconcile$/);
    assert.equal(firstUrl.searchParams.get('dataSourceFamily'), 'users/me/dataSourceFamilies/google-wearables');
    assert.equal(firstUrl.searchParams.get('pageSize'), '10000');
    assert.equal(firstUrl.searchParams.get('pageToken'), null);
    assert.equal(first.done, false);
    assert.deepEqual(
      first.value?.map((point) => point.heartRate?.beatsPerMinute),
      ['72'],
    );

    const second = await iterator.next();
    assert.equal(urls.length, 2);
    assert.equal(new URL(urls[1] ?? '').searchParams.get('pageToken'), 'hr-page-2');
    assert.deepEqual(
      second.value?.map((point) => point.heartRate?.beatsPerMinute),
      ['80'],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('iterateReconciledDataPoints does not prefetch later pages when the consumer stops', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return Response.json({ dataPoints: [{ name: `page-${urls.length}` }], nextPageToken: 'unused-next' });
  };

  try {
    const iterator = createHealthApiClient().iterateReconciledDataPoints({
      accessToken: 'access',
      dataType: 'heart-rate',
      filter: 'heart_rate.sample_time.physical_time >= "2026-08-30T00:00:00.000Z"',
      pageSize: HEALTH_HIGH_VOLUME_PAGE_SIZE,
    });
    const first = await iterator.next();
    assert.equal(first.value?.[0]?.name, 'page-1');
    assert.equal(urls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(urls.length, 1);
});

test('iterateReconciledDataPoints defaults every high-volume minute feed to pageSize 10000', async () => {
  const { urls } = await withMockedFetch(
    async () => Response.json({ dataPoints: [] }),
    async () => {
      const client = createHealthApiClient();
      await client
        .iterateReconciledDataPoints({
          accessToken: 'access',
          dataType: 'heart-rate',
          filter: 'heart_rate.sample_time.physical_time >= "2026-08-30T00:00:00.000Z"',
        })
        .next();
      await client
        .iterateReconciledDataPoints({
          accessToken: 'access',
          dataType: 'time-in-heart-rate-zone',
          filter: 'time_in_heart_rate_zone.interval.start_time >= "2026-08-30T00:00:00.000Z"',
        })
        .next();
      await client
        .iterateReconciledDataPoints({
          accessToken: 'access',
          dataType: 'activity-level',
          filter: 'activity_level.interval.start_time >= "2026-08-30T00:00:00.000Z"',
        })
        .next();
    },
  );

  assert.equal(new URL(urls[0] ?? '').searchParams.get('pageSize'), '10000');
  assert.equal(new URL(urls[1] ?? '').searchParams.get('pageSize'), '10000');
  assert.equal(new URL(urls[2] ?? '').searchParams.get('pageSize'), '10000');
  assert.equal(HEALTH_HIGH_VOLUME_PAGE_SIZE, 10_000);
});

test('explicit iterate pageSize still wins over the high-volume default', async () => {
  const { urls } = await withMockedFetch(
    async () => Response.json({ dataPoints: [] }),
    () =>
      createHealthApiClient()
        .iterateReconciledDataPoints({
          accessToken: 'access',
          dataType: 'time-in-heart-rate-zone',
          filter: 'time_in_heart_rate_zone.interval.start_time >= "2026-08-30T00:00:00.000Z"',
          pageSize: 50,
        })
        .next(),
  );

  assert.equal(new URL(urls[0] ?? '').searchParams.get('pageSize'), '50');
});

test('iterateReconciledDataPoints does not fall back to list after a 429', async () => {
  const { urls } = await withMockedFetch(
    async () => new Response('rate limited', { status: 429 }),
    async () => {
      await assert.rejects(
        () =>
          createHealthApiClient()
            .iterateReconciledDataPoints({
              accessToken: 'access',
              dataType: 'heart-rate',
              filter: 'heart_rate.sample_time.physical_time >= "2026-08-30T00:00:00.000Z"',
              pageSize: HEALTH_HIGH_VOLUME_PAGE_SIZE,
            })
            .next(),
        /health api 429/,
      );
    },
  );

  assert.equal(urls.length, 1);
  assert.match(urls[0] ?? '', /dataPoints:reconcile/);
  assert.equal((urls[0] ?? '').includes('dataPoints:list'), false);
});
