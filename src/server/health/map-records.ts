import { parseDailyHrv, parseDailyRhr, parseSleepSession, parseTrainingDay, type SleepSession, type TrainingDay } from '../../domain/health-records';
import { computeSessionLoad } from '../../domain/metrics';
import { civilDateFrom, parseNumeric, protoDurationMinutes, protoOffsetMinutes } from './proto';

export type GoogleDataPoint = {
  name?: string;
  dataPointName?: string;
  sleep?: {
    interval?: { startTime?: string; endTime?: string; endUtcOffset?: string; civilEndTime?: { date?: { year?: number; month?: number; day?: number } } };
    type?: string;
    stages?: Array<{ type?: string }>;
    metadata?: { nap?: boolean; processed?: boolean };
    summary?: { minutesAsleep?: string; minutesInSleepPeriod?: string; minutesAwake?: string };
  };
  dailyHeartRateVariability?: {
    date?: { year?: number; month?: number; day?: number };
    averageHeartRateVariabilityMilliseconds?: number;
  };
  dailyRestingHeartRate?: {
    date?: { year?: number; month?: number; day?: number };
    beatsPerMinute?: string | number;
  };
  exercise?: {
    interval?: {
      startTime?: string;
      endTime?: string;
      startUtcOffset?: string;
      civilStartTime?: { date?: { year?: number; month?: number; day?: number } };
    };
    metricsSummary?: {
      heartRateZoneDurations?: { lightTime?: string; moderateTime?: string; vigorousTime?: string; peakTime?: string };
    };
  };
  heartRate?: {
    sampleTime?: {
      physicalTime?: string;
      utcOffset?: string;
      civilTime?: { date?: { year?: number; month?: number; day?: number } };
    };
    beatsPerMinute?: string | number;
  };
  activityLevel?: {
    interval?: { startTime?: string; endTime?: string };
    activityLevelType?: string;
  };
  dailyHeartRateZones?: {
    date?: { year?: number; month?: number; day?: number };
    heartRateZones?: Array<{
      heartRateZoneType?: string;
      minBeatsPerMinute?: string | number;
      maxBeatsPerMinute?: string | number;
    }>;
  };
  timeInHeartRateZone?: {
    interval?: {
      startTime?: string;
      endTime?: string;
      startUtcOffset?: string;
      utcOffset?: string;
    };
    heartRateZoneType?: string;
  };
};

function recordId(point: GoogleDataPoint, fallback: string): string {
  const name = point.name ?? point.dataPointName;
  if (!name) {
    return fallback;
  }
  return name.length <= 256 ? name : name.slice(-256);
}

