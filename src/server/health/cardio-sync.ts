import {
  parseDailyCardio,
  parseDailyTimeInZone,
  parseHeartRateMinuteAggregate,
  parseMetricResult,
  type ActivityLevelInterval,
  type HeartRateMinuteAggregate,
  type HeartRateSample,
} from '../../domain/cardio-records';
import { WHOOP_STYLE_METRIC_VERSION } from '../../domain/metric-types';
import {
  assignActivityLevel,
  computeRecovery,
  computeSleepPerformance,
  computeStrain,
  mergeHeartRateMinuteCoverages,
  metricsAffectedByStrainRecompute,
  type AggregatedHeartRateMinute,
} from '../../domain/whoop-style-metrics';
import { updateObservedHrPeakBpm } from '../../domain/body-age';
import type { AuthStore, ConnectionRow, ScheduledSyncLease } from '../auth/types';
import { civilDate } from '../time/civil-date';
import {
  mapActivityLevelIntervals,
  mapDailyHeartRateZones,
  mapExerciseInterval,
  mapHeartRatePageToMinutes,
  mapHeartRateSamples,
  mapTimeInZoneIntervals,
} from './cardio-map';
import type { HealthSyncCursor, HealthSyncDataType, HealthTimeZoneHistory } from './cardio-store';
import { dataPointFilter, HEALTH_HIGH_VOLUME_PAGE_SIZE } from './filters';
import { recomputeBodyAge } from './body-age-recompute';
import type { HealthApiClient } from './health-api';
import type { GoogleDataPoint } from './map-records';
import { mapDailyVo2 } from './map-records';
import { emptyUserHealthRecords, type UserHealthRecords } from './provider';
import type { HealthSnapshot } from './snapshot-store';
import {
  STRAIN_PROVENANCE_VERSION,
  stableStrainLocalDayBounds,
  strainCalculationContext,
  strainInputFingerprint,
} from './strain-provenance';

export const HOURLY_SYNC_MS = 60 * 60 * 1_000;
const TWO_HOURS_MS = 2 * HOURLY_SYNC_MS;
const TWENTY_FOUR_HOURS_MS = 24 * HOURLY_SYNC_MS;
const FORTY_EIGHT_HOURS_MS = 48 * HOURLY_SYNC_MS;
const INITIAL_PHYSICAL_LOOKBACK_MS = 37 * 24 * HOURLY_SYNC_MS;
const RETRY_DELAYS_MS = [30 * 60 * 1_000, 60 * 60 * 1_000, 2 * 60 * 60 * 1_000] as const;

const CARDIO_SYNC_TYPES: HealthSyncDataType[] = [
  'heart-rate',
  'activity-level',
  'daily-heart-rate-zones',
  'time-in-heart-rate-zone',
  'exercise',
  'daily-vo2-max',
];

export type CardioSyncState = {
  affectedDates: string[];
  nextSyncAt: Date;
  cursors: HealthSyncCursor[];
};

export type LoadHealthRecords = (userId: string) => Promise<UserHealthRecords>;
export type LoadHealthSnapshot = (userId: string) => Promise<HealthSnapshot | undefined>;

export const SNAPSHOT_SYNC_TYPES = [
  'sleep',
  'daily-heart-rate-variability',
  'daily-resting-heart-rate',
] as const satisfies readonly HealthSyncDataType[];

function recordsLoader(input: {
  loadRecords?: LoadHealthRecords;
  loadSnapshot?: LoadHealthSnapshot;
}): LoadHealthRecords {
  return (
    input.loadRecords ??
    (async (userId) => (await input.loadSnapshot?.(userId))?.records ?? emptyUserHealthRecords())
  );
}

type QueryWindow = { from: string; untilExclusive: string };
type ScheduledCardioRun = ScheduledSyncLease & { signal?: AbortSignal };

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error('scheduled sync deadline exceeded');
  }
}

async function scheduledWrite<T>(input: {
  store: AuthStore;
  lease?: ScheduledCardioRun;
  signal?: AbortSignal;
}, write: (store: AuthStore) => Promise<T>, options?: { allowPastDeadline?: boolean; allowAborted?: boolean }): Promise<T> {
  const signal = input.signal ?? input.lease?.signal;
  if (!options?.allowAborted) {
    throwIfAborted(signal);
  }
  if (!input.lease) {
    return write(input.store);
  }
  return input.store.withScheduledSyncLease(input.lease, async (inner) => {
    if (!options?.allowAborted) {
      throwIfAborted(signal);
    }
    return write(inner);
  }, { allowPastDeadline: options?.allowPastDeadline });
}

