import { createHash } from 'node:crypto';

import {
  computeDailyTrimp,
  computeUsableLoad,
  computeWeeklyBuildBaseline,
  deriveQualifiedHeartRate,
  isQualifiedDay,
  type DerivedHeartRateSegment,
  type TimeInterval,
} from '../../domain/cardio-load-trimp';
import { parseDailyCardioLoad, parseDailyLoadCapacity, parseWeeklyCardioBaseline, type HeartRateMinuteAggregate } from '../../domain/cardio-records';
import { selectPrimarySleepSession } from '../../domain/metrics';
import { CARDIO_LOAD_TRIMP_VERSION, WHOOP_STYLE_METRIC_VERSION } from '../../domain/metric-types';
import type { DailyRhr, SleepSession } from '../../domain/health-records';
import type { AuthStore } from '../auth/types';
import { strainLocalDayBoundsForTimeZone } from './strain-provenance';
import type { UserHealthRecords } from './provider';

const SOURCE_FAMILY = 'google-wearables' as const;
const HR_MAX_FILTER_RULE_VERSION = 'google-wearables-hrmax-v1' as const;
const ACTIVE_LEVELS = new Set(['LIGHTLY_ACTIVE', 'MODERATELY_ACTIVE', 'VERY_ACTIVE']);
const RETAIN_CIVIL_DAYS = 42;

type HrMaxCandidate = {
  minuteStartUtc: string;
  bpm: number;
  coverageSeconds: number;
  sampleCount: number;
};

