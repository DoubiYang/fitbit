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
import type { BodyAgeDataGaps, BodyAgeEstimate, BodyAgeProfile, BodyAgeRoute, BodyAgeStatus, BodyAgeValue, DailyVo2Input } from '../../domain/body-age';
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
  'daily-vo2-max',
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

export type StoredBodyAgeProfile = BodyAgeProfile & {
  userId: string;
  firstObservedHrPeakAt?: string;
  latestObservedHrPeakAt?: string;
};

export type BodyAgeProfileUpdate = {
  userId: string;
  birthDate: string | null;
  referenceSex: 'male' | 'female' | null;
};

export type ObservedHrPeakWrite = {
  userId: string;
  observedHrPeakBpm: number;
  observedAt: string;
};

export type StoredDailyVo2 = DailyVo2Input & {
  userId: string;
};

export type AuthoritativeDailyVo2Replace = {
  userId: string;
  fromCivilDate: string;
  toCivilDate: string;
  rows: StoredDailyVo2[];
};

export type BodyAgeExclusionCounts = {
  invalidDailyVo2: number;
  futureDailyVo2: number;
  untrustedDailyVo2: number;
  invalidDailyRhr: number;
  futureDailyRhr: number;
  untrustedDailyRhr: number;
};

export type BodyAgeResultWrite = {
  userId: string;
  algorithmVersion: string;
  estimate: BodyAgeEstimate;
  lastCalculatedCivilDate: string;
  referenceHash: string;
  inputFingerprint: string;
  profileRevision: number;
  chronologicalAgeDeltaYears: number | null;
  windowDays: number;
  exclusionCounts: BodyAgeExclusionCounts;
  computedAt: string;
};

export type StoredBodyAgeResult = BodyAgeResultWrite;

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

  getBodyAgeProfile(input: { userId: string }): Promise<StoredBodyAgeProfile | undefined>;
  updateBodyAgeProfile(input: BodyAgeProfileUpdate): Promise<StoredBodyAgeProfile>;
  recordObservedHrPeak(input: ObservedHrPeakWrite): Promise<StoredBodyAgeProfile>;

  upsertDailyVo2(rows: StoredDailyVo2[]): Promise<void>;
  authoritativelyReplaceDailyVo2(input: AuthoritativeDailyVo2Replace): Promise<void>;
  listDailyVo2(input: { userId: string; fromCivilDate: string; toCivilDate: string }): Promise<StoredDailyVo2[]>;

  writeBodyAgeResult(input: BodyAgeResultWrite): Promise<void>;
  readLatestBodyAgeResult(input: { userId: string; algorithmVersion: string }): Promise<StoredBodyAgeResult | undefined>;

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

function parseBodyAgeUserId(value: unknown, column = 'userId'): string {
  const userId = String(value ?? '').trim();
  if (!userId || userId.length > 128) {
    throw new Error(`invalid body-age ${column}`);
  }
  return userId;
}

function parseBodyAgeCivilDate(value: unknown, column: string): string {
  const civilDate = typeof value === 'string' ? value : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(civilDate)) {
    throw new Error(`invalid ${column}`);
  }
  const date = new Date(`${civilDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== civilDate) {
    throw new Error(`invalid ${column}`);
  }
  return civilDate;
}

function parseReferenceSex(value: unknown): 'male' | 'female' | undefined {
  if (value == null || value === '') return undefined;
  if (value === 'male' || value === 'female') return value;
  throw new Error('invalid body-age reference sex');
}

function parseNonNegativeBodyAgeInteger(value: unknown, column: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid ${column}`);
  }
  return value;
}

function parseBodyAgeDataGaps(value: unknown): BodyAgeDataGaps {
  const gaps = value as BodyAgeDataGaps;
  if (!gaps || typeof gaps !== 'object') {
    throw new Error('invalid body-age data gaps');
  }
  if (typeof gaps.observedHrPeakRequired !== 'boolean') {
    throw new Error('invalid observedHrPeakRequired');
  }
  return {
    dailyVo2DaysNeeded: parseNonNegativeBodyAgeInteger(gaps.dailyVo2DaysNeeded, 'dailyVo2DaysNeeded'),
    rhrDaysNeeded: parseNonNegativeBodyAgeInteger(gaps.rhrDaysNeeded, 'rhrDaysNeeded'),
    observedHrPeakRequired: gaps.observedHrPeakRequired,
  };
}