export function connectionNextSyncAt(cursors: HealthSyncCursor[], now: Date): Date {
  const hourly = now.getTime() + HOURLY_SYNC_MS;
  const times: number[] = [];
  for (const cursor of cursors) {
    if (cursor.nextAttemptAt) {
      times.push(cursor.nextAttemptAt.getTime());
    } else if (!cursor.lastErrorCode) {
      times.push(hourly);
    }
  }
  if (times.length === 0) {
    return new Date(hourly);
  }
  return new Date(Math.min(...times));
}

export function cursorRetrySchedule(now: Date, retryCount: number): { nextAttemptAt: Date; retryCount: number } {
  if (retryCount < RETRY_DELAYS_MS.length) {
    return {
      nextAttemptAt: new Date(now.getTime() + RETRY_DELAYS_MS[retryCount]!),
      retryCount: retryCount + 1,
    };
  }
  return { nextAttemptAt: new Date(now.getTime() + HOURLY_SYNC_MS), retryCount: 0 };
}

function addCivilDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function utcDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

function dailyVo2CivilDate(instant: Date, timeZone: string | undefined): string {
  if (!timeZone) {
    return utcDate(instant);
  }
  try {
    return civilDate(instant, timeZone);
  } catch {
    return utcDate(instant);
  }
}

export function initialCivilBackfillRange(now: Date, rangeDays = 35): { from: string; to: string } {
  const to = utcDate(now);
  return { from: addCivilDays(to, -(rangeDays + 1)), to };
}

function cursorErrorCode(error: unknown): string {
  return error instanceof Error && /health api 429/i.test(error.message) ? 'rate_limited' : 'sync_failed';
}

export function isUnsyncableError(error: unknown): boolean {
  return error instanceof Error && /connection no longer syncable/i.test(error.message);
}

export function successCursor(
  now: Date,
): Pick<HealthSyncCursor, 'successfulWatermark' | 'lastErrorCode' | 'retryCount' | 'nextAttemptAt'> {
  return {
    successfulWatermark: now,
    lastErrorCode: undefined,
    retryCount: 0,
    nextAttemptAt: new Date(now.getTime() + HOURLY_SYNC_MS),
  };
}

function physicalWindow(now: Date, watermark: Date | undefined, overlapMs: number): QueryWindow {
  const lookback = watermark ? overlapMs : INITIAL_PHYSICAL_LOOKBACK_MS;
  const origin = watermark ?? now;
  return {
    from: new Date(origin.getTime() - lookback).toISOString(),
    untilExclusive: now.toISOString(),
  };
}

function utcWideWindow(now: Date): QueryWindow {
  const range = initialCivilBackfillRange(now);
  return { from: range.from, untilExclusive: addCivilDays(range.to, 1) };
}

function fortyEightHourCivilWindow(now: Date): QueryWindow {
  return {
    from: utcDate(new Date(now.getTime() - FORTY_EIGHT_HOURS_MS)),
    untilExclusive: addCivilDays(utcDate(now), 1),
  };
}

function twoHourCivilWindow(now: Date, watermark: Date): QueryWindow {
  return {
    from: addCivilDays(utcDate(new Date(watermark.getTime() - TWO_HOURS_MS)), -1),
    untilExclusive: addCivilDays(utcDate(now), 2),
  };
}

export function syncWindowFor(
  dataType: HealthSyncDataType,
  now: Date,
  cursor: HealthSyncCursor | undefined,
  timeZone?: string,
): QueryWindow {
  const watermark = cursor?.successfulWatermark;
  switch (dataType) {
    case 'heart-rate':
    case 'activity-level':
      return physicalWindow(now, watermark, TWENTY_FOUR_HOURS_MS);
    case 'time-in-heart-rate-zone':
      return physicalWindow(now, watermark, FORTY_EIGHT_HOURS_MS);
    case 'daily-heart-rate-zones':
      return watermark ? fortyEightHourCivilWindow(now) : utcWideWindow(now);
    case 'exercise':
      return watermark ? twoHourCivilWindow(now, watermark) : utcWideWindow(now);
    case 'sleep':
    case 'daily-heart-rate-variability':
    case 'daily-resting-heart-rate':
      return watermark ? fortyEightHourCivilWindow(now) : utcWideWindow(now);
    case 'daily-vo2-max': {
      const asOf = dailyVo2CivilDate(now, timeZone);
      return watermark
        ? {
          from: dailyVo2CivilDate(new Date(now.getTime() - FORTY_EIGHT_HOURS_MS), timeZone),
          untilExclusive: addCivilDays(asOf, 1),
        }
        : { from: addCivilDays(asOf, -27), untilExclusive: addCivilDays(asOf, 1) };
    }
  }
}

