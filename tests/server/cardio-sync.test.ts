import assert from 'node:assert/strict';
import test from 'node:test';

import { parseHeartRateMinuteAggregate, parseSleepGoal } from '../../src/domain/cardio-records';
import { parseDailyHrv, parseDailyRhr, parseSleepSession } from '../../src/domain/health-records';
import { WHOOP_STYLE_METRIC_VERSION } from '../../src/domain/metric-types';
import type { ConnectionRow } from '../../src/server/auth/types';
import { createMemoryStore } from '../../src/server/db/memory-store';
import {
  connectionNextSyncAt,
  recomputeAffectedDays,
  syncCardioConnection,
  type CardioSyncState,
} from '../../src/server/health/cardio-sync';
import type { HealthSyncDataType } from '../../src/server/health/cardio-store';
import { HEART_RATE_ACTIVITY_LEVEL_PAGE_SIZE } from '../../src/server/health/filters';
import type { HealthApiClient } from '../../src/server/health/health-api';
import type { GoogleDataPoint } from '../../src/server/health/map-records';
import { emptyUserHealthRecords, type UserHealthRecords } from '../../src/server/health/provider';

const userId = 'u1';
const connectionId = 'c1';
const NOW = new Date('2026-08-24T12:00:00.000Z');
const INITIAL_HR_FROM = '2026-07-18T12:00:00.000Z';
const ZONES = {
  LIGHT: { minBeatsPerMinute: '97', maxBeatsPerMinute: '116' },
  MODERATE: { minBeatsPerMinute: '117', maxBeatsPerMinute: '136' },
  VIGOROUS: { minBeatsPerMinute: '137', maxBeatsPerMinute: '155' },
  PEAK: { minBeatsPerMinute: '156', maxBeatsPerMinute: '200' },
} as const;

type PageOrError = GoogleDataPoint[] | Error;
type RecordedRequest = { dataType: string; filter: string; pageSize?: number };

function connection(): ConnectionRow {
  return {
    id: connectionId,
    userId,
    healthUserId: 'h1',
    legacyUserId: undefined,
    tokenEnvelopeCiphertext: Buffer.from('ciphertext'),
    tokenEnvelopeIv: Buffer.alloc(12),
    tokenEnvelopeAuthTag: Buffer.alloc(16),
    encryptionKeyVersion: 1,
    accessTokenExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    refreshTokenExpiresAt: new Date('2099-01-08T00:00:00.000Z'),
    grantedScopes: [],
    status: 'active',
    lastErrorCode: undefined,
    connectedAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    lastSuccessfulSyncAt: undefined,
  };
}

function addCivilDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function civilParts(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split('-').map(Number);
  return { year, month, day };
}

function filterBounds(filter: string): { from: string; untilExclusive: string } {
  const from = filter.match(/>= "([^"]+)"/)?.[1];
  const untilExclusive = filter.match(/< "([^"]+)"/)?.[1];
  assert.ok(from && untilExclusive, filter);
  return { from, untilExclusive };
}

function requestFor(requests: RecordedRequest[], dataType: string): RecordedRequest {
  const match = requests.find((request) => request.dataType === dataType);
  assert.ok(match, `missing request for ${dataType}`);
  return match;
}

function hrPoint(physicalTime: string, bpm: number, utcOffset = '0s'): GoogleDataPoint {
  return {
    heartRate: {
      sampleTime: { physicalTime, utcOffset },
      beatsPerMinute: String(bpm),
    },
  };
}

function activityPoint(startTime: string, activityLevelType: string, durationMs = 60_000): GoogleDataPoint {
  return {
    activityLevel: {
      interval: {
        startTime,
        endTime: new Date(Date.parse(startTime) + durationMs).toISOString(),
      },
      activityLevelType,
    },
  };
}

function zonesPoint(date: string): GoogleDataPoint {
  return {
    dailyHeartRateZones: {
      date: civilParts(date),
      heartRateZones: Object.entries(ZONES).map(([heartRateZoneType, bounds]) => ({
        heartRateZoneType,
        ...bounds,
      })),
    },
  };
}

function timeInZonePoint(startTime: string, heartRateZoneType = 'LIGHT', utcOffset = '0s'): GoogleDataPoint {
  return {
    timeInHeartRateZone: {
      interval: {
        startTime,
        endTime: new Date(Date.parse(startTime) + 60_000).toISOString(),
        startUtcOffset: utcOffset,
      },
      heartRateZoneType,
    },
  };
}

function exercisePoint(startTime: string, date: string, id = 'exercise-1'): GoogleDataPoint {
  return {
    name: id,
    exercise: {
      interval: {
        startTime,
        endTime: new Date(Date.parse(startTime) + 60_000).toISOString(),
        startUtcOffset: '0s',
        civilStartTime: { date: civilParts(date) },
      },
    },
  };
}

function sleepSession(civilEndDate: string, overrides: Partial<{ startTime: string; endTime: string; minutesAsleep: number }> = {}) {
  return parseSleepSession({
    userId,
    source: 'google_health',
    sourceRecordId: `sleep-${civilEndDate}`,
    id: `sleep-${civilEndDate}`,
    startTime: overrides.startTime ?? `${addCivilDays(civilEndDate, -1)}T22:00:00.000Z`,
    endTime: overrides.endTime ?? `${civilEndDate}T06:00:00.000Z`,
    civilEndDate,
    utcOffsetMinutes: 0,
    minutesAsleep: overrides.minutesAsleep ?? 420,
    timeInBedMinutes: 480,
    awakeMinutes: 60,
    isNap: false,
    processed: true,
  });
}

