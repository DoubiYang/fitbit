import { createHash } from 'node:crypto';

import type {
  ActivityLevelInterval,
  DailyHeartRateZones,
  ExerciseInterval,
  HeartRateMinuteAggregate,
} from '../../domain/cardio-records';
import { WHOOP_STYLE_METRIC_VERSION } from '../../domain/metric-types';
import type { SleepSession } from '../../domain/health-records';
import type { HealthTimeZoneHistory } from './cardio-store';

export const STRAIN_PROVENANCE_VERSION = 1 as const;

export type StrainCalculationContext = {
  as_of_utc: string;
  civil_date: string;
  is_current_day: boolean;
  local_day_length_minutes: number;
  metric_version: typeof WHOOP_STYLE_METRIC_VERSION;
  time_zone_history_fingerprint: string;
  time_zone_unambiguous: boolean;
};

export type StrainLocalDayBounds = {
  fromUtc: string;
  toUtcExclusive: string;
  localDayLengthMinutes: number;
};

export type StableStrainLocalDayBounds = StrainLocalDayBounds & { timeZone: string };

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Strain provenance input must be defined.');
  return serialized;
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function addCivilDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function offsetAt(timeZone: string, instant: Date): number | undefined {
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

function localMidnightUtc(civilDate: string, timeZone: string): number | undefined {
  const [year, month, day] = civilDate.split('-').map(Number);
  if (!year || !month || !day) return undefined;
  const wallTime = Date.UTC(year, month - 1, day);
  let instant = wallTime;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const offset = offsetAt(timeZone, new Date(instant));
    if (offset === undefined) return undefined;
    const next = wallTime - offset * 60_000;
    if (next === instant) return instant;
    instant = next;
  }
  return instant;
}

function historyAt(history: readonly HealthTimeZoneHistory[], instant: string): HealthTimeZoneHistory | undefined {
  const at = Date.parse(instant);
  return [...history]
    .filter((row) => Date.parse(row.effectiveAt) <= at)
    .sort((left, right) => Date.parse(right.effectiveAt) - Date.parse(left.effectiveAt))[0];
}

export function strainTimeZoneAt(history: readonly HealthTimeZoneHistory[], instant: string): string | undefined {
  return historyAt(history, instant)?.ianaTimeZone;
}

export function strainTimeZoneOffsetMinutes(timeZone: string, instant: Date): number | undefined {
  return offsetAt(timeZone, instant);
}

export function strainTimeZoneHistoryFingerprint(history: readonly HealthTimeZoneHistory[]): string {
  return sha256(
    [...history]
      .sort((left, right) => (
        left.effectiveAt.localeCompare(right.effectiveAt)
        || left.ianaTimeZone.localeCompare(right.ianaTimeZone)
        || Number(left.isBackfillAnchor) - Number(right.isBackfillAnchor)
      ))
      .map(({ effectiveAt, ianaTimeZone, isBackfillAnchor }) => ({ effectiveAt, ianaTimeZone, isBackfillAnchor })),
  );
}

export function strainLocalDayBoundsForTimeZone(input: {
  civilDate: string;
  timeZone: string;
}): StrainLocalDayBounds | undefined {
  const start = localMidnightUtc(input.civilDate, input.timeZone);
  const end = localMidnightUtc(addCivilDays(input.civilDate, 1), input.timeZone);
  const length = start === undefined || end === undefined ? NaN : (end - start) / 60_000;
  if (!Number.isInteger(length) || length < 1_380 || length > 1_500 || start === undefined || end === undefined) {
    return undefined;
  }
  return {
    fromUtc: new Date(start).toISOString(),
    toUtcExclusive: new Date(end).toISOString(),
    localDayLengthMinutes: length,
  };
}

export function strainLocalDayBounds(input: {
  civilDate: string;
  timeZoneHistory: readonly HealthTimeZoneHistory[];
}): StrainLocalDayBounds | undefined {
  const timeZone = historyAt(input.timeZoneHistory, `${input.civilDate}T00:00:00.000Z`)?.ianaTimeZone;
  return timeZone ? strainLocalDayBoundsForTimeZone({ civilDate: input.civilDate, timeZone }) : undefined;
}

/**
 * A single civil day cannot safely receive one timeline label when the stored
 * IANA history changed within it. In that case, callers must fail closed.
 */
