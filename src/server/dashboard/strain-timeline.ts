import type { SleepSession } from '../../domain/health-records';
import { strainMinuteContribution, strainScoreFromDose } from '../../domain/whoop-style-metrics';
import type { HealthMetricsStore } from '../health/cardio-store';
import {
  strainCalculationContext,
  strainInputFingerprint,
  strainTimeZoneAt,
  strainTimeZoneHistoryFingerprint,
  strainTimeZoneOffsetMinutes,
  stableStrainLocalDayBounds,
  type StrainCalculationContext,
} from '../health/strain-provenance';

const BUCKET_MS = 15 * 60_000;
const ELIGIBLE_COVERAGE_SECONDS = 30;
const STALE_SYNC_MS = 36 * 60 * 60 * 1_000;

export type StrainTimelineBucket = {
  start: string;
  end: string;
  label: string;
  observedHeartRateMinutes: number;
  knownContextMinutes: number;
  attributedMinutes: number;
  intensity: 0 | 1 | 2 | 3 | null;
  /** Sanitized, verified Strain score as of the end of this observed bucket. */
  cumulativeScore: number | null;
};

export type StrainTimeline = {
  observedThrough: string;
  /** Server-formatted against the verified, saved IANA time zone. */
  observedThroughLabel: string;
  buckets: StrainTimelineBucket[];
};

function addCivilDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameJson(value, right[index]));
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && sameJson(leftRecord[key], rightRecord[key]));
  }
  return false;
}

function isCalculationContext(value: unknown): value is StrainCalculationContext {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  const requiredKeys = [
    'as_of_utc', 'civil_date', 'is_current_day', 'local_day_length_minutes',
    'metric_version', 'time_zone_history_fingerprint', 'time_zone_unambiguous',
  ];
  if (Object.keys(context).length !== requiredKeys.length || !requiredKeys.every((key) => key in context)) return false;
  return typeof context.as_of_utc === 'string'
    && Number.isFinite(Date.parse(context.as_of_utc))
    && typeof context.civil_date === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(context.civil_date)
    && typeof context.is_current_day === 'boolean'
    && typeof context.local_day_length_minutes === 'number'
    && Number.isInteger(context.local_day_length_minutes)
    && context.local_day_length_minutes >= 1_380
    && context.local_day_length_minutes <= 1_500
    && context.metric_version === 'whoop-style-v2'
    && typeof context.time_zone_history_fingerprint === 'string'
    && /^sha256:[a-f0-9]{64}$/.test(context.time_zone_history_fingerprint)
    && typeof context.time_zone_unambiguous === 'boolean';
}

function localLabel(instant: Date, timeZone: string): string {
  const label = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'shortOffset',
  }).format(instant);
  return label.replace(/^GMT/, 'UTC').replace(' GMT', ' UTC');
}

function contributionDose(contribution: ReturnType<typeof strainMinuteContribution>): number {
  if (!contribution.attributed || !contribution.zone) return 0;
  if (contribution.zone === 'light') return 0.5;
  if (contribution.zone === 'moderate') return 1;
  if (contribution.zone === 'vigorous') return 2;
  return 3;
}

function timezoneUnambiguous(minutes: Array<{ minuteStartUtc: string; utcOffsetMinutes: number }>, history: Parameters<typeof strainTimeZoneAt>[0]): boolean {
  if (history.length === 0) return false;
  return minutes.every((minute) => {
    const timeZone = strainTimeZoneAt(history, minute.minuteStartUtc);
    const offset = timeZone ? strainTimeZoneOffsetMinutes(timeZone, new Date(minute.minuteStartUtc)) : undefined;
    return offset !== undefined && offset === minute.utcOffsetMinutes;
  });
}

