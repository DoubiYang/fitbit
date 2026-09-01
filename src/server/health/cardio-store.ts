import {
  parseActivityLevelInterval,
  parseDailyCardio,
  parseDailyHeartRateZones,
  parseDailyTimeInZone,
  parseExerciseInterval,
  parseHeartRateMinuteAggregate,
  parseMetricResult,
  parseSleepGoal,
  type ActivityLevelInterval,
  type DailyCardio,
  type DailyHeartRateZones,
  type DailyTimeInZone,
  type ExerciseInterval,
  type HeartRateMinuteAggregate,
  type MetricResult,
  type SleepGoal,
} from '../../domain/cardio-records';
import { WHOOP_STYLE_METRIC_VERSION, type MetricName } from '../../domain/metric-types';

export const HEALTH_SYNC_DATA_TYPES = [
  'heart-rate',
  'activity-level',
  'daily-heart-rate-zones',
  'time-in-heart-rate-zone',
  'exercise',
  'sleep',
  'daily-heart-rate-variability',
  'daily-resting-heart-rate',
] as const;

export type HealthSyncDataType = (typeof HEALTH_SYNC_DATA_TYPES)[number];

export type HealthSyncCursor = {
  connectionId: string;
  dataType: HealthSyncDataType;
  successfulWatermark: Date | undefined;
  lastErrorCode: string | undefined;
  retryCount: number;
  nextAttemptAt: Date | undefined;
};

export type HealthTimeZoneHistory = {
  userId: string;
  ianaTimeZone: string;
  effectiveAt: string;
  isBackfillAnchor: boolean;
};

export type HealthMetricsWindowWrite = {
  userId: string;
  connectionId: string;
  dataType: HealthSyncDataType;
  minutes?: HeartRateMinuteAggregate[];
  activityLevelIntervals?: ActivityLevelInterval[];
  heartRateZones?: DailyHeartRateZones[];
  timeInZone?: DailyTimeInZone[];
  exerciseIntervals?: ExerciseInterval[];
  dailyCardio?: DailyCardio[];
  metricResults?: MetricResult[];
  cursor: Pick<HealthSyncCursor, 'successfulWatermark' | 'lastErrorCode' | 'retryCount' | 'nextAttemptAt'>;
};

export type MinuteLocalAssociationUpdate = {
  userId: string;
  sourceFamily: 'google-wearables';
  minuteStartUtc: string;
  civilDate: string;
  ianaTimeZone: string;
  localMinuteOfDay: number;
};

export type HealthMetricsStore = {
  ingestWindow(input: HealthMetricsWindowWrite): Promise<void>;

  upsertMinutes(minutes: HeartRateMinuteAggregate[]): Promise<void>;
  listMinutesByCivilDate(input: { userId: string; civilDate: string }): Promise<HeartRateMinuteAggregate[]>;
  listMinutesInRange(input: { userId: string; fromUtc: string; toUtcExclusive?: string }): Promise<HeartRateMinuteAggregate[]>;
  updateMinuteLocalAssociation(input: MinuteLocalAssociationUpdate): Promise<boolean>;

  upsertActivityLevelIntervals(intervals: ActivityLevelInterval[]): Promise<void>;
  listActivityLevelIntervalsInRange(input: {
    userId: string;
    fromUtc: string;
    toUtcExclusive?: string;
  }): Promise<ActivityLevelInterval[]>;

  replaceHeartRateZones(zones: DailyHeartRateZones): Promise<void>;
  getHeartRateZones(input: { userId: string; civilDate: string }): Promise<DailyHeartRateZones | undefined>;

  replaceTimeInZone(row: DailyTimeInZone): Promise<void>;
  getTimeInZone(input: { userId: string; civilDate: string }): Promise<DailyTimeInZone | undefined>;

  upsertExerciseIntervals(intervals: ExerciseInterval[]): Promise<void>;
  listExerciseIntervalsInRange(input: {
    userId: string;
    fromUtc: string;
    toUtcExclusive?: string;
  }): Promise<ExerciseInterval[]>;

  upsertDailyCardio(row: DailyCardio): Promise<void>;
  getDailyCardio(input: { userId: string; civilDate: string }): Promise<DailyCardio | undefined>;
  listDailyCardio(input: { userId: string; fromCivilDate: string; toCivilDate: string }): Promise<DailyCardio[]>;

  upsertMetricResult(row: MetricResult): Promise<void>;
  getMetricResult(input: {
    userId: string;
    civilDate: string;
    metricName: MetricName;
    metricVersion?: string;
  }): Promise<MetricResult | undefined>;
  listMetricResults(input: { userId: string; civilDate: string }): Promise<MetricResult[]>;

  readCursor(input: { connectionId: string; dataType: HealthSyncDataType }): Promise<HealthSyncCursor | undefined>;
  listCursors(input: { connectionId: string }): Promise<HealthSyncCursor[]>;
  updateCursor(cursor: HealthSyncCursor): Promise<void>;
  scheduleCursor(input: {
    connectionId: string;
    dataType: HealthSyncDataType;
    lastErrorCode: string;
    retryCount: number;
    nextAttemptAt: Date;
  }): Promise<void>;
  listDueCursors(input: { now: Date; connectionId?: string }): Promise<HealthSyncCursor[]>;

  insertSleepGoal(goal: SleepGoal): Promise<void>;
  lookupSleepGoal(input: { userId: string; civilDate: string }): Promise<SleepGoal | undefined>;

  insertTimeZoneHistory(row: HealthTimeZoneHistory): Promise<void>;
  lookupTimeZoneHistory(input: { userId: string; at: string }): Promise<HealthTimeZoneHistory | undefined>;
  listTimeZoneHistory(userId: string): Promise<HealthTimeZoneHistory[]>;

  deleteForUser(userId: string): Promise<void>;
};