function dayQueryRange(date: string): { fromUtc: string; toUtcExclusive: string } {
  return {
    fromUtc: `${addCivilDays(date, -1)}T00:00:00.000Z`,
    toUtcExclusive: `${addCivilDays(date, 2)}T00:00:00.000Z`,
  };
}

function oldestSample(points: GoogleDataPoint[]): HeartRateSample | undefined {
  return [...mapHeartRateSamples(points)].sort(
    (left, right) => Date.parse(left.physicalTime) - Date.parse(right.physicalTime),
  )[0];
}

function persistableMinutes(
  minutes: AggregatedHeartRateMinute[],
  intervals: ActivityLevelInterval[],
): HeartRateMinuteAggregate[] {
  return minutes.flatMap((minute) => {
    try {
      return [
        parseHeartRateMinuteAggregate({
          userId: minute.userId,
          sourceFamily: minute.sourceFamily,
          minuteStartUtc: minute.minuteStartUtc,
          civilDate: minute.civilDate,
          utcOffsetMinutes: minute.utcOffsetMinutes,
          ianaTimeZone: minute.ianaTimeZone,
          localMinuteOfDay: minute.localMinuteOfDay,
          avgBpm: minute.avgBpm,
          minBpm: minute.minBpm,
          maxBpm: minute.maxBpm,
          sampleCount: minute.sampleCount,
          coverageSeconds: Math.min(60, Math.max(0, minute.coverageSeconds)),
          activityLevel: assignActivityLevel(minute.minuteStartUtc, intervals),
        }),
      ];
    } catch {
      return [];
    }
  });
}

export function timeZoneOffsetMinutes(timeZone: string, instant: Date): number | undefined {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
        .formatToParts(instant)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]),
    ) as Record<string, string>;
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    return Math.round((asUtc - instant.getTime()) / 60_000);
  } catch {
    return undefined;
  }
}

function historyAt(history: HealthTimeZoneHistory[], instant: string): HealthTimeZoneHistory | undefined {
  const at = Date.parse(instant);
  return [...history]
    .filter((row) => Date.parse(row.effectiveAt) <= at)
    .sort((left, right) => Date.parse(right.effectiveAt) - Date.parse(left.effectiveAt))[0];
}

function timezoneUnambiguous(minutes: HeartRateMinuteAggregate[], history: HealthTimeZoneHistory[]): boolean {
  if (history.length === 0) {
    return false;
  }
  for (const minute of minutes) {
    const zone = historyAt(history, minute.minuteStartUtc);
    if (!zone) {
      return false;
    }
    const expected = timeZoneOffsetMinutes(zone.ianaTimeZone, new Date(minute.minuteStartUtc));
    if (expected === undefined || expected !== minute.utcOffsetMinutes) {
      return false;
    }
  }
  return true;
}

async function requireSyncable(store: AuthStore, userId: string): Promise<void> {
  const row = await store.connections.findByUserId(userId);
  if (!row || (row.status !== 'active' && row.status !== 'partial')) {
    throw new Error('connection no longer syncable');
  }
}

function civilDatesForInterval(startTime: string, endTime: string): string[] {
  const start = utcDate(new Date(startTime));
  const end = utcDate(new Date(endTime));
  return [addCivilDays(start, -1), start, end, addCivilDays(end, 1)];
}

