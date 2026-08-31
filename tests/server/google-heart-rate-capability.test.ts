import assert from 'node:assert/strict';
import test from 'node:test';

import { probeGoogleHeartRateCapabilities } from '../../scripts/probe-google-heart-rate';

const ACCESS_TOKEN = 'ya29.secret-probe-token-do-not-print';
const DATA_POINT_NAME = 'users/me/dataTypes/heart-rate/dataPoints/hr-secret-9f3a';
const SAMPLE_TIMESTAMP = '2026-08-30T23:41:17.456Z';
const ACTIVITY_START = '2026-08-31T17:51:00.000Z';
const ACTIVITY_END = '2026-08-31T17:52:00.000Z';
const ZONE_MIN = '97';
const ZONE_MAX = '116';
const BPM = '73';
const FULL_RESPONSE_MARK = 'full-response-secret';
const NOW = new Date('2026-08-31T18:00:00.000Z');

function captureConsole(run: () => Promise<unknown>): Promise<{ value: unknown; printed: string }> {
  const chunks: string[] = [];
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const sink = (...args: unknown[]) => {
    chunks.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  };
  console.log = sink;
  console.info = sink;
  console.warn = sink;
  console.error = sink;
  console.debug = sink;
  return run()
    .then((value) => ({ value, printed: chunks.join('\n') }))
    .finally(() => {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
      console.debug = original.debug;
    });
}

function assertRedacted(printed: string): void {
  assert.equal(printed.includes(ACCESS_TOKEN), false);
  assert.equal(printed.includes(DATA_POINT_NAME), false);
  assert.equal(printed.includes('users/me/dataTypes'), false);
  assert.equal(printed.includes(SAMPLE_TIMESTAMP), false);
  assert.equal(printed.includes(ACTIVITY_START), false);
  assert.equal(printed.includes(ACTIVITY_END), false);
  assert.equal(printed.includes(BPM), false);
  assert.equal(printed.includes(ZONE_MIN), false);
  assert.equal(printed.includes(ZONE_MAX), false);
  assert.equal(printed.includes('"beatsPerMinute"'), false);
  assert.equal(printed.includes('"minBeatsPerMinute"'), false);
  assert.equal(printed.includes('"maxBeatsPerMinute"'), false);
  assert.equal(printed.includes('"physicalTime"'), false);
  assert.equal(printed.includes('"dataPoints"'), false);
  assert.equal(printed.includes(FULL_RESPONSE_MARK), false);
  assert.equal(printed.includes('"ACTIVE"'), false);
}