function createFakeApi(initial: Partial<Record<string, PageOrError[]>> = {}) {
  const requests: RecordedRequest[] = [];
  const pages = new Map<string, PageOrError[]>();
  for (const [dataType, sequence] of Object.entries(initial)) {
    if (sequence) {
      pages.set(dataType, sequence);
    }
  }
  const afterPage1 = new Map<string, () => Promise<void>>();

  async function* iterate(input: { dataType: string; filter: string; pageSize?: number }) {
    requests.push({ dataType: input.dataType, filter: input.filter, pageSize: input.pageSize });
    const sequence = pages.get(input.dataType) ?? [[]];
    for (const [index, page] of sequence.entries()) {
      if (page instanceof Error) {
        throw page;
      }
      yield page;
      const hook = afterPage1.get(input.dataType);
      if (index === 0 && hook) {
        await hook();
      }
    }
  }

  const api: HealthApiClient & {
    requests: RecordedRequest[];
    setPages: (dataType: string, sequence: PageOrError[]) => void;
    onAfterFirstPage: (dataType: string, hook: () => Promise<void>) => void;
    resetRequests: () => void;
  } = {
    requests,
    setPages(dataType, sequence) {
      pages.set(dataType, sequence);
    },
    onAfterFirstPage(dataType, hook) {
      afterPage1.set(dataType, hook);
    },
    resetRequests() {
      requests.length = 0;
    },
    async *iterateReconciledDataPoints(input) {
      yield* iterate(input);
    },
    async listDataPoints(input) {
      if (input.dataType === 'heart-rate' || input.dataType === 'activity-level') {
        throw new Error(`${input.dataType} must use iterateReconciledDataPoints`);
      }
      const collected: GoogleDataPoint[] = [];
      for await (const page of iterate(input)) {
        collected.push(...page);
      }
      return collected;
    },
  };
  return api;
}

async function seedStore(options: { timeZone?: string; goal?: boolean } = {}) {
  const store = createMemoryStore();
  await store.users.insert(userId);
  await store.connections.insert(connection());
  if (options.timeZone) {
    await store.healthMetrics.insertTimeZoneHistory({
      userId,
      ianaTimeZone: options.timeZone,
      effectiveAt: '2026-01-01T00:00:00.000Z',
      isBackfillAnchor: true,
    });
  }
  if (options.goal) {
    await store.healthMetrics.insertSleepGoal(parseSleepGoal({ userId, goalMinutes: 480, effectiveCivilDate: '2026-08-01' }));
  }
  return store;
}

async function runSync(
  store: ReturnType<typeof createMemoryStore>,
  api: HealthApiClient,
  options: {
    now?: Date;
    records?: UserHealthRecords;
    dataTypes?: HealthSyncDataType[];
    extraDates?: string[];
    lastSuccessfulSyncAt?: Date;
  } = {},
): Promise<CardioSyncState> {
  const row = await store.connections.findByUserId(userId);
  assert.ok(row);
  return syncCardioConnection({
    store,
    connection: row,
    api,
    accessToken: 'access',
    now: options.now ?? NOW,
    dataTypes: options.dataTypes,
    extraDates: options.extraDates,
    lastSuccessfulSyncAt: options.lastSuccessfulSyncAt,
    loadRecords: async () => options.records ?? emptyUserHealthRecords(),
  });
}

function containsRawPoint(value: unknown): boolean {
  const json = JSON.stringify(value);
  return json.includes('beatsPerMinute') || json.includes('"heartRate"') || json.includes('dataPoints');
}

test('initial raw HR and activity-level windows are now minus 37 days through now', async () => {
  const store = await seedStore();
  const api = createFakeApi();
  await runSync(store, api);

  const heartRate = filterBounds(requestFor(api.requests, 'heart-rate').filter);
  const activity = filterBounds(requestFor(api.requests, 'activity-level').filter);
  assert.equal(heartRate.from, INITIAL_HR_FROM);
  assert.equal(heartRate.untilExclusive, NOW.toISOString());
  assert.deepEqual(activity, heartRate);
  assert.equal(requestFor(api.requests, 'heart-rate').pageSize, HEART_RATE_ACTIVITY_LEVEL_PAGE_SIZE);
  assert.equal(requestFor(api.requests, 'activity-level').pageSize, HEART_RATE_ACTIVITY_LEVEL_PAGE_SIZE);
});

test('initial daily zone window is UTC date minus 36 days to plus 1 day exclusive, not Asia/Shanghai', async () => {
  const store = await seedStore();
  const api = createFakeApi();
  const now = new Date('2026-08-23T23:00:00.000Z');
  await runSync(store, api, { now });

  const zones = filterBounds(requestFor(api.requests, 'daily-heart-rate-zones').filter);
  assert.equal(zones.from, '2026-07-18');
  assert.equal(zones.untilExclusive, '2026-08-24');
  assert.notEqual(zones.from, '2026-07-19');
  assert.notEqual(zones.untilExclusive, '2026-08-25');
  assert.equal(requestFor(api.requests, 'daily-heart-rate-zones').filter.includes('Asia/Shanghai'), false);
});