async function ingestHeartRate(input: {
  store: AuthStore;
  api: HealthApiClient;
  accessToken: string;
  userId: string;
  now: Date;
  window: QueryWindow;
  lease?: ScheduledCardioRun;
  signal?: AbortSignal;
}): Promise<string[]> {
  const affected = new Set<string>();
  const persistedMinutes: HeartRateMinuteAggregate[] = [];
  let previousMinutes: AggregatedHeartRateMinute[] = [];
  let lookahead: HeartRateSample | undefined;
  for await (const page of input.api.iterateReconciledDataPoints({
    accessToken: input.accessToken,
    dataType: 'heart-rate',
    filter: dataPointFilter('heart-rate', input.window.from, input.window.untilExclusive),
    pageSize: HEALTH_HIGH_VOLUME_PAGE_SIZE,
    signal: input.signal,
  })) {
    throwIfAborted(input.signal);
    const points = page.slice();
    const minutes = mapHeartRatePageToMinutes({
      userId: input.userId,
      points,
      lookaheadSample: lookahead,
      closeAt: lookahead ? undefined : input.now.toISOString(),
    });
    lookahead = oldestSample(points) ?? lookahead;
    const combined = mergeHeartRateMinuteCoverages([previousMinutes, minutes]);
    previousMinutes = minutes;
    const fromUtc = combined[0]?.minuteStartUtc ?? input.window.from;
    const last = combined[combined.length - 1];
    const toUtcExclusive = last
      ? new Date(Date.parse(last.minuteStartUtc) + 60_000).toISOString()
      : input.window.untilExclusive;
    const intervals = await input.store.healthMetrics.listActivityLevelIntervalsInRange({
      userId: input.userId,
      fromUtc,
      toUtcExclusive,
    });
    const persistable = persistableMinutes(combined, intervals);
    if (persistable.length > 0) {
      await requireSyncable(input.store, input.userId);
      await scheduledWrite(input, (store) => store.healthMetrics.upsertMinutes(persistable));
      persistedMinutes.push(...persistable);
      for (const minute of persistable) {
        affected.add(minute.civilDate);
      }
    }
  }
  if (persistedMinutes.length > 0) {
    const profile = await input.store.healthMetrics.getBodyAgeProfile({ userId: input.userId });
    const observedPeakBpm = updateObservedHrPeakBpm(profile?.observedHrPeakBpm, persistedMinutes);
    if (observedPeakBpm !== undefined && observedPeakBpm > (profile?.observedHrPeakBpm ?? Number.NEGATIVE_INFINITY)) {
      const observedAt = persistedMinutes
        .filter((minute) => updateObservedHrPeakBpm(undefined, [minute]) === observedPeakBpm)
        .map((minute) => minute.minuteStartUtc)
        .sort()[0];
      if (observedAt) {
        await requireSyncable(input.store, input.userId);
        await scheduledWrite(input, (store) => store.healthMetrics.recordObservedHrPeak({
          userId: input.userId,
          observedHrPeakBpm: observedPeakBpm,
          observedAt,
        }));
      }
    }
  }
  return [...affected];
}

async function ingestActivityLevel(input: {
  store: AuthStore;
  api: HealthApiClient;
  accessToken: string;
  userId: string;
  window: QueryWindow;
  lease?: ScheduledCardioRun;
  signal?: AbortSignal;
}): Promise<string[]> {
  const affected = new Set<string>();
  for await (const page of input.api.iterateReconciledDataPoints({
    accessToken: input.accessToken,
    dataType: 'activity-level',
    filter: dataPointFilter('activity-level', input.window.from, input.window.untilExclusive),
    pageSize: HEALTH_HIGH_VOLUME_PAGE_SIZE,
    signal: input.signal,
  })) {
    throwIfAborted(input.signal);
    const intervals = mapActivityLevelIntervals(page.slice(), input.userId);
    if (intervals.length === 0) {
      continue;
    }
    await requireSyncable(input.store, input.userId);
    await scheduledWrite(input, (store) => store.healthMetrics.upsertActivityLevelIntervals(intervals));
    for (const interval of intervals) {
      for (const date of civilDatesForInterval(interval.startTime, interval.endTime)) {
        affected.add(date);
      }
    }
  }
  return [...affected];
}

async function ingestDailyZones(input: {
  store: AuthStore;
  api: HealthApiClient;
  accessToken: string;
  userId: string;
  window: QueryWindow;
  lease?: ScheduledCardioRun;
  signal?: AbortSignal;
}): Promise<string[]> {
  const points = await input.api.listDataPoints({
    accessToken: input.accessToken,
    dataType: 'daily-heart-rate-zones',
    filter: dataPointFilter('daily-heart-rate-zones', input.window.from, input.window.untilExclusive),
    signal: input.signal,
  });
  const affected: string[] = [];
  for (const point of points) {
    const mapped = mapDailyHeartRateZones(point, input.userId);
    if (!mapped) {
      continue;
    }
    await requireSyncable(input.store, input.userId);
    await scheduledWrite(input, (store) => store.healthMetrics.replaceHeartRateZones(mapped));
    affected.push(mapped.date);
  }
  return affected;
}

function localDayFullyInWindow(civilDate: string, utcOffsetMinutes: number, window: QueryWindow): boolean {
  const dayStartMs = Date.parse(`${civilDate}T00:00:00.000Z`) - utcOffsetMinutes * 60_000;
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1_000;
  return dayStartMs >= Date.parse(window.from) && dayEndMs <= Date.parse(window.untilExclusive);
}

