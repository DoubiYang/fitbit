import {
  parseActivityLevelInterval,
  parseDailyHeartRateZones,
  parseDailyTimeInZone,
  parseExerciseInterval,
  type ActivityLevelInterval,
  type DailyHeartRateZones,
  type DailyTimeInZone,
  type ExerciseInterval,
  type HeartRateSample,
} from '../../domain/cardio-records';
import { aggregateHeartRateMinutes, type AggregatedHeartRateMinute } from '../../domain/whoop-style-metrics';
import type { GoogleDataPoint } from './map-records';
import { civilDateFrom, parseNumeric, protoDurationMinutes } from './proto';

const SOURCE_FAMILY = 'google-wearables' as const;
const ZONE_TYPES = ['LIGHT', 'MODERATE', 'VIGOROUS', 'PEAK'] as const;

export type GoogleHeartRateZoneType = (typeof ZONE_TYPES)[number];

export type TimeInZoneInterval = {
  startTime: string;
  endTime: string;
  heartRateZoneType: GoogleHeartRateZoneType;
  utcOffsetMinutes: number;
  civilDate: string;
};

function recordId(point: GoogleDataPoint, fallback: string): string {
  const name = point.name ?? point.dataPointName;
  if (!name) {
    return fallback;
  }
  return name.length <= 256 ? name : name.slice(-256);
}

function isValidInstant(value: string | undefined): value is string {
  return Boolean(value && Number.isFinite(Date.parse(value)) && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value));
}

function requiredOffsetMinutes(value: string | undefined): number | undefined {
  const minutes = protoDurationMinutes(value);
  return minutes === undefined ? undefined : Math.round(minutes);
}

function civilDateFromInstant(iso: string, offsetMinutes: number): string | undefined {
  const ms = Date.parse(iso) + offsetMinutes * 60_000;
  if (!Number.isFinite(ms)) {
    return undefined;
  }
  return new Date(ms).toISOString().slice(0, 10);
}

function isZoneType(value: string | undefined): value is GoogleHeartRateZoneType {
  return value === 'LIGHT' || value === 'MODERATE' || value === 'VIGOROUS' || value === 'PEAK';
}

export function mapHeartRateSamples(points: GoogleDataPoint[]): HeartRateSample[] {
  const samples: HeartRateSample[] = [];
  for (const point of points) {
    const physicalTime = point.heartRate?.sampleTime?.physicalTime;
    const utcOffsetMinutes = requiredOffsetMinutes(point.heartRate?.sampleTime?.utcOffset);
    const beatsPerMinute = parseNumeric(point.heartRate?.beatsPerMinute);
    if (
      !isValidInstant(physicalTime) ||
      utcOffsetMinutes === undefined ||
      beatsPerMinute === undefined ||
      beatsPerMinute < 1 ||
      beatsPerMinute > 250
    ) {
      continue;
    }
    samples.push({ physicalTime, beatsPerMinute, utcOffsetMinutes });
  }
  return samples;
}

export function mapHeartRatePageToMinutes(input: {
  userId: string;
  points: GoogleDataPoint[];
  lookaheadSample?: HeartRateSample;
  closeAt?: string;
}): AggregatedHeartRateMinute[] {
  return aggregateHeartRateMinutes({
    userId: input.userId,
    sourceFamily: SOURCE_FAMILY,
    samples: mapHeartRateSamples(input.points),
    lookaheadSample: input.lookaheadSample,
    closeAt: input.closeAt,
  });
}

export function mapActivityLevelIntervals(points: GoogleDataPoint[], userId: string): ActivityLevelInterval[] {
  const byStart = new Map<string, ActivityLevelInterval>();
  for (const point of points) {
    const startTime = point.activityLevel?.interval?.startTime;
    const endTime = point.activityLevel?.interval?.endTime;
    const activityLevelType = point.activityLevel?.activityLevelType;
    if (!isValidInstant(startTime) || !isValidInstant(endTime) || !activityLevelType) {
      continue;
    }
    try {
      if (byStart.has(startTime)) {
        continue;
      }
      const mapped = parseActivityLevelInterval({
        userId,
        sourceFamily: SOURCE_FAMILY,
        startTime,
        endTime,
        activityLevelType,
      });
      byStart.set(mapped.startTime, mapped);
    } catch {
      continue;
    }
  }
  return [...byStart.values()].sort((left, right) => left.startTime.localeCompare(right.startTime));
}