test('initial physical window covers a 35 local-day UTC+14 boundary', async () => {
  const store = await seedStore();
  const api = createFakeApi({
    'heart-rate': [[hrPoint(INITIAL_HR_FROM, 72, '50400s')]],
  });
  await runSync(store, api);

  const heartRate = filterBounds(requestFor(api.requests, 'heart-rate').filter);
  assert.equal(heartRate.from, INITIAL_HR_FROM);
  const minutes = await store.healthMetrics.listMinutesByCivilDate({ userId, civilDate: '2026-07-19' });
  assert.ok(minutes.some((minute) => minute.utcOffsetMinutes === 840 && minute.minuteStartUtc === INITIAL_HR_FROM));
  assert.equal(minutes[0]?.civilDate, '2026-07-19');
});

test('incremental HR, activity-level, and exercise use watermark minus two hours', async () => {
  const store = await seedStore();
  for (const dataType of ['heart-rate', 'activity-level', 'exercise'] as const) {
    await store.healthMetrics.updateCursor({
      connectionId,
      dataType,
      successfulWatermark: NOW,
      lastErrorCode: undefined,
      retryCount: 0,
      nextAttemptAt: NOW,
    });
  }
  const api = createFakeApi();
  await runSync(store, api);

  const from = '2026-08-24T10:00:00.000Z';
  assert.deepEqual(filterBounds(requestFor(api.requests, 'heart-rate').filter), {
    from,
    untilExclusive: NOW.toISOString(),
  });
  assert.deepEqual(filterBounds(requestFor(api.requests, 'activity-level').filter), {
    from,
    untilExclusive: NOW.toISOString(),
  });
  assert.deepEqual(filterBounds(requestFor(api.requests, 'exercise').filter), {
    from: '2026-08-23',
    untilExclusive: '2026-08-26',
  });
});

test('incremental exercise civil window covers a Pacific evening session after UTC midnight', async () => {
  const store = await seedStore();
  const now = new Date('2026-08-25T02:00:00.000Z');
  await store.healthMetrics.updateCursor({
    connectionId,
    dataType: 'exercise',
    successfulWatermark: new Date('2026-08-25T00:30:00.000Z'),
    lastErrorCode: undefined,
    retryCount: 0,
    nextAttemptAt: now,
  });
  const api = createFakeApi({
    exercise: [[exercisePoint('2026-08-25T04:00:00.000Z', '2026-08-24', 'pacific-evening')]],
  });
  await runSync(store, api, { now, dataTypes: ['exercise'] });

  const bounds = filterBounds(requestFor(api.requests, 'exercise').filter);
  assert.equal(bounds.from <= '2026-08-24', true);
  assert.equal(bounds.untilExclusive > '2026-08-24', true);
  const stored = await store.healthMetrics.listExerciseIntervalsInRange({
    userId,
    fromUtc: '2026-08-24T00:00:00.000Z',
    toUtcExclusive: '2026-08-26T00:00:00.000Z',
  });
  assert.equal(stored.some((row) => row.sourceRecordId === 'pacific-evening' && row.civilDate === '2026-08-24'), true);
});

test('incremental sleep-style and daily types use a 48-hour overlap ending at now', async () => {
  const store = await seedStore();
  for (const dataType of ['daily-heart-rate-zones', 'time-in-heart-rate-zone'] as const) {
    await store.healthMetrics.updateCursor({
      connectionId,
      dataType,
      successfulWatermark: NOW,
      lastErrorCode: undefined,
      retryCount: 0,
      nextAttemptAt: NOW,
    });
  }
  const api = createFakeApi();
  await runSync(store, api);

  assert.deepEqual(filterBounds(requestFor(api.requests, 'daily-heart-rate-zones').filter), {
    from: '2026-08-22',
    untilExclusive: '2026-08-25',
  });
  assert.deepEqual(filterBounds(requestFor(api.requests, 'time-in-heart-rate-zone').filter), {
    from: '2026-08-22T12:00:00.000Z',
    untilExclusive: NOW.toISOString(),
  });
});

test('DST offsets that match IANA history stay unambiguous after recompute', async () => {
  const store = await seedStore({ timeZone: 'America/New_York' });
  const api = createFakeApi({
    'heart-rate': [[hrPoint('2026-03-08T16:00:00.000Z', 110, '-14400s')]],
    'activity-level': [[activityPoint('2026-03-08T16:00:00.000Z', 'LIGHTLY_ACTIVE')]],
    'daily-heart-rate-zones': [[zonesPoint('2026-03-08')]],
  });
  await runSync(store, api, { now: new Date('2026-03-09T12:00:00.000Z') });

  const cardio = await store.healthMetrics.getDailyCardio({ userId, civilDate: '2026-03-08' });
  assert.ok(cardio);
  assert.notEqual(cardio.status, 'timezone_ambiguous');
  assert.equal(cardio.metricVersion, WHOOP_STYLE_METRIC_VERSION);
});