export function stableStrainLocalDayBounds(input: {
  civilDate: string;
  minutes: readonly HeartRateMinuteAggregate[];
  timeZoneHistory: readonly HealthTimeZoneHistory[];
}): StableStrainLocalDayBounds | undefined {
  const zones = new Set<string>();
  for (const minute of input.minutes.filter((candidate) => candidate.civilDate === input.civilDate)) {
    const expected = historyAt(input.timeZoneHistory, minute.minuteStartUtc)?.ianaTimeZone;
    if (!expected || (minute.ianaTimeZone !== null && minute.ianaTimeZone !== expected)) return undefined;
    zones.add(expected);
  }
  if (zones.size !== 1) return undefined;
  const timeZone = [...zones][0]!;
  const bounds = strainLocalDayBoundsForTimeZone({ civilDate: input.civilDate, timeZone });
  if (!bounds || historyAt(input.timeZoneHistory, bounds.fromUtc)?.ianaTimeZone !== timeZone) return undefined;
  const startMs = Date.parse(bounds.fromUtc);
  const endMs = Date.parse(bounds.toUtcExclusive);
  if (input.timeZoneHistory.some((row) => {
    const effectiveAt = Date.parse(row.effectiveAt);
    return effectiveAt > startMs && effectiveAt < endMs && row.ianaTimeZone !== timeZone;
  })) return undefined;
  return { ...bounds, timeZone };
}

export function strainLocalDayLengthMinutes(input: {
  civilDate: string;
  timeZoneHistory: readonly HealthTimeZoneHistory[];
}): number {
  return strainLocalDayBounds(input)?.localDayLengthMinutes ?? 1_440;
}

export function strainCalculationContext(input: {
  civilDate: string;
  isCurrentDay: boolean;
  now: string;
  timeZoneHistory: readonly HealthTimeZoneHistory[];
  timeZoneUnambiguous: boolean;
  localDayLengthMinutes?: number;
}): StrainCalculationContext {
  return {
    as_of_utc: new Date(input.now).toISOString(),
    civil_date: input.civilDate,
    is_current_day: input.isCurrentDay,
    local_day_length_minutes: input.localDayLengthMinutes ?? strainLocalDayLengthMinutes({
      civilDate: input.civilDate,
      timeZoneHistory: input.timeZoneHistory,
    }),
    metric_version: WHOOP_STYLE_METRIC_VERSION,
    time_zone_history_fingerprint: strainTimeZoneHistoryFingerprint(input.timeZoneHistory),
    time_zone_unambiguous: input.timeZoneUnambiguous,
  };
}

export function strainInputFingerprint(input: {
  userId: string;
  context: StrainCalculationContext;
  minutes: readonly HeartRateMinuteAggregate[];
  zones: DailyHeartRateZones | undefined;
  sleepSessions: readonly SleepSession[];
  exerciseIntervals: readonly ExerciseInterval[];
  activityLevelIntervals: readonly ActivityLevelInterval[];
}): string {
  return sha256({
    provenance_version: STRAIN_PROVENANCE_VERSION,
    user_id: input.userId,
    context: input.context,
    minutes: [...input.minutes]
      .sort((left, right) => left.minuteStartUtc.localeCompare(right.minuteStartUtc))
      .map((minute) => ({
        minute_start_utc: minute.minuteStartUtc,
        civil_date: minute.civilDate,
        utc_offset_minutes: minute.utcOffsetMinutes,
        iana_time_zone: minute.ianaTimeZone,
        local_minute_of_day: minute.localMinuteOfDay,
        avg_bpm: minute.avgBpm,
        coverage_seconds: minute.coverageSeconds,
        activity_level: minute.activityLevel,
      })),
    zones: input.zones?.zones ?? null,
    sleep_sessions: [...input.sleepSessions]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ id, startTime, endTime, civilEndDate, isNap, processed }) => ({
        id, start_time: startTime, end_time: endTime, civil_end_date: civilEndDate, is_nap: isNap, processed,
      })),
    exercise_intervals: [...input.exerciseIntervals]
      .sort((left, right) => left.sourceRecordId.localeCompare(right.sourceRecordId) || left.startTime.localeCompare(right.startTime))
      .map(({ sourceRecordId, startTime, endTime, utcOffsetMinutes, civilDate }) => ({
        source_record_id: sourceRecordId,
        start_time: startTime,
        end_time: endTime,
        utc_offset_minutes: utcOffsetMinutes,
        civil_date: civilDate,
      })),
    activity_level_intervals: [...input.activityLevelIntervals]
      .sort((left, right) => left.startTime.localeCompare(right.startTime) || left.endTime.localeCompare(right.endTime))
      .map(({ startTime, endTime, activityLevelType }) => ({
        start_time: startTime,
        end_time: endTime,
        activity_level_type: activityLevelType,
      })),
  });
}