export class SleepGoalConflictError extends Error {
  constructor() {
    super('sleep goal already exists for effective civil date');
    this.name = 'SleepGoalConflictError';
  }
}

export class TimeZoneHistoryConflictError extends Error {
  constructor() {
    super('time-zone history already exists for effective instant');
    this.name = 'TimeZoneHistoryConflictError';
  }
}

export class HealthMetricsConnectionMismatchError extends Error {
  constructor() {
    super('health metrics connection does not belong to user');
    this.name = 'HealthMetricsConnectionMismatchError';
  }
}

export function healthMetricsExposesRawSamplePersistence(store: object): boolean {
  return Object.keys(store).some((name) => /sample/i.test(name));
}

export function parseHealthSyncDataType(value: unknown): HealthSyncDataType {
  if (typeof value === 'string' && (HEALTH_SYNC_DATA_TYPES as readonly string[]).includes(value)) {
    return value as HealthSyncDataType;
  }
  throw new Error('invalid health sync data type');
}

export function parseHealthTimeZoneHistory(input: unknown): HealthTimeZoneHistory {
  const value = input as HealthTimeZoneHistory;
  if (!value || typeof value !== 'object') {
    throw new Error('invalid time-zone history');
  }
  const userId = String(value.userId ?? '').trim();
  const ianaTimeZone = String(value.ianaTimeZone ?? '').trim();
  const effectiveAt = String(value.effectiveAt ?? '');
  if (!userId || userId.length > 128) {
    throw new Error('invalid time-zone history user');
  }
  if (!ianaTimeZone || ianaTimeZone.length > 128) {
    throw new Error('invalid IANA time zone');
  }
  if (Number.isNaN(Date.parse(effectiveAt))) {
    throw new Error('invalid time-zone history effectiveAt');
  }
  return {
    userId,
    ianaTimeZone,
    effectiveAt: new Date(effectiveAt).toISOString(),
    isBackfillAnchor: value.isBackfillAnchor === true,
  };
}

export function parseHealthSyncCursor(input: unknown): HealthSyncCursor {
  const value = input as HealthSyncCursor;
  if (!value || typeof value !== 'object') {
    throw new Error('invalid health sync cursor');
  }
  const connectionId = String(value.connectionId ?? '').trim();
  if (!connectionId) {
    throw new Error('invalid health sync cursor connection');
  }
  return {
    connectionId,
    dataType: parseHealthSyncDataType(value.dataType),
    successfulWatermark: optionalDate(value.successfulWatermark),
    lastErrorCode: value.lastErrorCode == null || value.lastErrorCode === '' ? undefined : String(value.lastErrorCode),
    retryCount: parseNonNegativeInteger(value.retryCount ?? 0, 'retryCount'),
    nextAttemptAt: optionalDate(value.nextAttemptAt),
  };
}