test('pages flush with lookahead and a second-page 429 leaves the watermark unchanged', async () => {
  const store = await seedStore();
  const page1 = [hrPoint('2026-08-24T11:59:20.000Z', 110), hrPoint('2026-08-24T11:59:10.000Z', 110)];
  const page2 = [hrPoint('2026-08-24T11:59:00.000Z', 110)];
  const api = createFakeApi({
    'heart-rate': [page1, new Error('health api 429')],
    'daily-heart-rate-zones': [[zonesPoint('2026-08-24')]],
    'activity-level': [[activityPoint('2026-08-24T11:59:00.000Z', 'LIGHTLY_ACTIVE', 60_000)]],
  });
  let flushedAfterPage1 = false;
  api.onAfterFirstPage('heart-rate', async () => {
    flushedAfterPage1 = (await store.healthMetrics.listMinutesByCivilDate({ userId, civilDate: '2026-08-24' })).length > 0;
  });

  const failed = await runSync(store, api);
  assert.equal(flushedAfterPage1, true);
  const failedCursor = await store.healthMetrics.readCursor({ connectionId, dataType: 'heart-rate' });
  assert.equal(failedCursor?.successfulWatermark, undefined);
  assert.equal(failedCursor?.lastErrorCode, 'rate_limited');
  assert.equal(failedCursor?.retryCount, 1);
  assert.equal(failedCursor?.nextAttemptAt?.toISOString(), '2026-08-24T12:30:00.000Z');
  assert.equal(failed.nextSyncAt.toISOString(), '2026-08-24T12:30:00.000Z');
  assert.equal(containsRawPoint(failed), false);

  api.setPages('heart-rate', [page1, page2]);
  api.resetRequests();
  const retried = await runSync(store, api, { now: new Date('2026-08-24T12:30:00.000Z') });
  const minutes = await store.healthMetrics.listMinutesByCivilDate({ userId, civilDate: '2026-08-24' });
  const cardio = await store.healthMetrics.getDailyCardio({ userId, civilDate: '2026-08-24' });
  const merged = minutes.find((minute) => minute.minuteStartUtc === '2026-08-24T11:59:00.000Z');
  assert.ok(merged);
  assert.equal(merged.coverageSeconds, 60);
  assert.equal(merged.sampleCount, 3);
  assert.equal(cardio?.dose, 0.5);
  assert.equal(cardio?.attributedMinutes, 1);
  assert.ok(retried.cursors.find((cursor) => cursor.dataType === 'heart-rate')?.successfulWatermark);
  const strain = await store.healthMetrics.getMetricResult({
    userId,
    civilDate: '2026-08-24',
    metricName: 'strain',
    metricVersion: WHOOP_STYLE_METRIC_VERSION,
  });
  assert.equal(strain?.score, cardio?.strain);
  assert.equal(strain?.evidence.find((item) => item.label === '剂量')?.value, cardio?.dose);

  api.resetRequests();
  await runSync(store, api, { now: new Date('2026-08-24T13:30:00.000Z') });
  const again = await store.healthMetrics.listMinutesByCivilDate({ userId, civilDate: '2026-08-24' });
  const cardioAgain = await store.healthMetrics.getDailyCardio({ userId, civilDate: '2026-08-24' });
  const strainAgain = await store.healthMetrics.getMetricResult({
    userId,
    civilDate: '2026-08-24',
    metricName: 'strain',
    metricVersion: WHOOP_STYLE_METRIC_VERSION,
  });
  const againMerged = again.find((minute) => minute.minuteStartUtc === '2026-08-24T11:59:00.000Z');
  assert.ok(againMerged);
  assert.equal(againMerged.coverageSeconds, 60);
  assert.equal(againMerged.sampleCount, 3);
  assert.equal(cardioAgain?.dose, cardio?.dose);
  assert.equal(cardioAgain?.attributedMinutes, 1);
  assert.equal(strainAgain?.score, strain?.score);
  assert.equal(strainAgain?.evidence.find((item) => item.label === '剂量')?.value, strain?.evidence.find((item) => item.label === '剂量')?.value);
});

test('Strain(D) recompute writes Sleep Performance and Recovery for D+1 using complete previous strain', async () => {
  const store = await seedStore({ goal: true, timeZone: 'UTC' });
  await seedCompleteActiveDay(store, '2026-08-22');
  await recomputeAffectedDays(store, {
    userId,
    dates: ['2026-08-22'],
    now: NOW,
    loadSnapshot: async () => ({
      records: {
        ...emptyUserHealthRecords(),
        sleepSessions: [sleepSession('2026-08-23')],
        dailyHrv: [parseDailyHrv({ userId, source: 'google_health', sourceRecordId: 'hrv-23', date: '2026-08-23', valueMs: 50 })],
      },
      syncedAt: NOW,
    }),
  });

  const strain = await store.healthMetrics.getMetricResult({
    userId,
    civilDate: '2026-08-22',
    metricName: 'strain',
    metricVersion: WHOOP_STYLE_METRIC_VERSION,
  });
  const sleep = await store.healthMetrics.getMetricResult({
    userId,
    civilDate: '2026-08-23',
    metricName: 'sleep_performance',
    metricVersion: WHOOP_STYLE_METRIC_VERSION,
  });
  const recovery = await store.healthMetrics.getMetricResult({
    userId,
    civilDate: '2026-08-23',
    metricName: 'recovery',
    metricVersion: WHOOP_STYLE_METRIC_VERSION,
  });
  const cardio = await store.healthMetrics.getDailyCardio({ userId, civilDate: '2026-08-22' });
  assert.equal(cardio?.status, 'complete');
  assert.ok((strain?.score ?? 0) > 10);
  assert.ok(sleep);
  assert.ok(recovery);
  assert.equal(sleep.score !== null, true);
  assert.equal(sleep.evidence.find((item) => item.label === 'Strain补偿')?.value, 30);
  assert.equal(sleep.evidence.find((item) => item.label === '动态需求')?.value, 570);
});