function addCivilDays(civilDate: string, days: number): string {
  const result = new Date(`${civilDate}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

function civilDatesInclusive(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let current = from; current <= to; current = addCivilDays(current, 1)) {
    dates.push(current);
  }
  return dates;
}

function civilDateAt(instant: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function weekStart(civilDate: string): string {
  const date = new Date(`${civilDate}T00:00:00.000Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  return addCivilDays(civilDate, -offset);
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function intervalsOverlap(left: TimeInterval, right: TimeInterval): boolean {
  return Date.parse(left.start) < Date.parse(right.end) && Date.parse(right.start) < Date.parse(left.end);
}

function toTimeIntervals(rows: Array<{ startTime: string; endTime: string }>): TimeInterval[] {
  return rows.map((row) => ({ start: row.startTime, end: row.endTime }));
}

function evidenceSegments(rows: Array<{ minuteStartUtc: string; segments: Array<{ startOffsetMs: number; endOffsetMs: number; bpm: number }> }>): DerivedHeartRateSegment[] {
  return rows.flatMap((row) => {
    const start = Date.parse(row.minuteStartUtc);
    return Number.isFinite(start)
      ? row.segments.map((segment) => ({
        start: new Date(start + segment.startOffsetMs).toISOString(),
        end: new Date(start + segment.endOffsetMs).toISOString(),
        bpm: segment.bpm,
      }))
      : [];
  });
}

function candidateHrMax(minutes: HeartRateMinuteAggregate[], sleepSessions: SleepSession[]): HrMaxCandidate | undefined {
  return minutes
    .filter((minute) => minute.sourceFamily === SOURCE_FAMILY)
    .filter((minute) => minute.coverageSeconds >= 30 && minute.sampleCount >= 1)
    .filter((minute) => minute.maxBpm >= 100 && minute.maxBpm <= 230)
    .filter((minute) => !sleepSessions.some((sleep) => intervalsOverlap(
      { start: minute.minuteStartUtc, end: new Date(Date.parse(minute.minuteStartUtc) + 60_000).toISOString() },
      { start: sleep.startTime, end: sleep.endTime },
    )))
    .map((minute) => ({
      minuteStartUtc: minute.minuteStartUtc,
      bpm: minute.maxBpm,
      coverageSeconds: minute.coverageSeconds,
      sampleCount: minute.sampleCount,
    }))
    .sort((left, right) => right.bpm - left.bpm || left.minuteStartUtc.localeCompare(right.minuteStartUtc))[0];
}

function rhrBaseline(records: DailyRhr[], userId: string, targetCivilDate: string): { value: number | null; sampleCount: number } {
  const values = records
    .filter((record) => record.userId === userId && record.source === 'google_health' && record.date < targetCivilDate)
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, 28)
    .map((record) => record.valueBpm);
  return { value: values.length >= 7 ? median(values) : null, sampleCount: values.length };
}

function elevatedSeconds(input: {
  segments: DerivedHeartRateSegment[];
  rhrBaseBpm: number;
  hrMaxEstBpm: number;
}): number {
  return input.segments.reduce((total, segment) => {
    const hrr = Math.max(0, Math.min(1, (segment.bpm - input.rhrBaseBpm) / (input.hrMaxEstBpm - input.rhrBaseBpm)));
    return hrr >= 0.3 ? total + (Date.parse(segment.end) - Date.parse(segment.start)) / 1_000 : total;
  }, 0);
}

function motionSource(input: {
  day: TimeInterval;
  activity: Array<{ startTime: string; endTime: string; activityLevelType: string }>;
  exercise: Array<{ startTime: string; endTime: string }>;
}): 'activity_level' | 'exercise' | 'both' | 'none' {
  const hasActivity = input.activity.some((row) => ACTIVE_LEVELS.has(row.activityLevelType) && intervalsOverlap(input.day, { start: row.startTime, end: row.endTime }));
  const hasExercise = input.exercise.some((row) => intervalsOverlap(input.day, { start: row.startTime, end: row.endTime }));
  return hasActivity && hasExercise ? 'both' : hasActivity ? 'activity_level' : hasExercise ? 'exercise' : 'none';
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export async function recomputeTrimpWeeklyBaselines(input: {
  store: AuthStore;
  userId: string;
  timeZone: string;
  now: Date;
  fromCivilDate: string;
}): Promise<void> {
  const nowCivilDate = civilDateAt(input.now, input.timeZone);
  const currentWeekStart = weekStart(nowCivilDate);
  // A current-day replay still needs the preceding four completed local weeks.
  // Otherwise an hourly write would overwrite an established baseline with
  // "calibrating" merely because its own invalidation began today.
  const fourWeeksBeforeCurrent = weekStart(addCivilDays(currentWeekStart, -28));
  const firstWeekStart = input.fromCivilDate < fourWeeksBeforeCurrent
    ? weekStart(input.fromCivilDate)
    : fourWeeksBeforeCurrent;
  const daily = await input.store.healthMetrics.listDailyCardioLoads({
    userId: input.userId,
    fromCivilDate: firstWeekStart,
    toCivilDate: addCivilDays(currentWeekStart, 6),
  });
  const byDate = new Map(daily.map((row) => [row.civilDate, row]));
  const completedWeeks: Array<{ weekStart: string; qualifiedDayCount: number; weeklyLoad: number | null }> = [];
  const preceding = await input.store.healthMetrics.getWeeklyCardioBaseline({
    userId: input.userId,
    weekStart: addCivilDays(firstWeekStart, -7),
  });
  let previousStableBaseline: number | null = preceding?.baseline ?? null;
  let previousWeekEwma: number | null = preceding?.ewma4 ?? null;

  for (let start = firstWeekStart; start <= currentWeekStart; start = addCivilDays(start, 7)) {
    const dates = civilDatesInclusive(start, addCivilDays(start, 6));
    const completed = addCivilDays(start, 7) <= nowCivilDate;
    const qualified = dates.filter((date) => {
      const row = byDate.get(date);
      return row?.status === 'scored' && row.dailyLoad !== null && row.qualityState === 'qualified';
    });
    const weeklyLoad = completed && qualified.length === 7
      ? round(qualified.reduce((total, date) => total + byDate.get(date)!.dailyLoad!, 0))
      : null;
    if (completed) {
      completedWeeks.push({ weekStart: start, qualifiedDayCount: qualified.length, weeklyLoad });
    }
    const baseline = computeWeeklyBuildBaseline({
      targetWeekStart: start,
      completedWeeks,
      priorStableBaseline: previousStableBaseline,
      priorWeekEwma: previousWeekEwma,
    });
    const weekToDateLoad = dates
      .filter((date) => date <= nowCivilDate)
      .reduce((total, date) => total + (byDate.get(date)?.dailyLoad ?? 0), 0);
    await input.store.healthMetrics.upsertWeeklyCardioBaseline(parseWeeklyCardioBaseline({
      userId: input.userId,
      weekStart: start,
      metricVersion: CARDIO_LOAD_TRIMP_VERSION,
      status: baseline.status,
      weeklyLoad,
      weekToDateLoad: round(weekToDateLoad),
      rm4: baseline.rm4,
      ewma4: baseline.ewma4,
      baseline: baseline.baseline,
      inputFingerprint: fingerprint({ start, dates: dates.map((date) => byDate.get(date)?.inputFingerprint ?? null), completedWeeks, baseline }),
    }));
    if (baseline.baseline !== null) previousStableBaseline = baseline.baseline;
    if (baseline.ewma4 !== null) previousWeekEwma = baseline.ewma4;
  }
}

/**
 * Replays persisted, minute-clipped BPM evidence. This code intentionally has
 * no Health API dependency: late activity or sleep metadata changes result in
 * a deterministic local recomputation instead of another remote read.
 */
export async function recomputeTrimpCardioLoad(input: {
  store: AuthStore;
  userId: string;
  now: Date;
  records: UserHealthRecords;
  fromCivilDate: string;
}): Promise<{ civilDates: string[]; hrMaxBpm: number | null }> {
  const profile = await input.store.healthMetrics.getBodyAgeProfile({ userId: input.userId });
  const timeZone = await input.store.healthMetrics.lookupTimeZoneHistory({
    userId: input.userId,
    at: input.now.toISOString(),
  });
  const nowCivilDate = timeZone ? civilDateAt(input.now, timeZone.ianaTimeZone) : input.now.toISOString().slice(0, 10);
  const earliest = addCivilDays(nowCivilDate, -(RETAIN_CIVIL_DAYS - 1));
  const requestedFromCivilDate = input.fromCivilDate < earliest ? earliest : input.fromCivilDate;
  const retainedDates = civilDatesInclusive(earliest, nowCivilDate);
  const sleepSessions = input.records.sleepSessions.filter((session) => session.userId === input.userId && session.source === 'google_health');
  const allMinutes = await input.store.healthMetrics.listMinutesInRange({
    userId: input.userId,
    fromUtc: `${addCivilDays(earliest, -1)}T00:00:00.000Z`,
    toUtcExclusive: new Date(input.now.getTime() + 60_000).toISOString(),
  });
  const hrMax = candidateHrMax(allMinutes, sleepSessions);
  const existingRetainedLoads = await input.store.healthMetrics.listDailyCardioLoads({
    userId: input.userId,
    fromCivilDate: earliest,
    toCivilDate: nowCivilDate,
  });
  const hrMaxMatchesRetainedRows = existingRetainedLoads.length === retainedDates.length
    && existingRetainedLoads.every((row) => (
      row.hrMaxEstBpm === (hrMax?.bpm ?? null)
      && row.hrMaxProvenance?.minuteStartUtc === hrMax?.minuteStartUtc
      && row.hrMaxProvenance?.bpm === hrMax?.bpm
    ));
  // HRmax is a shared parameter: a new valid peak changes every retained
  // day's HRR, so only a matching retained set may start at the local change.
  const fromCivilDate = hrMaxMatchesRetainedRows ? requestedFromCivilDate : earliest;
  const targetDates = civilDatesInclusive(fromCivilDate, nowCivilDate);

  for (const civilDate of targetDates) {
    const zone = await input.store.healthMetrics.lookupTimeZoneHistory({ userId: input.userId, at: `${civilDate}T12:00:00.000Z` });
    const bounds = zone ? strainLocalDayBoundsForTimeZone({ civilDate, timeZone: zone.ianaTimeZone }) : undefined;
    const day = bounds ? { start: bounds.fromUtc, end: bounds.toUtcExclusive } : null;
    const rhr = rhrBaseline(input.records.dailyRhr, input.userId, civilDate);
    const evidence = day
      ? await input.store.healthMetrics.listHeartRateMinuteEvidence({ userId: input.userId, fromUtc: day.start, toUtcExclusive: day.end })
      : [];
    const activity = day
      ? await input.store.healthMetrics.listActivityLevelIntervalsInRange({ userId: input.userId, fromUtc: day.start, toUtcExclusive: day.end })
      : [];
    const exercise = day
      ? await input.store.healthMetrics.listExerciseIntervalsInRange({ userId: input.userId, fromUtc: day.start, toUtcExclusive: day.end })
      : [];
    const segments = evidenceSegments(evidence);
    const activeIntervals = activity
      .filter((interval) => ACTIVE_LEVELS.has(interval.activityLevelType))
      .map((interval) => ({ start: interval.startTime, end: interval.endTime }));
    const exerciseIntervals = toTimeIntervals(exercise);
    const sleepIntervals = toTimeIntervals(sleepSessions);
    const qualified = deriveQualifiedHeartRate({ segments, activityIntervals: activeIntervals, exerciseIntervals, sleepIntervals });
    const primary = selectPrimarySleepSession(sleepSessions, civilDate);
    const nextPrimary = selectPrimarySleepSession(sleepSessions, addCivilDays(civilDate, 1));
    const quality = day
      ? isQualifiedDay({
        ianaTimeZone: zone?.ianaTimeZone ?? null,
        localDayStart: day.start,
        localDayEnd: day.end,
        previousMainSleepEnd: primary?.endTime ?? null,
        nextMainSleepStart: nextPrimary?.startTime ?? null,
        observedIntervals: segments,
      })
      : { status: 'timezone_ambiguous' as const, reason: 'invalid_iana_time_zone' as const, hrCoverageSeconds: 0, awakeCoverageRatio: null };
    const referenceSex = profile?.referenceSex;
    const enoughInputs = referenceSex !== undefined && rhr.value !== null && hrMax !== undefined;
    const isCurrentDay = civilDate === nowCivilDate;
    const canScoreDailyLoad = Boolean(enoughInputs) && (isCurrentDay || quality.status === 'qualified');
    const calculated = canScoreDailyLoad
      ? computeDailyTrimp({ sex: referenceSex!, rhrBaseBpm: rhr.value!, hrMaxEstBpm: hrMax!.bpm, qualified })
      : null;
    const rawElevated = enoughInputs && hrMax!.bpm > rhr.value!
      ? elevatedSeconds({ segments, rhrBaseBpm: rhr.value!, hrMaxEstBpm: hrMax!.bpm })
      : 0;
    const qualifiedElevated = enoughInputs && hrMax!.bpm > rhr.value!
      ? elevatedSeconds({ segments: qualified.segments, rhrBaseBpm: rhr.value!, hrMaxEstBpm: hrMax!.bpm })
      : 0;
    const status = !day ? 'timezone_ambiguous' : calculated?.status ?? 'insufficient_context';
    const dailyLoad = calculated?.dailyLoad === null || calculated === null ? null : round(calculated.dailyLoad);
    const calculationContext = {
      metric_version: CARDIO_LOAD_TRIMP_VERSION,
      civil_date: civilDate,
      iana_time_zone: zone?.ianaTimeZone ?? null,
      rhr_sample_count: rhr.sampleCount,
      qualification_status: quality.status,
      qualification_reason: quality.reason,
      hrmax_filter_rule_version: HR_MAX_FILTER_RULE_VERSION,
    };
    await input.store.healthMetrics.upsertDailyCardioLoad(parseDailyCardioLoad({
      userId: input.userId,
      civilDate,
      metricVersion: CARDIO_LOAD_TRIMP_VERSION,
      status,
      dailyLoad,
      qualifiedSeconds: qualified.qualifiedSeconds,
      unverifiedElevatedHrSeconds: Math.max(0, rawElevated - qualifiedElevated),
      rawHrCoverageSeconds: quality.hrCoverageSeconds,
      awakeCoverageRatio: quality.awakeCoverageRatio,
      motionSource: day ? motionSource({ day, activity, exercise }) : 'none',
      qualityState: quality.status === 'qualified' ? 'qualified' : quality.status === 'timezone_ambiguous' ? 'timezone_ambiguous' : 'incomplete',
      rhrBaseBpm: rhr.value,
      hrMaxEstBpm: hrMax?.bpm ?? null,
      hrMaxProvenance: hrMax ? {
        filterRuleVersion: HR_MAX_FILTER_RULE_VERSION,
        sourceFamily: SOURCE_FAMILY,
        minuteStartUtc: hrMax.minuteStartUtc,
        bpm: hrMax.bpm,
        coverageSeconds: hrMax.coverageSeconds,
        sampleCount: hrMax.sampleCount,
      } : null,
      inputFingerprint: fingerprint({ calculationContext, profileSex: profile?.referenceSex ?? null, rhr: rhr.value, hrMax, evidence, activity, exercise, qualified }),
      calculationContext,
    }));
  }

  for (const civilDate of targetDates) {
    const daily = await input.store.healthMetrics.getDailyCardioLoad({ userId: input.userId, civilDate });
    if (!daily) continue;
    const historicDaily = await input.store.healthMetrics.listDailyCardioLoads({
      userId: input.userId,
      fromCivilDate: earliest,
      toCivilDate: addCivilDays(civilDate, -1),
    });
    const history = await Promise.all(historicDaily.map(async (row) => {
      const recovery = await input.store.healthMetrics.getMetricResult({
        userId: input.userId,
        civilDate: row.civilDate,
        metricName: 'recovery',
        metricVersion: WHOOP_STYLE_METRIC_VERSION,
      });
      return {
        civilDate: row.civilDate,
        dailyLoad: row.dailyLoad,
        qualifiedDay: row.qualityState === 'qualified',
        recoveryScore: recovery?.score ?? null,
        recoveryQuality: recovery?.quality ?? 'unavailable',
      };
    }));
    const recovery = await input.store.healthMetrics.getMetricResult({
      userId: input.userId,
      civilDate,
      metricName: 'recovery',
      metricVersion: WHOOP_STYLE_METRIC_VERSION,
    });
    const recoveryQuality = recovery?.quality ?? 'unavailable';
    const usable = computeUsableLoad({
      targetCivilDate: civilDate,
      targetRecovery: recovery?.score === null || recovery?.score === undefined
        ? null
        : { score: recovery.score, quality: recoveryQuality },
      history,
    });
    const usableLoad = usable.usableLoad === null ? null : round(usable.usableLoad);
    const actualLoad = daily.dailyLoad;
    const historicalSampleCount = history
      .filter((row) => row.qualifiedDay && row.dailyLoad !== null && row.recoveryScore !== null && ['medium', 'high'].includes(row.recoveryQuality))
      .sort((left, right) => right.civilDate.localeCompare(left.civilDate))
      .slice(0, 28)
      .length;
    const recoveryInputFingerprint = recovery
      ? fingerprint({ metricVersion: recovery.metricVersion, score: recovery.score, quality: recovery.quality, reason: recovery.reason, evidence: recovery.evidence, coverage: recovery.coverage })
      : null;
    await input.store.healthMetrics.upsertDailyLoadCapacity(parseDailyLoadCapacity({
      userId: input.userId,
      civilDate,
      metricVersion: CARDIO_LOAD_TRIMP_VERSION,
      status: usable.status,
      actualLoad,
      usableLoad,
      utilization: actualLoad !== null && usableLoad !== null && usableLoad > 0 ? round((actualLoad / usableLoad) * 100) : null,
      historySampleCount: historicalSampleCount,
      usedGlobalFallback: usable.status === 'calibrating' && usableLoad !== null,
      recoveryTier: usable.recoveryTier,
      recoveryMetricVersion: recovery ? WHOOP_STYLE_METRIC_VERSION : null,
      recoveryCivilDate: recovery ? civilDate : null,
      recoveryQuality: recovery ? recoveryQuality : null,
      recoveryInputFingerprint,
      inputFingerprint: fingerprint({ daily: daily.inputFingerprint, recovery: recoveryInputFingerprint, history, usable }),
    }));
  }
  if (timeZone) {
    await recomputeTrimpWeeklyBaselines({
      store: input.store,
      userId: input.userId,
      timeZone: timeZone.ianaTimeZone,
      now: input.now,
      fromCivilDate,
    });
  }
  return { civilDates: targetDates, hrMaxBpm: hrMax?.bpm ?? null };
}