async function ingestTimeInZone(input: {
  store: AuthStore;
  api: HealthApiClient;
  accessToken: string;
  userId: string;
  window: QueryWindow;
  lease?: ScheduledCardioRun;
  signal?: AbortSignal;
}): Promise<string[]> {
  const totals = new Map<
    string,
    { light: number; moderate: number; vigorous: number; peak: number; utcOffsetMinutes: number; utcOffsets: Set<number> }
  >();
  for await (const page of input.api.iterateReconciledDataPoints({
    accessToken: input.accessToken,
    dataType: 'time-in-heart-rate-zone',
    filter: dataPointFilter('time-in-heart-rate-zone', input.window.from, input.window.untilExclusive),
    pageSize: HEALTH_HIGH_VOLUME_PAGE_SIZE,
    signal: input.signal,
  })) {
    throwIfAborted(input.signal);
    const intervals = mapTimeInZoneIntervals(page.slice());
    for (const interval of intervals) {
      throwIfAborted(input.signal);
      const current = totals.get(interval.civilDate) ?? {
        light: 0,
        moderate: 0,
        vigorous: 0,
        peak: 0,
        utcOffsetMinutes: interval.utcOffsetMinutes,
        utcOffsets: new Set<number>(),
      };
      current.utcOffsets.add(interval.utcOffsetMinutes);
      const minutes = (Date.parse(interval.endTime) - Date.parse(interval.startTime)) / 60_000;
      if (interval.heartRateZoneType === 'LIGHT') current.light += minutes;
      else if (interval.heartRateZoneType === 'MODERATE') current.moderate += minutes;
      else if (interval.heartRateZoneType === 'VIGOROUS') current.vigorous += minutes;
      else current.peak += minutes;
      totals.set(interval.civilDate, current);
    }
  }
  const affected: string[] = [];
  for (const [date, minutes] of totals) {
    if (minutes.utcOffsets.size !== 1 || !localDayFullyInWindow(date, minutes.utcOffsetMinutes, input.window)) {
      continue;
    }
    await requireSyncable(input.store, input.userId);
    await scheduledWrite(input, (store) => store.healthMetrics.replaceTimeInZone(
      parseDailyTimeInZone({
        userId: input.userId,
        sourceFamily: 'google-wearables',
        date,
        minutes: { light: minutes.light, moderate: minutes.moderate, vigorous: minutes.vigorous, peak: minutes.peak },
      }),
    ));
    affected.push(date);
  }
  return affected;
}

async function ingestExercise(input: {
  store: AuthStore;
  api: HealthApiClient;
  accessToken: string;
  userId: string;
  window: QueryWindow;
  lease?: ScheduledCardioRun;
  signal?: AbortSignal;
}): Promise<string[]> {
  const points = await input.api.listDataPoints({
    accessToken: input.accessToken,
    dataType: 'exercise',
    filter: dataPointFilter('exercise', input.window.from, input.window.untilExclusive),
    pageSize: 25,
    signal: input.signal,
  });
  const affected = new Set<string>();
  for (const point of points) {
    const mapped = mapExerciseInterval(point, input.userId);
    if (!mapped) {
      continue;
    }
    await requireSyncable(input.store, input.userId);
    await scheduledWrite(input, (store) => store.healthMetrics.upsertExerciseIntervals([mapped]));
    affected.add(mapped.civilDate);
    for (const date of civilDatesForInterval(mapped.startTime, mapped.endTime)) {
      affected.add(date);
    }
  }
  return [...affected];
}

async function ingestDailyVo2(input: {
  store: AuthStore;
  api: HealthApiClient;
  accessToken: string;
  userId: string;
  now: Date;
  window: QueryWindow;
  lease?: ScheduledCardioRun;
  signal?: AbortSignal;
}): Promise<string[]> {
  const points = await input.api.listDataPoints({
    accessToken: input.accessToken,
    dataType: 'daily-vo2-max',
    filter: dataPointFilter('daily-vo2-max', input.window.from, input.window.untilExclusive),
    signal: input.signal,
  });
  throwIfAborted(input.signal);
  const receivedAt = input.now.toISOString();
  const rows = points.flatMap((point) => {
    const mapped = mapDailyVo2(point);
    return mapped
      ? [{ userId: input.userId, ...mapped, sourceFamily: 'google-wearables' as const, receivedAt, revision: 0 }]
      : [];
  });
  await requireSyncable(input.store, input.userId);
  await scheduledWrite(input, (store) => store.healthMetrics.authoritativelyReplaceDailyVo2({
    userId: input.userId,
    fromCivilDate: input.window.from,
    toCivilDate: addCivilDays(input.window.untilExclusive, -1),
    rows,
  }));
  return rows.map((row) => row.civilDate);
}