function parseBodyAgeExclusionCounts(value: unknown): BodyAgeExclusionCounts {
  const counts = value as BodyAgeExclusionCounts;
  if (!counts || typeof counts !== 'object') {
    throw new Error('invalid body-age exclusion counts');
  }
  return {
    invalidDailyVo2: parseNonNegativeBodyAgeInteger(counts.invalidDailyVo2, 'invalidDailyVo2'),
    futureDailyVo2: parseNonNegativeBodyAgeInteger(counts.futureDailyVo2, 'futureDailyVo2'),
    untrustedDailyVo2: parseNonNegativeBodyAgeInteger(counts.untrustedDailyVo2, 'untrustedDailyVo2'),
    invalidDailyRhr: parseNonNegativeBodyAgeInteger(counts.invalidDailyRhr, 'invalidDailyRhr'),
    futureDailyRhr: parseNonNegativeBodyAgeInteger(counts.futureDailyRhr, 'futureDailyRhr'),
    untrustedDailyRhr: parseNonNegativeBodyAgeInteger(counts.untrustedDailyRhr, 'untrustedDailyRhr'),
  };
}

function parseBodyAgeValue(value: unknown): BodyAgeValue | null {
  if (value == null) return null;
  if (value === 'below_reference_min' || value === 'above_reference_max') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 130) return value;
  throw new Error('invalid body-age value');
}

function parseBodyAgeRoute(value: unknown): BodyAgeRoute {
  if (value === null || value === 'daily_vo2' || value === 'observed_peak_ratio') return value;
  throw new Error('invalid body-age route');
}

function parseBodyAgeStatus(value: unknown): BodyAgeStatus {
  if (
    value === 'profile_missing'
    || value === 'data_accumulating'
    || value === 'daily_vo2_provisional'
    || value === 'daily_vo2_stable'
    || value === 'observed_peak_ratio_provisional'
    || value === 'stale'
  ) {
    return value;
  }
  throw new Error('invalid body-age status');
}

function parseBodyAgeEstimate(value: unknown): BodyAgeEstimate {
  const estimate = value as BodyAgeEstimate;
  if (!estimate || typeof estimate !== 'object') {
    throw new Error('invalid body-age estimate');
  }
  const referenceVersion = String(estimate.referenceVersion ?? '').trim();
  if (!referenceVersion || referenceVersion.length > 256) {
    throw new Error('invalid body-age reference version');
  }
  if (estimate.disclaimer !== 'non_medical_non_calibrated_estimate') {
    throw new Error('invalid body-age disclaimer');
  }
  return {
    age: parseBodyAgeValue(estimate.age),
    coverageDays: parseNonNegativeBodyAgeInteger(estimate.coverageDays, 'coverageDays'),
    latestInputCivilDate: estimate.latestInputCivilDate == null
      ? null
      : parseBodyAgeCivilDate(estimate.latestInputCivilDate, 'latestInputCivilDate'),
    route: parseBodyAgeRoute(estimate.route),
    status: parseBodyAgeStatus(estimate.status),
    referenceVersion,
    disclaimer: 'non_medical_non_calibrated_estimate',
    dataGaps: parseBodyAgeDataGaps(estimate.dataGaps),
  };
}

function parseNonEmptyBodyAgeText(value: unknown, column: string): string {
  const text = String(value ?? '').trim();
  if (!text || text.length > 512) {
    throw new Error(`invalid ${column}`);
  }
  return text;
}