test('a 429 on one type schedules only that cursor while another type advances', async () => {
  const store = await seedStore();
  const api = createFakeApi({
    'heart-rate': [new Error('health api 429')],
    'daily-heart-rate-zones': [[zonesPoint('2026-08-22')]],
  });
  const state = await runSync(store, api);

  const heartRate = await store.healthMetrics.readCursor({ connectionId, dataType: 'heart-rate' });
  const zones = await store.healthMetrics.readCursor({ connectionId, dataType: 'daily-heart-rate-zones' });
  assert.equal(heartRate?.successfulWatermark, undefined);
  assert.equal(heartRate?.lastErrorCode, 'rate_limited');
  assert.equal(heartRate?.retryCount, 1);
  assert.equal(heartRate?.nextAttemptAt?.toISOString(), '2026-08-24T12:30:00.000Z');
  assert.equal(zones?.successfulWatermark?.toISOString(), NOW.toISOString());
  assert.equal(zones?.lastErrorCode, undefined);
  assert.equal(zones?.retryCount, 0);
  assert.equal(state.nextSyncAt.toISOString(), '2026-08-24T12:30:00.000Z');
  assert.equal(
    connectionNextSyncAt(state.cursors, NOW).toISOString(),
    '2026-08-24T12:30:00.000Z',
  );
});

test('HR then activity-level versus activity-level then HR produce the same strain', async () => {
  const sampleAt = '2026-08-22T12:00:00.000Z';
  const hrPages = [[hrPoint(sampleAt, 110)]];
  const activityPages = [[activityPoint(sampleAt, 'LIGHTLY_ACTIVE')]];
  const zonePages = [[zonesPoint('2026-08-22')]];

  async function ingest(order: Array<['heart-rate' | 'activity-level' | 'daily-heart-rate-zones', PageOrError[]]>) {
    const store = await seedStore({ timeZone: 'UTC' });
    for (const [dataType, pages] of order) {
      const api = createFakeApi({
        'heart-rate': [[]],
        'activity-level': [[]],
        'daily-heart-rate-zones': [[]],
        [dataType]: pages,
      });
      await runSync(store, api, { dataTypes: [dataType] });
    }
    return store.healthMetrics.getDailyCardio({ userId, civilDate: '2026-08-22' });
  }

  const hrFirst = await ingest([
    ['daily-heart-rate-zones', zonePages],
    ['heart-rate', hrPages],
    ['activity-level', activityPages],
  ]);
  const activityFirst = await ingest([
    ['daily-heart-rate-zones', zonePages],
    ['activity-level', activityPages],
    ['heart-rate', hrPages],
  ]);
  assert.ok(hrFirst);
  assert.deepEqual(
    { dose: hrFirst.dose, strain: hrFirst.strain, attributedMinutes: hrFirst.attributedMinutes },
    { dose: activityFirst?.dose, strain: activityFirst?.strain, attributedMinutes: activityFirst?.attributedMinutes },
  );
  assert.equal(hrFirst.dose, 0.5);
});

test('exercise arriving before or after heart-rate yields the same attributed dose', async () => {
  const sampleAt = '2026-08-22T12:00:00.000Z';
  const hrPages = [[hrPoint(sampleAt, 110)]];
  const exercisePages = [[exercisePoint(sampleAt, '2026-08-22')]];
  const zonePages = [[zonesPoint('2026-08-22')]];

  async function ingest(order: Array<['heart-rate' | 'exercise' | 'daily-heart-rate-zones', PageOrError[]]>) {
    const store = await seedStore({ timeZone: 'UTC' });
    for (const [dataType, pages] of order) {
      const api = createFakeApi({
        'heart-rate': [[]],
        exercise: [[]],
        'daily-heart-rate-zones': [[]],
        [dataType]: pages,
      });
      await runSync(store, api, { dataTypes: [dataType] });
    }
    return store.healthMetrics.getDailyCardio({ userId, civilDate: '2026-08-22' });
  }

  const hrFirst = await ingest([
    ['daily-heart-rate-zones', zonePages],
    ['heart-rate', hrPages],
    ['exercise', exercisePages],
  ]);
  const exerciseFirst = await ingest([
    ['daily-heart-rate-zones', zonePages],
    ['exercise', exercisePages],
    ['heart-rate', hrPages],
  ]);
  assert.equal(hrFirst?.dose, exerciseFirst?.dose);
  assert.ok((hrFirst?.dose ?? 0) > 0);
});

test('returned sync state does not retain raw Google data points', async () => {
  const store = await seedStore();
  const api = createFakeApi({
    'heart-rate': [[hrPoint('2026-08-22T12:00:00.000Z', 110)]],
    'time-in-heart-rate-zone': [[timeInZonePoint('2026-08-22T12:00:00.000Z')]],
  });
  const state = await runSync(store, api);
  assert.equal(containsRawPoint(state), false);
  assert.equal('points' in state, false);
  assert.equal(healthMetricsHasRawSamples(store), false);
});