export function mergeHeartRateMinuteUpsert(
  existing: HeartRateMinuteAggregate,
  incoming: HeartRateMinuteAggregate,
): HeartRateMinuteAggregate {
  const preserveLocalAssociation =
    incoming.ianaTimeZone == null && incoming.utcOffsetMinutes === existing.utcOffsetMinutes;
  return parseHeartRateMinuteAggregate({
    ...incoming,
    utcOffsetMinutes: incoming.utcOffsetMinutes,
    avgBpm: incoming.avgBpm,
    minBpm: incoming.minBpm,
    maxBpm: incoming.maxBpm,
    sampleCount: incoming.sampleCount,
    coverageSeconds: incoming.coverageSeconds,
    activityLevel: incoming.activityLevel,
    ianaTimeZone: preserveLocalAssociation ? existing.ianaTimeZone : incoming.ianaTimeZone,
    civilDate: preserveLocalAssociation ? existing.civilDate : incoming.civilDate,
    localMinuteOfDay: preserveLocalAssociation ? existing.localMinuteOfDay : incoming.localMinuteOfDay,
  });
}

function parseNonNegativeInteger(value: unknown, column: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`invalid ${column}`);
  }
  return value;
}

function optionalDate(value: unknown): Date | undefined {
  if (value == null || value === '') {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error('invalid timestamp');
  }
  return date;
}

export function asIsoInstant(value: unknown, column: string): string {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  throw new Error(`invalid ${column}`);
}

export function asCivilDate(value: unknown, column: string): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  throw new Error(`invalid ${column}`);
}