export function parseStoredBodyAgeProfile(input: unknown): StoredBodyAgeProfile {
  const value = input as StoredBodyAgeProfile;
  if (!value || typeof value !== 'object') {
    throw new Error('invalid body-age profile');
  }
  const observedHrPeakBpm = value.observedHrPeakBpm;
  if (
    observedHrPeakBpm != null
    && (typeof observedHrPeakBpm !== 'number' || !Number.isFinite(observedHrPeakBpm)
      || observedHrPeakBpm < 100 || observedHrPeakBpm > 230)
  ) {
    throw new Error('invalid observed HR peak');
  }
  const firstObservedHrPeakAt = value.firstObservedHrPeakAt == null
    ? undefined
    : asIsoInstant(value.firstObservedHrPeakAt, 'firstObservedHrPeakAt');
  const latestObservedHrPeakAt = value.latestObservedHrPeakAt == null
    ? undefined
    : asIsoInstant(value.latestObservedHrPeakAt, 'latestObservedHrPeakAt');
  if ((observedHrPeakBpm == null) !== (firstObservedHrPeakAt == null)
    || (observedHrPeakBpm == null) !== (latestObservedHrPeakAt == null)
    || (firstObservedHrPeakAt && latestObservedHrPeakAt && firstObservedHrPeakAt > latestObservedHrPeakAt)) {
    throw new Error('invalid observed HR peak history');
  }
  return {
    userId: parseBodyAgeUserId(value.userId),
    birthDate: value.birthDate == null ? undefined : parseBodyAgeCivilDate(value.birthDate, 'birthDate'),
    referenceSex: parseReferenceSex(value.referenceSex),
    profileRevision: parseNonNegativeBodyAgeInteger(value.profileRevision, 'profileRevision'),
    observedHrPeakBpm,
    firstObservedHrPeakAt,
    latestObservedHrPeakAt,
  };
}

export function parseBodyAgeProfileUpdate(input: unknown): BodyAgeProfileUpdate {
  const value = input as BodyAgeProfileUpdate;
  if (!value || typeof value !== 'object') {
    throw new Error('invalid body-age profile update');
  }
  if (value.birthDate !== null && typeof value.birthDate !== 'string') {
    throw new Error('invalid birthDate');
  }
  if (value.referenceSex !== null && value.referenceSex !== 'male' && value.referenceSex !== 'female') {
    throw new Error('invalid body-age reference sex');
  }
  return {
    userId: parseBodyAgeUserId(value.userId),
    birthDate: value.birthDate === null ? null : parseBodyAgeCivilDate(value.birthDate, 'birthDate'),
    referenceSex: value.referenceSex,
  };
}

export function parseBodyAgeProfileRead(input: unknown): { userId: string } {
  const value = input as { userId: unknown };
  if (!value || typeof value !== 'object') throw new Error('invalid body-age profile read');
  return { userId: parseBodyAgeUserId(value.userId) };
}

export function parseObservedHrPeakWrite(input: unknown): ObservedHrPeakWrite {
  const value = input as ObservedHrPeakWrite;
  if (!value || typeof value !== 'object'
    || typeof value.observedHrPeakBpm !== 'number'
    || !Number.isFinite(value.observedHrPeakBpm)
    || value.observedHrPeakBpm < 100
    || value.observedHrPeakBpm > 230
  ) {
    throw new Error('invalid observed HR peak write');
  }
  return {
    userId: parseBodyAgeUserId(value.userId),
    observedHrPeakBpm: value.observedHrPeakBpm,
    observedAt: asIsoInstant(value.observedAt, 'observedAt'),
  };
}

export function parseStoredDailyVo2(input: unknown): StoredDailyVo2 {
  const value = input as StoredDailyVo2;
  if (!value || typeof value !== 'object'
    || typeof value.vo2Max !== 'number'
    || !Number.isFinite(value.vo2Max)
    || value.vo2Max <= 0
    || value.sourceFamily !== 'google-wearables'
  ) {
    throw new Error('invalid daily VO2');
  }
  return {
    userId: parseBodyAgeUserId(value.userId),
    civilDate: parseBodyAgeCivilDate(value.civilDate, 'daily VO2 civilDate'),
    vo2Max: value.vo2Max,
    sourceFamily: 'google-wearables',
    receivedAt: asStrictRfc3339Instant(value.receivedAt, 'daily VO2 receivedAt'),
    revision: parseNonNegativeBodyAgeInteger(value.revision, 'daily VO2 revision'),
    estimated: value.estimated === true,
  };
}