test('capability probe reports labels and counts without tokens, BPM, names, timestamps, or raw bodies', async () => {
  const captured = await captureConsole(() =>
    probeGoogleHeartRateCapabilities({
      accessToken: ACCESS_TOKEN,
      now: NOW,
      api: {
        async listDataPoints(input) {
          assert.equal(input.accessToken, ACCESS_TOKEN);
          if (input.dataType === 'heart-rate') {
            return [
              {
                name: DATA_POINT_NAME,
                heartRate: {
                  sampleTime: { physicalTime: SAMPLE_TIMESTAMP, utcOffset: '28800s' },
                  beatsPerMinute: BPM,
                  metadata: { motionContext: 'ACTIVE' },
                },
              },
              {
                heartRate: {
                  sampleTime: { physicalTime: '2026-08-30T23:41:20.456Z', utcOffset: '28800s' },
                  beatsPerMinute: '118',
                },
              },
            ];
          }
          if (input.dataType === 'activity-level') {
            return [
              {
                name: 'users/me/dataTypes/activity-level/dataPoints/al-secret',
                activityLevel: {
                  interval: { startTime: ACTIVITY_START, endTime: ACTIVITY_END },
                  activityLevelType: 'SEDENTARY',
                },
              },
              {
                activityLevel: {
                  interval: { startTime: '2026-08-31T17:52:00.000Z', endTime: '2026-08-31T17:53:00.000Z' },
                  activityLevelType: 'LIGHTLY_ACTIVE',
                },
              },
            ];
          }
          if (input.dataType === 'daily-heart-rate-zones') {
            return [
              {
                name: 'users/me/dataTypes/daily-heart-rate-zones/dataPoints/zones-secret',
                dailyHeartRateZones: {
                  date: { year: 2026, month: 8, day: 31 },
                  heartRateZones: [
                    { heartRateZoneType: 'LIGHT', minBeatsPerMinute: ZONE_MIN, maxBeatsPerMinute: ZONE_MAX },
                    { heartRateZoneType: 'MODERATE', minBeatsPerMinute: '117', maxBeatsPerMinute: '136' },
                    { heartRateZoneType: 'VIGOROUS', minBeatsPerMinute: '137', maxBeatsPerMinute: '156' },
                    { heartRateZoneType: 'PEAK', minBeatsPerMinute: '157', maxBeatsPerMinute: '196' },
                  ],
                },
              },
            ];
          }
          if (input.dataType === 'time-in-heart-rate-zone') {
            return [
              {
                name: 'users/me/dataTypes/time-in-heart-rate-zone/dataPoints/tiz-secret',
                timeInHeartRateZone: {
                  interval: { startTime: ACTIVITY_START, endTime: ACTIVITY_END },
                  heartRateZoneType: 'LIGHT',
                },
              },
            ];
          }
          return [];
        },
      },
    }),
  );

  const report = captured.value as Awaited<ReturnType<typeof probeGoogleHeartRateCapabilities>>;
  const printed = `${JSON.stringify(report, null, 2)}\n${captured.printed}`;

  assert.equal(report.heartRate.available, true);
  assert.equal(report.heartRate.pointCount, 2);
  assert.equal(report.heartRate.hasMotionContext, true);
  assert.equal(report.activityLevel.available, true);
  assert.equal(report.activityLevel.intervalCount, 2);
  assert.deepEqual(report.activityLevel.types, ['SEDENTARY', 'LIGHTLY_ACTIVE']);
  assert.equal(report.dailyHeartRateZones.available, true);
  assert.equal(report.dailyHeartRateZones.dayCount, 1);
  assert.deepEqual(report.dailyHeartRateZones.dates, ['2026-08-31']);
  assert.deepEqual(report.dailyHeartRateZones.zoneLabels, ['LIGHT', 'MODERATE', 'VIGOROUS', 'PEAK']);
  assert.equal(report.timeInHeartRateZone.available, true);
  assert.equal(report.timeInHeartRateZone.intervalCount, 1);
  assert.deepEqual(report.timeInHeartRateZone.zoneLabels, ['LIGHT']);
  assert.equal(report.sourceFamily, 'google-wearables');
  assertRedacted(printed);
});

test('capability probe reconciles google-wearables with snake_case filters', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return Response.json({
      dataPoints: [],
      debugDump: FULL_RESPONSE_MARK,
      nextPageToken: undefined,
    });
  };
  try {
    const captured = await captureConsole(() =>
      probeGoogleHeartRateCapabilities({ accessToken: ACCESS_TOKEN, now: NOW }),
    );
    const report = captured.value as Awaited<ReturnType<typeof probeGoogleHeartRateCapabilities>>;
    const printed = `${JSON.stringify(report, null, 2)}\n${captured.printed}`;
    assertRedacted(printed);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(urls.length, 4);
  const byType = Object.fromEntries(
    ['heart-rate', 'activity-level', 'daily-heart-rate-zones', 'time-in-heart-rate-zone'].map((dataType) => {
      const url = urls.find((value) => value.includes(`/dataTypes/${dataType}/`));
      assert.ok(url, `missing ${dataType} request`);
      return [dataType, new URL(url)];
    }),
  );

  for (const url of Object.values(byType)) {
    assert.match(url.pathname, /dataPoints:reconcile$/);
    assert.equal(url.searchParams.get('dataSourceFamily'), 'users/me/dataSourceFamilies/google-wearables');
  }

  assert.match(byType['heart-rate'].searchParams.get('filter') ?? '', /heart_rate\.sample_time\.physical_time/);
  assert.match(byType['activity-level'].searchParams.get('filter') ?? '', /activity_level\.interval\.start_time/);
  assert.match(byType['daily-heart-rate-zones'].searchParams.get('filter') ?? '', /daily_heart_rate_zones\.date/);
  assert.match(byType['time-in-heart-rate-zone'].searchParams.get('filter') ?? '', /time_in_heart_rate_zone\.interval\.start_time/);

  const allFilters = urls.map((value) => new URL(value).searchParams.get('filter') ?? '').join('\n');
  assert.equal(allFilters.includes('heartRate'), false);
  assert.equal(allFilters.includes('activityLevel'), false);
  assert.equal(allFilters.includes('sampleTime'), false);
  assert.equal(allFilters.includes('startTime'), false);
  assert.equal(allFilters.includes('physicalTime'), false);
});