test('recomputeAffectedDays reads only persisted inputs', async () => {
  const store = await seedStore({ timeZone: 'UTC', goal: true });
  await store.healthMetrics.upsertMinutes([
    {
      userId,
      sourceFamily: 'google-wearables',
      minuteStartUtc: '2026-08-22T12:00:00.000Z',
      civilDate: '2026-08-22',
      utcOffsetMinutes: 0,
      ianaTimeZone: 'UTC',
      localMinuteOfDay: 720,
      avgBpm: 110,
      minBpm: 110,
      maxBpm: 110,
      sampleCount: 4,
      coverageSeconds: 60,
      activityLevel: 'unknown',
    },
  ]);
  await store.healthMetrics.upsertActivityLevelIntervals([
    {
      userId,
      sourceFamily: 'google-wearables',
      startTime: '2026-08-22T12:00:00.000Z',
      endTime: '2026-08-22T12:01:00.000Z',
      activityLevelType: 'LIGHTLY_ACTIVE',
    },
  ]);
  await store.healthMetrics.replaceHeartRateZones({
    userId,
    sourceFamily: 'google-wearables',
    date: '2026-08-22',
    zones: {
      LIGHT: { minBeatsPerMinute: 97, maxBeatsPerMinute: 116 },
      MODERATE: { minBeatsPerMinute: 117, maxBeatsPerMinute: 136 },
      VIGOROUS: { minBeatsPerMinute: 137, maxBeatsPerMinute: 155 },
      PEAK: { minBeatsPerMinute: 156, maxBeatsPerMinute: 200 },
    },
  });
  const api = createFakeApi({ 'heart-rate': [new Error('must not fetch Google Health')] });
  await recomputeAffectedDays(store, {
    userId,
    dates: ['2026-08-22'],
    now: NOW,
    loadRecords: async () => ({
      ...emptyUserHealthRecords(),
      sleepSessions: [sleepSession('2026-08-23')],
    }),
  });
  assert.equal(api.requests.length, 0);
  assert.ok(await store.healthMetrics.getDailyCardio({ userId, civilDate: '2026-08-22' }));
  assert.ok(
    await store.healthMetrics.getMetricResult({
      userId,
      civilDate: '2026-08-23',
      metricName: 'sleep_performance',
    }),
  );
});

function healthMetricsHasRawSamples(store: ReturnType<typeof createMemoryStore>): boolean {
  return Object.keys(store.healthMetrics).some((name) => /sample/i.test(name));
}

async function seedCompleteActiveDay(store: ReturnType<typeof createMemoryStore>, civilDate: string): Promise<void> {
  const minutes = Array.from({ length: 1440 }, (_, localMinuteOfDay) =>
    parseHeartRateMinuteAggregate({
      userId,
      sourceFamily: 'google-wearables',
      minuteStartUtc: new Date(Date.parse(`${civilDate}T00:00:00.000Z`) + localMinuteOfDay * 60_000).toISOString(),
      civilDate,
      utcOffsetMinutes: 0,
      ianaTimeZone: 'UTC',
      localMinuteOfDay,
      avgBpm: 110,
      minBpm: 110,
      maxBpm: 110,
      sampleCount: 4,
      coverageSeconds: 60,
      activityLevel: 'LIGHTLY_ACTIVE',
    }),
  );
  await store.healthMetrics.upsertMinutes(minutes);
  await store.healthMetrics.upsertActivityLevelIntervals([
    {
      userId,
      sourceFamily: 'google-wearables',
      startTime: `${civilDate}T00:00:00.000Z`,
      endTime: `${addCivilDays(civilDate, 1)}T00:00:00.000Z`,
      activityLevelType: 'LIGHTLY_ACTIVE',
    },
  ]);
  await store.healthMetrics.replaceHeartRateZones({
    userId,
    sourceFamily: 'google-wearables',
    date: civilDate,
    zones: {
      LIGHT: { minBeatsPerMinute: 97, maxBeatsPerMinute: 116 },
      MODERATE: { minBeatsPerMinute: 117, maxBeatsPerMinute: 136 },
      VIGOROUS: { minBeatsPerMinute: 137, maxBeatsPerMinute: 155 },
      PEAK: { minBeatsPerMinute: 156, maxBeatsPerMinute: 200 },
    },
  });
}

test('recomputeAffectedDays uses loadSnapshot sleep HRV and RHR when loadRecords is omitted', async () => {
  const store = await seedStore({ timeZone: 'UTC', goal: true });
  await store.healthMetrics.upsertMinutes([
    {
      userId,
      sourceFamily: 'google-wearables',
      minuteStartUtc: '2026-08-22T12:00:00.000Z',
      civilDate: '2026-08-22',
      utcOffsetMinutes: 0,
      ianaTimeZone: 'UTC',
      localMinuteOfDay: 720,
      avgBpm: 70,
      minBpm: 70,
      maxBpm: 70,
      sampleCount: 4,
      coverageSeconds: 60,
      activityLevel: 'SEDENTARY',
    },
  ]);
  await store.healthMetrics.replaceHeartRateZones({
    userId,
    sourceFamily: 'google-wearables',
    date: '2026-08-22',
    zones: {
      LIGHT: { minBeatsPerMinute: 97, maxBeatsPerMinute: 116 },
      MODERATE: { minBeatsPerMinute: 117, maxBeatsPerMinute: 136 },
      VIGOROUS: { minBeatsPerMinute: 137, maxBeatsPerMinute: 155 },
      PEAK: { minBeatsPerMinute: 156, maxBeatsPerMinute: 200 },
    },
  });
  await recomputeAffectedDays(store, {
    userId,
    dates: ['2026-08-22'],
    now: NOW,
    loadSnapshot: async () => ({
      records: {
        ...emptyUserHealthRecords(),
        sleepSessions: [sleepSession('2026-08-23', { minutesAsleep: 390 })],
        dailyHrv: [parseDailyHrv({ userId, source: 'google_health', sourceRecordId: 'hrv-23', date: '2026-08-23', valueMs: 61 })],
        dailyRhr: [parseDailyRhr({ userId, source: 'google_health', sourceRecordId: 'rhr-23', date: '2026-08-23', valueBpm: 52 })],
      },
      syncedAt: NOW,
    }),
  });

  const sleep = await store.healthMetrics.getMetricResult({
    userId,
    civilDate: '2026-08-23',
    metricName: 'sleep_performance',
  });
  const recovery = await store.healthMetrics.getMetricResult({
    userId,
    civilDate: '2026-08-23',
    metricName: 'recovery',
  });
  assert.equal(sleep?.evidence.find((item) => item.label === '实际睡眠')?.value, 390);
  assert.notEqual(sleep?.score, null);
  assert.equal(recovery?.source.hrv, true);
  assert.equal(recovery?.source.rhr, true);
});