export function asDate(value: unknown, column: string): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid ${column}`);
  }
  return date;
}

function parseJsonValue(value: unknown, column: string): unknown {
  if (value === null || value === undefined) {
    throw new Error(`invalid ${column}`);
  }
  if (typeof value === 'string') {
    return JSON.parse(value);
  }
  return value;
}

export function mapHeartRateMinuteAggregateRow(row: Record<string, unknown>): HeartRateMinuteAggregate {
  return parseHeartRateMinuteAggregate({
    userId: String(row.user_id),
    sourceFamily: row.source_family,
    minuteStartUtc: asIsoInstant(row.minute_start_utc, 'heart_rate_minute_aggregates.minute_start_utc'),
    civilDate: asCivilDate(row.civil_date, 'heart_rate_minute_aggregates.civil_date'),
    utcOffsetMinutes: Number(row.utc_offset),
    ianaTimeZone: row.iana_time_zone == null ? null : String(row.iana_time_zone),
    localMinuteOfDay: Number(row.local_minute_of_day),
    avgBpm: Number(row.avg_bpm),
    minBpm: Number(row.min_bpm),
    maxBpm: Number(row.max_bpm),
    sampleCount: Number(row.sample_count),
    coverageSeconds: Number(row.coverage_seconds),
    activityLevel: row.activity_level,
  });
}

export function mapActivityLevelIntervalRow(row: Record<string, unknown>): ActivityLevelInterval {
  return parseActivityLevelInterval({
    userId: String(row.user_id),
    sourceFamily: row.source_family,
    startTime: asIsoInstant(row.interval_start_utc, 'activity_level_intervals.interval_start_utc'),
    endTime: asIsoInstant(row.interval_end_utc, 'activity_level_intervals.interval_end_utc'),
    activityLevelType: row.activity_level_type,
  });
}

export function mapDailyHeartRateZonesRow(row: Record<string, unknown>): DailyHeartRateZones {
  return parseDailyHeartRateZones({
    userId: String(row.user_id),
    sourceFamily: row.source_family,
    date: asCivilDate(row.civil_date, 'daily_heart_rate_zones.civil_date'),
    zones: parseJsonValue(row.zones, 'daily_heart_rate_zones.zones'),
  });
}

export function mapDailyTimeInZoneRow(row: Record<string, unknown>): DailyTimeInZone {
  return parseDailyTimeInZone({
    userId: String(row.user_id),
    sourceFamily: row.source_family,
    date: asCivilDate(row.civil_date, 'daily_time_in_zone.civil_date'),
    minutes: {
      light: Number(row.light_minutes),
      moderate: Number(row.moderate_minutes),
      vigorous: Number(row.vigorous_minutes),
      peak: Number(row.peak_minutes),
    },
  });
}

export function mapExerciseIntervalRow(row: Record<string, unknown>): ExerciseInterval {
  return parseExerciseInterval({
    userId: String(row.user_id),
    sourceFamily: row.source_family,
    sourceRecordId: String(row.source_record_id),
    startTime: asIsoInstant(row.start_time_utc, 'exercise_intervals.start_time_utc'),
    endTime: asIsoInstant(row.end_time_utc, 'exercise_intervals.end_time_utc'),
    utcOffsetMinutes: Number(row.utc_offset),
    civilDate: asCivilDate(row.civil_date, 'exercise_intervals.civil_date'),
  });
}

export function mapDailyCardioRow(row: Record<string, unknown>): DailyCardio {
  return parseDailyCardio({
    userId: String(row.user_id),
    date: asCivilDate(row.civil_date, 'daily_cardio.civil_date'),
    status: row.status,
    strain: row.strain == null ? null : Number(row.strain),
    dose: row.dose == null ? null : Number(row.dose),
    zoneMinutes: {
      light: Number(row.light_minutes),
      moderate: Number(row.moderate_minutes),
      vigorous: Number(row.vigorous_minutes),
      peak: Number(row.peak_minutes),
    },
    knownContextMinutes: Number(row.known_context_minutes),
    rawCoverageMinutes: Number(row.raw_coverage_minutes),
    attributedMinutes: Number(row.attributed_minutes),
    metricVersion: row.metric_version ?? WHOOP_STYLE_METRIC_VERSION,
  });
}

export function mapMetricResultRow(row: Record<string, unknown>): MetricResult {
  return parseMetricResult({
    userId: String(row.user_id),
    civilDate: asCivilDate(row.civil_date, 'metric_results.civil_date'),
    metricName: row.metric_name,
    metricVersion: row.metric_version,
    score: row.score == null ? null : Number(row.score),
    status: row.status ?? null,
    quality: row.quality ?? null,
    reason: row.reason ?? null,
    evidence: parseJsonValue(row.evidence, 'metric_results.evidence'),
    source: parseJsonValue(row.source, 'metric_results.source'),
    coverage: parseJsonValue(row.coverage, 'metric_results.coverage'),
  });
}

export function mapSleepGoalRow(row: Record<string, unknown>): SleepGoal {
  return parseSleepGoal({
    userId: String(row.user_id),
    goalMinutes: Number(row.goal_minutes),
    effectiveCivilDate: asCivilDate(row.effective_civil_date, 'user_sleep_goal_history.effective_civil_date'),
  });
}

export function mapHealthTimeZoneHistoryRow(row: Record<string, unknown>): HealthTimeZoneHistory {
  return parseHealthTimeZoneHistory({
    userId: String(row.user_id),
    ianaTimeZone: String(row.iana_time_zone),
    effectiveAt: asIsoInstant(row.effective_at, 'user_health_time_zone_history.effective_at'),
    isBackfillAnchor: row.is_backfill_anchor === true,
  });
}

export function mapHealthSyncCursorRow(row: Record<string, unknown>): HealthSyncCursor {
  return parseHealthSyncCursor({
    connectionId: String(row.connection_id),
    dataType: row.data_type,
    successfulWatermark: row.successful_watermark ?? undefined,
    lastErrorCode: row.last_error_code ?? undefined,
    retryCount: row.retry_count ?? 0,
    nextAttemptAt: row.next_attempt_at ?? undefined,
  });
}

export function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === '23505');
}

export type {
  ActivityLevelInterval,
  DailyCardio,
  DailyHeartRateZones,
  DailyTimeInZone,
  ExerciseInterval,
  HeartRateMinuteAggregate,
  MetricResult,
  SleepGoal,
} from '../../domain/cardio-records';

export {
  parseActivityLevelInterval,
  parseDailyCardio,
  parseDailyHeartRateZones,
  parseDailyTimeInZone,
  parseExerciseInterval,
  parseHeartRateMinuteAggregate,
  parseMetricResult,
  parseSleepGoal,
};