function zonesWithOneBpmGap() {
  return [
    { heartRateZoneType: 'LIGHT', minBeatsPerMinute: '97', maxBeatsPerMinute: '116' },
    { heartRateZoneType: 'MODERATE', minBeatsPerMinute: '117', maxBeatsPerMinute: '136' },
    { heartRateZoneType: 'VIGOROUS', minBeatsPerMinute: '137', maxBeatsPerMinute: '156' },
    { heartRateZoneType: 'PEAK', minBeatsPerMinute: '157', maxBeatsPerMinute: '196' },
  ];
}

function zonesWithSharedBoundary() {
  return [
    { heartRateZoneType: 'LIGHT', minBeatsPerMinute: '97', maxBeatsPerMinute: '117' },
    { heartRateZoneType: 'MODERATE', minBeatsPerMinute: '117', maxBeatsPerMinute: '137' },
    { heartRateZoneType: 'VIGOROUS', minBeatsPerMinute: '137', maxBeatsPerMinute: '157' },
    { heartRateZoneType: 'PEAK', minBeatsPerMinute: '157', maxBeatsPerMinute: '196' },
  ];
}

test('Fitbit Air-shaped points report no motionContext, a 1 bpm zone gap, and 60s time-in-zone without duration', async () => {
  const report = await probeGoogleHeartRateCapabilities({
    accessToken: ACCESS_TOKEN,
    now: NOW,
    api: {
      async listDataPoints(input) {
        if (input.dataType === 'heart-rate') {
          return [
            {
              heartRate: {
                sampleTime: { physicalTime: SAMPLE_TIMESTAMP, utcOffset: '28800s' },
                beatsPerMinute: BPM,
              },
            },
          ];
        }
        if (input.dataType === 'daily-heart-rate-zones') {
          return [
            {
              dailyHeartRateZones: {
                date: { year: 2026, month: 8, day: 31 },
                heartRateZones: zonesWithOneBpmGap(),
              },
            },
          ];
        }
        if (input.dataType === 'time-in-heart-rate-zone') {
          return [
            {
              timeInHeartRateZone: {
                interval: { startTime: ACTIVITY_START, endTime: ACTIVITY_END },
                heartRateZoneType: 'LIGHT',
              },
            },
          ];
        }
        return [];
      },
    },
  });

  assert.equal(report.heartRate.hasMotionContext, false);
  assert.equal(report.dailyHeartRateZones.adjacentZonesHaveOneBpmGap, true);
  assert.equal(report.timeInHeartRateZone.hasDurationField, false);
  assert.equal(report.timeInHeartRateZone.intervalSeconds.includes(60), true);
});

test('shared zone boundaries are not reported as a 1 bpm gap', async () => {
  const report = await probeGoogleHeartRateCapabilities({
    accessToken: ACCESS_TOKEN,
    now: NOW,
    api: {
      async listDataPoints(input) {
        if (input.dataType === 'daily-heart-rate-zones') {
          return [
            {
              dailyHeartRateZones: {
                date: { year: 2026, month: 8, day: 31 },
                heartRateZones: zonesWithSharedBoundary(),
              },
            },
          ];
        }
        return [];
      },
    },
  });

  assert.equal(report.dailyHeartRateZones.adjacentZonesHaveOneBpmGap, false);
});

test('daily heart-rate-zones window includes UTC+8 local today', async () => {
  let dailyFilter = '';
  await probeGoogleHeartRateCapabilities({
    accessToken: ACCESS_TOKEN,
    now: NOW,
    api: {
      async listDataPoints(input) {
        if (input.dataType === 'daily-heart-rate-zones') {
          dailyFilter = input.filter;
        }
        return [];
      },
    },
  });

  const bounds = /daily_heart_rate_zones\.date >= "(\d{4}-\d{2}-\d{2})" AND daily_heart_rate_zones\.date < "(\d{4}-\d{2}-\d{2})"/.exec(
    dailyFilter,
  );
  assert.ok(bounds, `daily filter was ${dailyFilter}`);
  const from = bounds[1] ?? '';
  const untilExclusive = bounds[2] ?? '';
  assert.ok(
    from <= '2026-09-01' && untilExclusive > '2026-09-01',
    `expected ${from} <= 2026-09-01 < ${untilExclusive} so UTC+8 local today is included`,
  );
});

test('capability probe fails closed on a Health API error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('rate limited', { status: 429 });
  try {
    await assert.rejects(
      () => probeGoogleHeartRateCapabilities({ accessToken: ACCESS_TOKEN, now: NOW }),
      /health api 429/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