test('incremental time-in-zone does not replace a partially covered civil day', async () => {
  const store = await seedStore();
  await store.healthMetrics.replaceTimeInZone({
    userId,
    sourceFamily: 'google-wearables',
    date: '2026-08-22',
    minutes: { light: 400, moderate: 20, vigorous: 5, peak: 0 },
  });
  await store.healthMetrics.replaceTimeInZone({
    userId,
    sourceFamily: 'google-wearables',
    date: '2026-08-23',
    minutes: { light: 10, moderate: 0, vigorous: 0, peak: 0 },
  });
  await store.healthMetrics.updateCursor({
    connectionId,
    dataType: 'time-in-heart-rate-zone',
    successfulWatermark: NOW,
    lastErrorCode: undefined,
    retryCount: 0,
    nextAttemptAt: NOW,
  });
  const api = createFakeApi({
    'time-in-heart-rate-zone': [
      [
        timeInZonePoint('2026-08-22T12:00:00.000Z'),
        timeInZonePoint('2026-08-23T00:00:00.000Z'),
        timeInZonePoint('2026-08-23T00:01:00.000Z'),
      ],
    ],
  });
  await runSync(store, api, { dataTypes: ['time-in-heart-rate-zone'] });

  const partial = await store.healthMetrics.getTimeInZone({ userId, civilDate: '2026-08-22' });
  const full = await store.healthMetrics.getTimeInZone({ userId, civilDate: '2026-08-23' });
  assert.equal(partial?.minutes.light, 400);
  assert.equal(full?.minutes.light, 2);
});

test('time-in-zone retains a spring DST day when source intervals cross its offset change', async () => {
  const store = await seedStore();
  await store.healthMetrics.replaceTimeInZone({
    userId,
    sourceFamily: 'google-wearables',
    date: '2026-03-08',
    minutes: { light: 400, moderate: 20, vigorous: 5, peak: 0 },
  });
  const api = createFakeApi({
    'time-in-heart-rate-zone': [[
      timeInZonePoint('2026-03-08T05:00:00.000Z', 'LIGHT', '-18000s'),
      timeInZonePoint('2026-03-08T07:00:00.000Z', 'LIGHT', '-14400s'),
    ]],
  });

  await runSync(store, api, {
    now: new Date('2026-03-10T12:00:00.000Z'),
    dataTypes: ['time-in-heart-rate-zone'],
  });

  const stored = await store.healthMetrics.getTimeInZone({ userId, civilDate: '2026-03-08' });
  assert.equal(stored?.minutes.light, 400);
});

test('time-in-zone retains a fall DST day when source intervals cross its offset change', async () => {
  const store = await seedStore();
  await store.healthMetrics.replaceTimeInZone({
    userId,
    sourceFamily: 'google-wearables',
    date: '2026-11-01',
    minutes: { light: 400, moderate: 20, vigorous: 5, peak: 0 },
  });
  const api = createFakeApi({
    'time-in-heart-rate-zone': [[
      timeInZonePoint('2026-11-01T04:00:00.000Z', 'LIGHT', '-14400s'),
      timeInZonePoint('2026-11-01T06:00:00.000Z', 'LIGHT', '-18000s'),
    ]],
  });

  await runSync(store, api, {
    now: new Date('2026-11-03T12:00:00.000Z'),
    dataTypes: ['time-in-heart-rate-zone'],
  });

  const stored = await store.healthMetrics.getTimeInZone({ userId, civilDate: '2026-11-01' });
  assert.equal(stored?.minutes.light, 400);
});

test('does not ingest a type whose nextAttemptAt is still in the future', async () => {
  const store = await seedStore();
  await store.healthMetrics.updateCursor({
    connectionId,
    dataType: 'heart-rate',
    successfulWatermark: NOW,
    lastErrorCode: undefined,
    retryCount: 0,
    nextAttemptAt: new Date(NOW.getTime() + 60 * 60 * 1_000),
  });
  await store.healthMetrics.updateCursor({
    connectionId,
    dataType: 'activity-level',
    successfulWatermark: NOW,
    lastErrorCode: undefined,
    retryCount: 0,
    nextAttemptAt: NOW,
  });
  const api = createFakeApi();
  await runSync(store, api, { dataTypes: ['heart-rate', 'activity-level'] });
  assert.equal(api.requests.some((request) => request.dataType === 'heart-rate'), false);
  assert.equal(api.requests.some((request) => request.dataType === 'activity-level'), true);
});