async function ingestDataType(input: {
  store: AuthStore;
  api: HealthApiClient;
  accessToken: string;
  userId: string;
  now: Date;
  dataType: HealthSyncDataType;
  window: QueryWindow;
  lease?: ScheduledCardioRun;
  signal?: AbortSignal;
}): Promise<string[]> {
  switch (input.dataType) {
    case 'heart-rate':
      return ingestHeartRate(input);
    case 'activity-level':
      return ingestActivityLevel(input);
    case 'daily-heart-rate-zones':
      return ingestDailyZones(input);
    case 'time-in-heart-rate-zone':
      return ingestTimeInZone(input);
    case 'exercise':
      return ingestExercise(input);
    case 'daily-vo2-max':
      return ingestDailyVo2(input);
    default:
      throw new Error(`unsupported cardio sync data type ${input.dataType}`);
  }
}

export async function scheduleTypeFailure(input: {
  store: AuthStore;
  connectionId: string;
  dataType: HealthSyncDataType;
  now: Date;
  error: unknown;
  lease?: ScheduledCardioRun;
  signal?: AbortSignal;
}): Promise<void> {
  const current = await input.store.healthMetrics.readCursor({
    connectionId: input.connectionId,
    dataType: input.dataType,
  });
  const scheduled = cursorRetrySchedule(input.now, current?.retryCount ?? 0);
  await scheduledWrite(input, (store) => store.healthMetrics.scheduleCursor({
    connectionId: input.connectionId,
    dataType: input.dataType,
    lastErrorCode: cursorErrorCode(input.error),
    retryCount: scheduled.retryCount,
    nextAttemptAt: scheduled.nextAttemptAt,
  }), { allowPastDeadline: true, allowAborted: true });
}