export async function buildVerifiedStrainTimeline(input: {
  store: HealthMetricsStore;
  userId: string;
  civilDate: string;
  now: string;
  sleepSessions?: readonly SleepSession[];
}): Promise<StrainTimeline | undefined> {
  const [dailyCardio, strain, zones, history, minutes] = await Promise.all([
    input.store.getDailyCardio({ userId: input.userId, civilDate: input.civilDate }),
    input.store.getMetricResult({ userId: input.userId, civilDate: input.civilDate, metricName: 'strain' }),
    input.store.getHeartRateZones({ userId: input.userId, civilDate: input.civilDate }),
    input.store.listTimeZoneHistory(input.userId),
    input.store.listMinutesByCivilDate({ userId: input.userId, civilDate: input.civilDate }),
  ]);
  const dailyProvenance = dailyCardio?.provenance;
  const metricProvenance = strain?.provenance;
  if (
    !dailyCardio || !strain || dailyCardio.strain === null || strain.score === null
    || !dailyProvenance || !metricProvenance
    || dailyProvenance.provenanceVersion !== 1 || metricProvenance.provenanceVersion !== 1
    || dailyProvenance.inputFingerprint !== metricProvenance.inputFingerprint
    || !sameJson(dailyProvenance.calculationContext, metricProvenance.calculationContext)
    || !isCalculationContext(dailyProvenance.calculationContext)
    || !strain.source.sleep
    || !input.sleepSessions?.some((session) => session.userId === input.userId && session.source === 'google_health')
  ) {
    return undefined;
  }

  const context = dailyProvenance.calculationContext;
  const nowMs = Date.parse(input.now);
  const asOfMs = Date.parse(context.as_of_utc);
  if (asOfMs > nowMs || nowMs - asOfMs > STALE_SYNC_MS || context.civil_date !== input.civilDate) return undefined;
  if (context.time_zone_history_fingerprint !== strainTimeZoneHistoryFingerprint(history)) return undefined;
  const bounds = stableStrainLocalDayBounds({
    civilDate: input.civilDate,
    minutes,
    timeZoneHistory: history,
  });
  if (!bounds || bounds.localDayLengthMinutes !== context.local_day_length_minutes) return undefined;

  const sourceRange = {
    fromUtc: `${addCivilDays(input.civilDate, -1)}T00:00:00.000Z`,
    toUtcExclusive: `${addCivilDays(input.civilDate, 2)}T00:00:00.000Z`,
  };
  const [activityLevelIntervals, exerciseIntervals] = await Promise.all([
    input.store.listActivityLevelIntervalsInRange({ userId: input.userId, ...sourceRange }),
    input.store.listExerciseIntervalsInRange({ userId: input.userId, ...sourceRange }),
  ]);
  const sleepSessions = [...(input.sleepSessions ?? [])].filter((session) => (
    session.userId === input.userId && session.source === 'google_health'
  ));
  const unambiguous = timezoneUnambiguous(minutes, history);
  if (unambiguous !== context.time_zone_unambiguous) return undefined;
  const replayedContext = strainCalculationContext({
    civilDate: input.civilDate,
    isCurrentDay: context.is_current_day,
    now: context.as_of_utc,
    timeZoneHistory: history,
    timeZoneUnambiguous: unambiguous,
    localDayLengthMinutes: bounds.localDayLengthMinutes,
  });
  if (!sameJson(context, replayedContext)) return undefined;
  const fingerprint = strainInputFingerprint({
    userId: input.userId,
    context: replayedContext,
    minutes,
    zones,
    sleepSessions,
    exerciseIntervals,
    activityLevelIntervals,
  });
  if (fingerprint !== dailyProvenance.inputFingerprint) return undefined;

  const timeZone = bounds.timeZone;
  const activeIntervals = activityLevelIntervals.filter((interval) => (
    interval.activityLevelType === 'LIGHTLY_ACTIVE'
    || interval.activityLevelType === 'MODERATELY_ACTIVE'
    || interval.activityLevelType === 'VERY_ACTIVE'
  ));
  const eligibleMinutes = minutes.filter((minute) => (
    Date.parse(minute.minuteStartUtc) <= asOfMs
    && Date.parse(minute.minuteStartUtc) >= Date.parse(bounds.fromUtc)
    && Date.parse(minute.minuteStartUtc) < Date.parse(bounds.toUtcExclusive)
  ));
  const buckets: StrainTimelineBucket[] = [];
  let cumulativeDose = 0;
  for (let startMs = Date.parse(bounds.fromUtc); startMs < Date.parse(bounds.toUtcExclusive); startMs += BUCKET_MS) {
    const endMs = Math.min(startMs + BUCKET_MS, Date.parse(bounds.toUtcExclusive));
    const members = eligibleMinutes.filter((minute) => {
      const minuteMs = Date.parse(minute.minuteStartUtc);
      return minuteMs >= startMs && minuteMs < endMs;
    });
    const contributions = members.map((minute) => strainMinuteContribution({
      minute,
      zones,
      sleepSessions,
      exerciseIntervals,
      activityLevelIntervals: activeIntervals,
    }));
    const observedHeartRateMinutes = members.filter((minute) => minute.coverageSeconds >= ELIGIBLE_COVERAGE_SECONDS).length;
    const knownContextMinutes = members.filter((minute) => (
      minute.coverageSeconds >= ELIGIBLE_COVERAGE_SECONDS && minute.activityLevel !== 'unknown'
    )).length;
    const attributedMinutes = contributions.filter((contribution) => contribution.attributed).length;
    const numericIntensities = contributions.flatMap((contribution) => contribution.intensity === null ? [] : [contribution.intensity]);
    const hasObservedHeartRate = observedHeartRateMinutes > 0;
    if (hasObservedHeartRate) {
      cumulativeDose += contributions.reduce((total, contribution) => total + contributionDose(contribution), 0);
    }
    buckets.push({
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      label: localLabel(new Date(startMs), timeZone),
      observedHeartRateMinutes,
      knownContextMinutes,
      attributedMinutes,
      intensity: numericIntensities.length === 0 ? null : Math.max(...numericIntensities) as 0 | 1 | 2 | 3,
      cumulativeScore: hasObservedHeartRate ? strainScoreFromDose(cumulativeDose) : null,
    });
  }

  const recomputedScore = strainScoreFromDose(cumulativeDose);
  if (dailyCardio.strain !== recomputedScore || strain.score !== recomputedScore) return undefined;

  return {
    observedThrough: context.as_of_utc,
    observedThroughLabel: localLabel(new Date(context.as_of_utc), timeZone),
    buckets,
  };
}