function dailyVo2Equal(left: StoredDailyVo2, right: StoredDailyVo2): boolean {
  return left.vo2Max === right.vo2Max && left.estimated === right.estimated;
}

/** Resolves same-date writes independently of the order a provider page happens to arrive in. */
export function selectNewestDailyVo2(existing: StoredDailyVo2, candidate: StoredDailyVo2): StoredDailyVo2 {
  const byReceipt = Date.parse(candidate.receivedAt) - Date.parse(existing.receivedAt);
  if (byReceipt > 0 || (byReceipt === 0 && candidate.revision > existing.revision)) {
    return candidate;
  }
  if (byReceipt < 0 || candidate.revision < existing.revision) {
    return existing;
  }
  if (!dailyVo2Equal(existing, candidate)) {
    throw new Error(`conflicting daily VO2 revisions for ${candidate.civilDate}`);
  }
  return existing;
}

export function normalizeDailyVo2Writes(rows: StoredDailyVo2[]): StoredDailyVo2[] {
  const byUserAndDate = new Map<string, StoredDailyVo2[]>();
  for (const row of rows) {
    const parsed = parseStoredDailyVo2(row);
    const key = `${parsed.userId}\0${parsed.civilDate}`;
    const candidates = byUserAndDate.get(key) ?? [];
    candidates.push(parsed);
    byUserAndDate.set(key, candidates);
  }
  return [...byUserAndDate.values()].map((candidates) => {
    const highest = candidates.reduce((current, candidate) => {
      const byReceipt = Date.parse(candidate.receivedAt) - Date.parse(current.receivedAt);
      return byReceipt > 0 || (byReceipt === 0 && candidate.revision > current.revision) ? candidate : current;
    });
    for (const candidate of candidates) {
      if (
        Date.parse(candidate.receivedAt) === Date.parse(highest.receivedAt)
        && candidate.revision === highest.revision
        && !dailyVo2Equal(candidate, highest)
      ) {
        throw new Error(`conflicting daily VO2 revisions for ${candidate.civilDate}`);
      }
    }
    return highest;
  });
}

export function parseAuthoritativeDailyVo2Replace(input: unknown): AuthoritativeDailyVo2Replace {
  const value = input as AuthoritativeDailyVo2Replace;
  if (!value || typeof value !== 'object' || !Array.isArray(value.rows)) {
    throw new Error('invalid daily VO2 replacement');
  }
  const userId = parseBodyAgeUserId(value.userId);
  const fromCivilDate = parseBodyAgeCivilDate(value.fromCivilDate, 'daily VO2 replacement fromCivilDate');
  const toCivilDate = parseBodyAgeCivilDate(value.toCivilDate, 'daily VO2 replacement toCivilDate');
  if (fromCivilDate > toCivilDate) {
    throw new Error('invalid daily VO2 replacement window');
  }
  const rows = normalizeDailyVo2Writes(value.rows);
  for (const row of rows) {
    if (row.userId !== userId || row.civilDate < fromCivilDate || row.civilDate > toCivilDate) {
      throw new Error('daily VO2 replacement row outside user window');
    }
  }
  return { userId, fromCivilDate, toCivilDate, rows };
}

export function parseDailyVo2ListInput(input: unknown): { userId: string; fromCivilDate: string; toCivilDate: string } {
  const value = input as { userId: unknown; fromCivilDate: unknown; toCivilDate: unknown };
  if (!value || typeof value !== 'object') throw new Error('invalid daily VO2 list input');
  const fromCivilDate = parseBodyAgeCivilDate(value.fromCivilDate, 'daily VO2 fromCivilDate');
  const toCivilDate = parseBodyAgeCivilDate(value.toCivilDate, 'daily VO2 toCivilDate');
  if (fromCivilDate > toCivilDate) throw new Error('invalid daily VO2 list window');
  return { userId: parseBodyAgeUserId(value.userId), fromCivilDate, toCivilDate };
}