export function mapDailyHeartRateZones(point: GoogleDataPoint, userId: string): DailyHeartRateZones | undefined {
  const date = civilDateFrom(point.dailyHeartRateZones?.date);
  const entries = point.dailyHeartRateZones?.heartRateZones;
  if (!date || !entries) {
    return undefined;
  }

  const zones: Partial<Record<GoogleHeartRateZoneType, { minBeatsPerMinute: number; maxBeatsPerMinute: number }>> = {};
  for (const entry of entries) {
    const minBeatsPerMinute = parseNumeric(entry.minBeatsPerMinute);
    const maxBeatsPerMinute = parseNumeric(entry.maxBeatsPerMinute);
    if (!isZoneType(entry.heartRateZoneType) || minBeatsPerMinute === undefined || maxBeatsPerMinute === undefined) {
      continue;
    }
    zones[entry.heartRateZoneType] = {
      minBeatsPerMinute: Math.round(minBeatsPerMinute),
      maxBeatsPerMinute: Math.round(maxBeatsPerMinute),
    };
  }

  try {
    return parseDailyHeartRateZones({
      userId,
      sourceFamily: SOURCE_FAMILY,
      date,
      zones,
    });
  } catch {
    return undefined;
  }
}

export function mapTimeInZoneIntervals(points: GoogleDataPoint[]): TimeInZoneInterval[] {
  const intervals: TimeInZoneInterval[] = [];
  for (const point of points) {
    const interval = point.timeInHeartRateZone?.interval;
    const startTime = interval?.startTime;
    const endTime = interval?.endTime;
    const heartRateZoneType = point.timeInHeartRateZone?.heartRateZoneType;
    const utcOffsetMinutes = requiredOffsetMinutes(interval?.startUtcOffset ?? interval?.utcOffset);
    if (!isValidInstant(startTime) || !isValidInstant(endTime) || utcOffsetMinutes === undefined || !isZoneType(heartRateZoneType)) {
      continue;
    }
    if (Date.parse(endTime) <= Date.parse(startTime)) {
      continue;
    }
    const civilDate = civilDateFromInstant(startTime, utcOffsetMinutes);
    if (!civilDate) {
      continue;
    }
    intervals.push({ startTime, endTime, heartRateZoneType, utcOffsetMinutes, civilDate });
  }
  return intervals;
}

export function sumDailyTimeInZone(userId: string, intervals: TimeInZoneInterval[]): DailyTimeInZone[] {
  const byDate = new Map<string, { light: number; moderate: number; vigorous: number; peak: number }>();
  for (const interval of intervals) {
    const minutes = (Date.parse(interval.endTime) - Date.parse(interval.startTime)) / 60_000;
    if (!Number.isFinite(minutes) || minutes <= 0) {
      continue;
    }
    const current = byDate.get(interval.civilDate) ?? { light: 0, moderate: 0, vigorous: 0, peak: 0 };
    if (interval.heartRateZoneType === 'LIGHT') {
      current.light += minutes;
    } else if (interval.heartRateZoneType === 'MODERATE') {
      current.moderate += minutes;
    } else if (interval.heartRateZoneType === 'VIGOROUS') {
      current.vigorous += minutes;
    } else {
      current.peak += minutes;
    }
    byDate.set(interval.civilDate, current);
  }

  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([date, minutes]) => {
      try {
        return [parseDailyTimeInZone({ userId, sourceFamily: SOURCE_FAMILY, date, minutes })];
      } catch {
        return [];
      }
    });
}

export function mapExerciseInterval(point: GoogleDataPoint, userId: string): ExerciseInterval | undefined {
  const interval = point.exercise?.interval;
  const startTime = interval?.startTime;
  const endTime = interval?.endTime;
  const utcOffsetMinutes = requiredOffsetMinutes(interval?.startUtcOffset);
  if (!isValidInstant(startTime) || !isValidInstant(endTime) || utcOffsetMinutes === undefined) {
    return undefined;
  }
  const civilDate = civilDateFrom(interval?.civilStartTime?.date) ?? civilDateFromInstant(startTime, utcOffsetMinutes);
  if (!civilDate) {
    return undefined;
  }
  try {
    return parseExerciseInterval({
      userId,
      sourceFamily: SOURCE_FAMILY,
      sourceRecordId: recordId(point, `${userId}:${startTime}`),
      startTime,
      endTime,
      utcOffsetMinutes,
      civilDate,
    });
  } catch {
    return undefined;
  }
}