test('a third per-type failure schedules a two-hour retry that is not capped to one hour', async () => {
  const store = await seedStore();
  const api = createFakeApi({ 'heart-rate': [new Error('health api 429')] });
  const times = [
    NOW,
    new Date('2026-08-24T12:30:00.000Z'),
    new Date('2026-08-24T13:30:00.000Z'),
  ];
  let state: CardioSyncState | undefined;
  for (const now of times) {
    state = await runSync(store, api, { now, dataTypes: ['heart-rate'] });
  }
  const cursor = await store.healthMetrics.readCursor({ connectionId, dataType: 'heart-rate' });
  assert.equal(cursor?.nextAttemptAt?.toISOString(), '2026-08-24T15:30:00.000Z');
  assert.equal(state?.nextSyncAt.toISOString(), '2026-08-24T15:30:00.000Z');
});

test('skips all cardio types in backoff but still recomputes extra snapshot dates', async () => {
  const store = await seedStore({ timeZone: 'UTC', goal: true });
  await store.healthMetrics.upsertMinutes([
    {
      userId,
      sourceFamily: 'google-wearables',
      minuteStartUtc: '2026-08-22T12:00:00.000Z',
      civilDate: '2026-08-22',
      utcOffsetMinutes: 0,
      ianaTimeZone: 'UTC',
      localMinuteOfDay: 720,
      avgBpm: 110,
      minBpm: 110,
      maxBpm: 110,
      sampleCount: 4,
      coverageSeconds: 60,
      activityLevel: 'LIGHTLY_ACTIVE',
    },
  ]);
  await store.healthMetrics.upsertActivityLevelIntervals([
    {
      userId,
      sourceFamily: 'google-wearables',
      startTime: '2026-08-22T12:00:00.000Z',
      endTime: '2026-08-22T12:01:00.000Z',
      activityLevelType: 'LIGHTLY_ACTIVE',
    },
  ]);
  await store.healthMetrics.replaceHeartRateZones({
    userId,
    sourceFamily: 'google-wearables',
    date: '2026-08-22',
    zones: {
      LIGHT: { minBeatsPerMinute: 97, maxBeatsPerMinute: 116 },
      MODERATE: { minBeatsPerMinute: 117, maxBeatsPerMinute: 136 },
      VIGOROUS: { minBeatsPerMinute: 137, maxBeatsPerMinute: 155 },
      PEAK: { minBeatsPerMinute: 156, maxBeatsPerMinute: 200 },
    },
  });
  for (const dataType of ['heart-rate', 'activity-level', 'daily-heart-rate-zones', 'time-in-heart-rate-zone', 'exercise'] as const) {
    await store.healthMetrics.updateCursor({
      connectionId,
      dataType,
      successfulWatermark: NOW,
      lastErrorCode: undefined,
      retryCount: 0,
      nextAttemptAt: new Date(NOW.getTime() + 60 * 60 * 1_000),
    });
  }
  const api = createFakeApi();
  await runSync(store, api, {
    extraDates: ['2026-08-22'],
    records: { ...emptyUserHealthRecords(), sleepSessions: [sleepSession('2026-08-23')] },
  });
  assert.equal(api.requests.length, 0);
  const sleep = await store.healthMetrics.getMetricResult({
    userId,
    civilDate: '2026-08-23',
    metricName: 'sleep_performance',
  });
  assert.ok(sleep);
});

test('does not persist a heart-rate page after the connection is disconnected', async () => {
  const store = await seedStore();
  const api = createFakeApi({
    'heart-rate': [[hrPoint('2026-08-22T12:00:00.000Z', 110)], [hrPoint('2026-08-22T12:01:00.000Z', 112)]],
  });
  const original = api.iterateReconciledDataPoints.bind(api);
  api.iterateReconciledDataPoints = async function* (input) {
    if (input.dataType === 'heart-rate') {
      const row = await store.connections.findByUserId(userId);
      if (row) {
        await store.connections.update({ ...row, status: 'disconnected', nextSyncAt: undefined });
      }
    }
    yield* original(input);
  };
  await assert.rejects(
    () => runSync(store, api, { extraDates: ['2026-08-22'] }),
    /connection no longer syncable/,
  );
  const minutes = await store.healthMetrics.listMinutesByCivilDate({ userId, civilDate: '2026-08-22' });
  assert.equal(minutes.length, 0);
  assert.deepEqual(await store.healthMetrics.listMetricResults({ userId, civilDate: '2026-08-22' }), []);
  const cursor = await store.healthMetrics.readCursor({ connectionId, dataType: 'heart-rate' });
  assert.equal(cursor?.successfulWatermark, undefined);
  assert.equal(cursor?.lastErrorCode, undefined);
});

test('sleep HRV and RHR are not silently marked successful by cardio ingest', async () => {
  const store = await seedStore();
  const api = createFakeApi();
  await runSync(store, api, {
    dataTypes: ['sleep', 'daily-heart-rate-variability', 'daily-resting-heart-rate'],
  });
  for (const dataType of ['sleep', 'daily-heart-rate-variability', 'daily-resting-heart-rate'] as const) {
    const cursor = await store.healthMetrics.readCursor({ connectionId, dataType });
    assert.equal(cursor?.successfulWatermark, undefined);
    assert.equal(cursor?.lastErrorCode, 'sync_failed');
  }
});