export function parseBodyAgeResultWrite(input: unknown): BodyAgeResultWrite {
  const value = input as BodyAgeResultWrite;
  if (!value || typeof value !== 'object') {
    throw new Error('invalid body-age result');
  }
  const estimate = parseBodyAgeEstimate(value.estimate);
  const chronologicalAgeDeltaYears = value.chronologicalAgeDeltaYears;
  if (chronologicalAgeDeltaYears !== null && (
    typeof chronologicalAgeDeltaYears !== 'number'
    || !Number.isFinite(chronologicalAgeDeltaYears)
    || chronologicalAgeDeltaYears < -130
    || chronologicalAgeDeltaYears > 130
  )) {
    throw new Error('invalid chronological age delta');
  }
  if (
    (estimate.status === 'profile_missing' || estimate.status === 'data_accumulating')
    && (estimate.route !== null || estimate.age !== null || chronologicalAgeDeltaYears !== null)
  ) {
    throw new Error(`invalid ${estimate.status} body-age result`);
  }
  if (
    (estimate.status === 'daily_vo2_provisional' || estimate.status === 'daily_vo2_stable')
    && (estimate.route !== 'daily_vo2' || estimate.age === null)
  ) {
    throw new Error(`invalid ${estimate.status} body-age result`);
  }
  if (
    estimate.status === 'observed_peak_ratio_provisional'
    && (estimate.route !== 'observed_peak_ratio' || estimate.age === null)
  ) {
    throw new Error('invalid observed_peak_ratio_provisional body-age result');
  }
  if (
    estimate.status === 'stale'
    && (estimate.route === null || estimate.age !== null || chronologicalAgeDeltaYears !== null)
  ) {
    throw new Error('invalid stale body-age result');
  }
  if (chronologicalAgeDeltaYears !== null && typeof estimate.age !== 'number') {
    throw new Error('invalid chronological age delta');
  }
  return {
    userId: parseBodyAgeUserId(value.userId),
    algorithmVersion: parseNonEmptyBodyAgeText(value.algorithmVersion, 'algorithmVersion'),
    estimate,
    lastCalculatedCivilDate: parseBodyAgeCivilDate(value.lastCalculatedCivilDate, 'lastCalculatedCivilDate'),
    referenceHash: parseNonEmptyBodyAgeText(value.referenceHash, 'referenceHash'),
    inputFingerprint: parseNonEmptyBodyAgeText(value.inputFingerprint, 'inputFingerprint'),
    profileRevision: parseNonNegativeBodyAgeInteger(value.profileRevision, 'profileRevision'),
    chronologicalAgeDeltaYears,
    windowDays: (() => {
      const windowDays = parseNonNegativeBodyAgeInteger(value.windowDays, 'windowDays');
      if (windowDays === 0) throw new Error('invalid windowDays');
      return windowDays;
    })(),
    exclusionCounts: parseBodyAgeExclusionCounts(value.exclusionCounts),
    computedAt: asIsoInstant(value.computedAt, 'computedAt'),
  };
}

export function parseBodyAgeResultRead(input: unknown): { userId: string; algorithmVersion: string } {
  const value = input as { userId: unknown; algorithmVersion: unknown };
  if (!value || typeof value !== 'object') throw new Error('invalid body-age result read');
  return {
    userId: parseBodyAgeUserId(value.userId),
    algorithmVersion: parseNonEmptyBodyAgeText(value.algorithmVersion, 'algorithmVersion'),
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

function asStrictRfc3339Instant(value: unknown, column: string): string {
  if (
    typeof value !== 'string'
    || !/^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(value)
  ) {
    throw new Error(`invalid ${column}`);
  }
  const civilDate = value.slice(0, 10);
  const calendarDate = new Date(`${civilDate}T00:00:00.000Z`);
  const instant = new Date(value);
  if (
    Number.isNaN(calendarDate.getTime())
    || calendarDate.toISOString().slice(0, 10) !== civilDate
    || Number.isNaN(instant.getTime())
  ) {
    throw new Error(`invalid ${column}`);
  }
  return instant.toISOString();
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
    provenance: mapStrainProvenance(row, 'daily_cardio'),
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
    provenance: mapStrainProvenance(row, 'metric_results'),
    qualityFlags: row.quality_flags ?? [],
  });
}