export async function recomputeAffectedDays(
  store: AuthStore,
  input: {
    userId: string;
    dates: Iterable<string>;
    now: Date;
    loadRecords?: LoadHealthRecords;
    loadSnapshot?: LoadHealthSnapshot;
    lastSuccessfulSyncAt?: Date | string;
    signal?: AbortSignal;
  },
): Promise<void> {
  throwIfAborted(input.signal);
  const records = await recordsLoader(input)(input.userId);
  throwIfAborted(input.signal);
  const history = await store.healthMetrics.listTimeZoneHistory(input.userId);
  throwIfAborted(input.signal);
  const zone = historyAt(history, input.now.toISOString());
  const today = zone ? civilDate(input.now, zone.ianaTimeZone) : utcDate(input.now);
  const expanded = new Set<string>();
  for (const date of input.dates) {
    const cascade = metricsAffectedByStrainRecompute(date);
    expanded.add(cascade.strainDate);
    expanded.add(cascade.sleepPerformanceDate);
    expanded.add(cascade.recoveryDate);
  }
  const ordered = [...expanded].sort();
  const sleepSessions = records.sleepSessions.filter(
    (session) => session.userId === input.userId && session.source === 'google_health',
  );
  const dailyHrv = records.dailyHrv.filter(
    (row) => row.userId === input.userId && row.source === 'google_health',
  );
  const dailyRhr = records.dailyRhr.filter(
    (row) => row.userId === input.userId && row.source === 'google_health',
  );

  for (const date of ordered) {
    throwIfAborted(input.signal);
    const range = dayQueryRange(date);
    const storedMinutes = await store.healthMetrics.listMinutesByCivilDate({ userId: input.userId, civilDate: date });
    throwIfAborted(input.signal);
    const activityLevelIntervals = await store.healthMetrics.listActivityLevelIntervalsInRange({
      userId: input.userId,
      fromUtc: range.fromUtc,
      toUtcExclusive: range.toUtcExclusive,
    });
    throwIfAborted(input.signal);
    const exerciseIntervals = await store.healthMetrics.listExerciseIntervalsInRange({
      userId: input.userId,
      fromUtc: range.fromUtc,
      toUtcExclusive: range.toUtcExclusive,
    });
    throwIfAborted(input.signal);
    const zones = await store.healthMetrics.getHeartRateZones({ userId: input.userId, civilDate: date });
    throwIfAborted(input.signal);
    const minutes = storedMinutes.map((minute) =>
      parseHeartRateMinuteAggregate({
        ...minute,
        activityLevel: assignActivityLevel(minute.minuteStartUtc, activityLevelIntervals),
      }),
    );
    if (minutes.length > 0) {
      throwIfAborted(input.signal);
      await store.healthMetrics.upsertMinutes(minutes);
      throwIfAborted(input.signal);
    }
    const stableLocalDayBounds = stableStrainLocalDayBounds({
      civilDate: date,
      minutes,
      timeZoneHistory: history,
    });
    const timeZoneIsUnambiguous = Boolean(stableLocalDayBounds) && timezoneUnambiguous(minutes, history);
    const calculationContext = strainCalculationContext({
      civilDate: date,
      isCurrentDay: date === today,
      now: input.now.toISOString(),
      timeZoneHistory: history,
      timeZoneUnambiguous: timeZoneIsUnambiguous,
      localDayLengthMinutes: stableLocalDayBounds?.localDayLengthMinutes,
    });
    const inputFingerprint = strainInputFingerprint({
      userId: input.userId,
      context: calculationContext,
      minutes,
      zones,
      sleepSessions,
      exerciseIntervals,
      activityLevelIntervals,
    });
    const provenance = {
      provenanceVersion: STRAIN_PROVENANCE_VERSION,
      inputFingerprint,
      calculationContext,
    };
    const strain = computeStrain({
      userId: input.userId,
      date,
      minutes,
      zones,
      sleepSessions,
      exerciseIntervals,
      activityLevelIntervals,
      timezoneUnambiguous: timeZoneIsUnambiguous,
      isCurrentDay: date === today,
      now: input.now.toISOString(),
      localDayLengthMinutes: calculationContext.local_day_length_minutes,
    });
    throwIfAborted(input.signal);
    await store.healthMetrics.upsertDailyCardio(
      parseDailyCardio({
        userId: input.userId,
        date,
        status: strain.status,
        strain: strain.score,
        dose: strain.dose,
        zoneMinutes: strain.zoneMinutes,
        knownContextMinutes: strain.coverage.knownContextMinutes,
        rawCoverageMinutes: strain.coverage.rawHeartRateMinutes,
        attributedMinutes: strain.coverage.attributedMinutes,
        metricVersion: WHOOP_STYLE_METRIC_VERSION,
        provenance,
      }),
    );
    throwIfAborted(input.signal);
    await store.healthMetrics.upsertMetricResult(
      parseMetricResult({
        userId: input.userId,
        civilDate: date,
        metricName: 'strain',
        metricVersion: WHOOP_STYLE_METRIC_VERSION,
        score: strain.score,
        status: strain.status,
        quality: null,
        reason: strain.reason,
        evidence: strain.evidence,
        source: strain.source,
        coverage: strain.coverage,
        provenance,
      }),
    );
    throwIfAborted(input.signal);

    const previousDate = addCivilDays(date, -1);
    const previousCardio = await store.healthMetrics.getDailyCardio({ userId: input.userId, civilDate: previousDate });
    throwIfAborted(input.signal);
    const goal = await store.healthMetrics.lookupSleepGoal({ userId: input.userId, civilDate: date });
    throwIfAborted(input.signal);
    const sleep = computeSleepPerformance({
      targetDate: date,
      sessions: sleepSessions,
      goals: goal ? [goal] : [],
      previousDayStrain: previousCardio
        ? { status: previousCardio.status, score: previousCardio.strain }
        : undefined,
    });
    throwIfAborted(input.signal);
    await store.healthMetrics.upsertMetricResult(
      parseMetricResult({
        userId: input.userId,
        civilDate: date,
        metricName: 'sleep_performance',
        metricVersion: WHOOP_STYLE_METRIC_VERSION,
        score: sleep.score,
        status: null,
        quality: null,
        reason: sleep.reason,
        evidence: sleep.evidence,
        source: sleep.source,
        coverage: sleep.coverage,
        qualityFlags: sleep.sleepHistoryIncomplete ? ['sleep_history_incomplete'] : [],
      }),
    );
    throwIfAborted(input.signal);

    const lastSuccessfulSyncAt =
      input.lastSuccessfulSyncAt instanceof Date
        ? input.lastSuccessfulSyncAt.toISOString()
        : input.lastSuccessfulSyncAt;
    const recovery = computeRecovery({
      targetDate: date,
      hrv: dailyHrv.find((row) => row.date === date),
      rhr: dailyRhr.find((row) => row.date === date),
      historicalHrv: dailyHrv,
      historicalRhr: dailyRhr,
      sleep,
      now: input.now.toISOString(),
      lastSuccessfulSyncAt,
    });
    throwIfAborted(input.signal);
    await store.healthMetrics.upsertMetricResult(
      parseMetricResult({
        userId: input.userId,
        civilDate: date,
        metricName: 'recovery',
        metricVersion: WHOOP_STYLE_METRIC_VERSION,
        score: recovery.score,
        status: null,
        quality: recovery.quality,
        reason: recovery.reason,
        evidence: recovery.evidence,
        source: recovery.source,
        coverage: recovery.coverage,
      }),
    );
    throwIfAborted(input.signal);
  }
  throwIfAborted(input.signal);
}