function civilDateFromInstant(iso: string, offsetMinutes: number): string {
  return new Date(Date.parse(iso) + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

function minutesAsleepFrom(sleep: NonNullable<GoogleDataPoint['sleep']>): number | undefined {
  const minutesAsleep = parseNumeric(sleep.summary?.minutesAsleep);
  return minutesAsleep === undefined ? undefined : Math.round(minutesAsleep);
}

export function mapSleepSession(point: GoogleDataPoint, userId: string): SleepSession | undefined {
  const sleep = point.sleep;
  if (!sleep?.interval?.startTime || !sleep.interval.endTime) {
    return undefined;
  }
  const minutesAsleep = minutesAsleepFrom(sleep);
  if (minutesAsleep === undefined) {
    return undefined;
  }
  const utcOffsetMinutes = protoOffsetMinutes(sleep.interval.endUtcOffset);
  const civilEndDate =
    civilDateFrom(sleep.interval.civilEndTime?.date) ?? civilDateFromInstant(sleep.interval.endTime, utcOffsetMinutes);
  const timeInBed = parseNumeric(sleep.summary?.minutesInSleepPeriod);
  const awakeMinutes = parseNumeric(sleep.summary?.minutesAwake);
  const awakeSegments = sleep.stages?.filter((stage) => stage.type === 'AWAKE').length;
  try {
    return parseSleepSession({
      userId,
      source: 'google_health',
      sourceRecordId: recordId(point, `${userId}:${sleep.interval.startTime}`),
      id: recordId(point, `${userId}:${sleep.interval.startTime}`),
      startTime: sleep.interval.startTime,
      endTime: sleep.interval.endTime,
      civilEndDate,
      utcOffsetMinutes,
      minutesAsleep,
      timeInBedMinutes: timeInBed === undefined ? undefined : Math.max(Math.round(timeInBed), minutesAsleep),
      awakeMinutes: awakeMinutes === undefined ? undefined : Math.round(awakeMinutes),
      awakeSegments,
      isNap: sleep.metadata?.nap ?? false,
      processed: sleep.metadata?.processed ?? false,
    });
  } catch {
    return undefined;
  }
}

export function mapDailyHrv(point: GoogleDataPoint, userId: string) {
  const hrv = point.dailyHeartRateVariability;
  const date = civilDateFrom(hrv?.date);
  const valueMs = hrv?.averageHeartRateVariabilityMilliseconds;
  if (!date || valueMs === undefined) {
    return undefined;
  }
  try {
    return parseDailyHrv({
      userId,
      source: 'google_health',
      sourceRecordId: recordId(point, `${userId}:hrv:${date}`),
      date,
      valueMs,
    });
  } catch {
    return undefined;
  }
}

export function mapDailyRhr(point: GoogleDataPoint, userId: string) {
  const rhr = point.dailyRestingHeartRate;
  const date = civilDateFrom(rhr?.date);
  const valueBpm = parseNumeric(rhr?.beatsPerMinute);
  if (!date || valueBpm === undefined) {
    return undefined;
  }
  try {
    return parseDailyRhr({
      userId,
      source: 'google_health',
      sourceRecordId: recordId(point, `${userId}:rhr:${date}`),
      date,
      valueBpm,
    });
  } catch {
    return undefined;
  }
}

function zoneMinutes(durations: NonNullable<NonNullable<GoogleDataPoint['exercise']>['metricsSummary']>['heartRateZoneDurations']) {
  if (!durations) {
    return undefined;
  }
  const light = protoDurationMinutes(durations.lightTime) ?? 0;
  const moderate = protoDurationMinutes(durations.moderateTime) ?? 0;
  const vigorous = protoDurationMinutes(durations.vigorousTime) ?? 0;
  const peak = protoDurationMinutes(durations.peakTime) ?? 0;
  return { light, moderate, vigorous, peak };
}

export function mapTrainingDays(points: GoogleDataPoint[], userId: string, completedDates: string[] = []): TrainingDay[] {
  const loads = new Map<string, number>();
  const unknownDates = new Set<string>();
  for (const [index, point] of points.entries()) {
    const exercise = point.exercise;
    if (!exercise?.interval?.startTime || !exercise.interval.endTime) {
      continue;
    }
    const date =
      civilDateFrom(exercise.interval.civilStartTime?.date) ??
      civilDateFromInstant(exercise.interval.startTime, protoOffsetMinutes(exercise.interval.startUtcOffset));
    const durationMinutes = (Date.parse(exercise.interval.endTime) - Date.parse(exercise.interval.startTime)) / 60_000;
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      continue;
    }
    const result = computeSessionLoad({
      id: recordId(point, `${userId}:ex:${index}`),
      durationMinutes,
      zoneMinutes: zoneMinutes(exercise.metricsSummary?.heartRateZoneDurations),
    });
    if (result.load === null) {
      unknownDates.add(date);
      continue;
    }
    loads.set(date, (loads.get(date) ?? 0) + result.load);
  }
  const dates = new Set([...completedDates, ...loads.keys(), ...unknownDates]);
  return [...dates]
    .sort()
    .map((date) =>
      unknownDates.has(date)
        ? parseTrainingDay({ userId, date, completeness: 'unknown', load: null })
        : parseTrainingDay({ userId, date, completeness: 'complete', load: loads.get(date) ?? 0 }),
    );
}