function mapStrainProvenance(row: Record<string, unknown>, table: string): unknown {
  if (row.provenance_version == null) return undefined;

  return {
    provenanceVersion: Number(row.provenance_version),
    inputFingerprint: row.input_fingerprint,
    calculationContext: parseJsonValue(row.calculation_context, `${table}.calculation_context`),
  };
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

export function mapStoredBodyAgeProfileRow(row: Record<string, unknown>): StoredBodyAgeProfile {
  return parseStoredBodyAgeProfile({
    userId: String(row.user_id),
    birthDate: row.birth_date == null ? undefined : asCivilDate(row.birth_date, 'user_body_age_profiles.birth_date'),
    referenceSex: row.reference_sex == null ? undefined : row.reference_sex,
    profileRevision: Number(row.profile_revision),
    observedHrPeakBpm: row.historical_observed_hr_peak_bpm == null ? undefined : Number(row.historical_observed_hr_peak_bpm),
    firstObservedHrPeakAt: row.first_observed_hr_peak_at == null
      ? undefined
      : asIsoInstant(row.first_observed_hr_peak_at, 'user_body_age_profiles.first_observed_hr_peak_at'),
    latestObservedHrPeakAt: row.latest_observed_hr_peak_at == null
      ? undefined
      : asIsoInstant(row.latest_observed_hr_peak_at, 'user_body_age_profiles.latest_observed_hr_peak_at'),
  });
}

export function mapStoredDailyVo2Row(row: Record<string, unknown>): StoredDailyVo2 {
  return parseStoredDailyVo2({
    userId: String(row.user_id),
    civilDate: asCivilDate(row.civil_date, 'air_daily_vo2.civil_date'),
    vo2Max: Number(row.vo2_max),
    sourceFamily: row.source_family,
    receivedAt: asIsoInstant(row.received_at, 'air_daily_vo2.received_at'),
    revision: Number(row.revision),
    estimated: row.estimated === true,
  });
}

export function mapStoredBodyAgeResultRow(row: Record<string, unknown>): StoredBodyAgeResult {
  const ageBoundary = row.age_boundary == null ? null : row.age_boundary;
  return parseBodyAgeResultWrite({
    userId: String(row.user_id),
    algorithmVersion: row.algorithm_version,
    estimate: {
      age: ageBoundary ?? (row.age_years == null ? null : Number(row.age_years)),
      coverageDays: Number(row.coverage_days),
      latestInputCivilDate: row.latest_input_civil_date == null
        ? null
        : asCivilDate(row.latest_input_civil_date, 'body_age_results.latest_input_civil_date'),
      route: row.route ?? null,
      status: row.status,
      referenceVersion: row.reference_version,
      disclaimer: 'non_medical_non_calibrated_estimate',
      dataGaps: parseJsonValue(row.data_gaps, 'body_age_results.data_gaps'),
    },
    lastCalculatedCivilDate: asCivilDate(row.last_calculated_civil_date, 'body_age_results.last_calculated_civil_date'),
    referenceHash: row.reference_hash,
    inputFingerprint: row.input_fingerprint,
    profileRevision: Number(row.profile_revision),
    chronologicalAgeDeltaYears: row.chronological_age_delta_years == null ? null : Number(row.chronological_age_delta_years),
    windowDays: Number(row.window_days),
    exclusionCounts: parseJsonValue(row.exclusion_counts, 'body_age_results.exclusion_counts'),
    computedAt: asIsoInstant(row.computed_at, 'body_age_results.computed_at'),
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