export async function syncCardioConnection(input: {
  store: AuthStore;
  connection: ConnectionRow;
  api: HealthApiClient;
  accessToken: string;
  now: Date;
  dataTypes?: HealthSyncDataType[];
  loadRecords?: LoadHealthRecords;
  loadSnapshot?: LoadHealthSnapshot;
  extraDates?: Iterable<string>;
  lastSuccessfulSyncAt?: Date | string;
  lease?: ScheduledCardioRun;
  signal?: AbortSignal;
}): Promise<CardioSyncState> {
  const dataTypes = input.dataTypes ?? CARDIO_SYNC_TYPES;
  const succeeded: HealthSyncDataType[] = [];
  const affected = new Set<string>(input.extraDates ?? []);

  for (const dataType of dataTypes) {
    throwIfAborted(input.signal);
    const cursor = await input.store.healthMetrics.readCursor({
      connectionId: input.connection.id,
      dataType,
    });
    if (cursor?.nextAttemptAt && cursor.nextAttemptAt.getTime() > input.now.getTime()) {
      continue;
    }
    const timeZone = dataType === 'daily-vo2-max'
      ? (await input.store.healthMetrics.lookupTimeZoneHistory({
        userId: input.connection.userId,
        at: input.now.toISOString(),
      }))?.ianaTimeZone
      : undefined;
    const window = syncWindowFor(dataType, input.now, cursor, timeZone);
    try {
      const dates = await ingestDataType({
        store: input.store,
        api: input.api,
        accessToken: input.accessToken,
        userId: input.connection.userId,
        now: input.now,
        dataType,
        window,
        lease: input.lease,
        signal: input.signal,
      });
      for (const date of dates) {
        affected.add(date);
      }
      succeeded.push(dataType);
    } catch (error) {
      if (isUnsyncableError(error)) {
        throw error;
      }
      await scheduleTypeFailure({
        store: input.store,
        connectionId: input.connection.id,
        dataType,
        now: input.now,
        error,
        lease: input.lease,
        signal: input.signal,
      });
    }
  }

  const finalize = async (inner: AuthStore) => {
    throwIfAborted(input.signal);
    await recomputeAffectedDays(inner, {
      userId: input.connection.userId,
      dates: affected,
      now: input.now,
      loadRecords: input.loadRecords,
      loadSnapshot: input.loadSnapshot,
      lastSuccessfulSyncAt: input.lastSuccessfulSyncAt,
      signal: input.signal,
    });
    throwIfAborted(input.signal);
    for (const dataType of succeeded) {
      throwIfAborted(input.signal);
      await inner.healthMetrics.updateCursor({
        connectionId: input.connection.id,
        dataType,
        ...successCursor(input.now),
      });
    }
    throwIfAborted(input.signal);
  };
  if (input.lease) {
    await input.store.withScheduledSyncLease(input.lease, (inner) => finalize(inner));
  } else {
    await input.store.withTransaction(finalize);
  }

  try {
    const records = await recordsLoader({
      loadRecords: input.loadRecords,
      loadSnapshot: input.loadSnapshot,
    })(input.connection.userId);
    const recompute = (inner: AuthStore) => recomputeBodyAge({
      store: inner.healthMetrics,
      userId: input.connection.userId,
      now: input.now,
      records,
    });
    if (input.lease) {
      await input.store.withScheduledSyncLease(input.lease, recompute);
    } else {
      await input.store.withTransaction(recompute);
    }
  } catch {
    // A body-age estimate is server-only supplemental output. Its independent
    // transaction may roll back without affecting committed metrics or cursors.
  }

  throwIfAborted(input.signal);
  const cursors = await input.store.healthMetrics.listCursors({ connectionId: input.connection.id });
  return {
    affectedDates: [...affected].sort(),
    cursors,
    nextSyncAt: connectionNextSyncAt(cursors, input.now),
  };
}
