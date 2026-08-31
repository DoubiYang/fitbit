import {
  classifyHeartRateZone,
  sleepGoalEffectiveCivilDate,
  type ActivityLevelInterval,
  type ActivityLevelType,
  type DailyHeartRateZones,
  type ExerciseInterval,
  type HeartRateMinuteAggregate,
  type HeartRateSample,
  type MinuteActivityLevel,
  type SleepGoal,
} from './cardio-records';
import { type DailyHrv, type DailyRhr, type SleepSession } from './health-records';
import { selectPrimarySleepSession } from './metrics';
import {
  WHOOP_STYLE_METRIC_VERSION,
  type HeartRateZoneId,
  type MetricCoverageState,
  type MetricEvidence,
  type MetricSourceState,
  type RecoveryQuality,
  type SleepPerformanceResult,
  type SleepUnavailableReason,
  type StrainResult,
  type StrainStatus,
  type StrainUnavailableReason,
  type WhoopStyleRecoveryResult,
  type ZoneMinutes,
} from './metric-types';

const MAX_HOLD_MS = 75_000;
const MINUTE_MS = 60_000;
const ELIGIBLE_COVERAGE_SECONDS = 30;
const PAST_KNOWN_CONTEXT_MINUTES = 480;
const PAST_LAST_SAMPLE_MAX_GAP_MINUTES = 180;
const CURRENT_KNOWN_CONTEXT_MINUTES = 120;
const CURRENT_LAST_SAMPLE_MAX_GAP_MINUTES = 90;
const WINDOW_MIN_KNOWN_MINUTES = 90;
const WINDOW_MAX_GAP_MINUTES = 240;
const EXERCISE_ATTRIBUTION_SECONDS = 30;
const STALE_SYNC_MS = 36 * 60 * 60 * 1_000;
const HRV_FLOOR_MS = 2;
const RHR_FLOOR_BPM = 3;
const HRV_MIN_MS = 5;
const HRV_MAX_MS = 250;
const RHR_MIN_BPM = 25;
const RHR_MAX_BPM = 130;
const MIN_BASELINE_DAYS = 7;
const STABLE_BASELINE_DAYS = 28;

const ACTIVITY_PRECEDENCE: Record<ActivityLevelType, number> = {
  VERY_ACTIVE: 4,
  MODERATELY_ACTIVE: 3,
  LIGHTLY_ACTIVE: 2,
  SEDENTARY: 1,
};

const ACTIVE_LEVELS = new Set<MinuteActivityLevel>(['LIGHTLY_ACTIVE', 'MODERATELY_ACTIVE', 'VERY_ACTIVE']);

export type { HeartRateSample };

export type MinuteCoverageInterval = {
  start: string;
  end: string;
  bpm: number;
};

export type AggregatedHeartRateMinute = {
  userId: string;
  sourceFamily: 'google-wearables';
  minuteStartUtc: string;
  civilDate: string;
  utcOffsetMinutes: number;
  ianaTimeZone: string | null;
  localMinuteOfDay: number;
  avgBpm: number;
  minBpm: number;
  maxBpm: number;
  sampleCount: number;
  coverageSeconds: number;
  coverageIntervals: MinuteCoverageInterval[];
  eligible: boolean;
};

export type ComputeStrainInput = {
  userId: string;
  date: string;
  minutes: HeartRateMinuteAggregate[];
  zones: DailyHeartRateZones | undefined;
  sleepSessions: SleepSession[];
  exerciseIntervals: ExerciseInterval[];
  timezoneUnambiguous: boolean;
  isCurrentDay: boolean;
  now?: string;
  localDayLengthMinutes?: number;
};

export type ComputeSleepPerformanceInput = {
  targetDate: string;
  sessions: SleepSession[];
  goals: SleepGoal[];
  previousDayStrain?: { status: StrainStatus; score: number | null };
};

export type ComputeRecoveryInput = {
  targetDate: string;
  hrv: DailyHrv | undefined;
  rhr: DailyRhr | undefined;
  historicalHrv: DailyHrv[];
  historicalRhr: DailyRhr[];
  sleep: SleepPerformanceResult | undefined;
  now: string;
  lastSuccessfulSyncAt: string | undefined;
};

type MutableMinute = {
  userId: string;
  sourceFamily: 'google-wearables';
  minuteStartUtc: string;
  minuteStartMs: number;
  utcOffsetMinutes: number;
  intervals: Array<{ startMs: number; endMs: number; bpm: number }>;
  samples: Set<string>;
  minBpm: number;
  maxBpm: number;
};

function emptyZoneMinutes(): ZoneMinutes {
  return { light: 0, moderate: 0, vigorous: 0, peak: 0 };
}

function emptySource(overrides: Partial<MetricSourceState> = {}): MetricSourceState {
  return {
    heartRateZones: false,
    activityLevel: false,
    exercise: false,
    sleep: false,
    hrv: false,
    rhr: false,
    sleepGoal: false,
    timeZone: 'unambiguous',
    ...overrides,
  };
}

function emptyCoverage(overrides: Partial<MetricCoverageState> = {}): MetricCoverageState {
  return {
    knownContextMinutes: 0,
    rawHeartRateMinutes: 0,
    attributedMinutes: 0,
    lastKnownContextAt: null,
    ...overrides,
  };
}

function addCivilDays(civilDate: string, days: number): string {
  const next = new Date(`${civilDate}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function civilDateFromOffset(utcMs: number, utcOffsetMinutes: number): { civilDate: string; localMinuteOfDay: number } {
  const local = new Date(utcMs + utcOffsetMinutes * 60_000);
  return {
    civilDate: local.toISOString().slice(0, 10),
    localMinuteOfDay: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function clipToRange(
  startMs: number,
  endMs: number,
  rangeStart: number,
  rangeEnd: number,
): { startMs: number; endMs: number } | undefined {
  const clippedStart = Math.max(startMs, rangeStart);
  const clippedEnd = Math.min(endMs, rangeEnd);
  return clippedEnd > clippedStart ? { startMs: clippedStart, endMs: clippedEnd } : undefined;
}

function unionIntervals(intervals: Array<{ startMs: number; endMs: number }>): Array<{ startMs: number; endMs: number }> {
  const sorted = [...intervals].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const merged: Array<{ startMs: number; endMs: number }> = [];

  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && interval.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, interval.endMs);
      continue;
    }
    merged.push({ ...interval });
  }

  return merged;
}

function coverageSecondsFrom(intervals: Array<{ startMs: number; endMs: number }>): number {
  return unionIntervals(intervals).reduce((total, interval) => total + (interval.endMs - interval.startMs) / 1_000, 0);
}

function coverageStats(intervals: Array<{ startMs: number; endMs: number; bpm: number }>): { coverageSeconds: number; avgBpm: number } {
  const events: Array<{ ms: number; kind: 'start' | 'end'; index: number }> = [];
  intervals.forEach((interval, index) => {
    if (interval.endMs <= interval.startMs) {
      return;
    }
    events.push({ ms: interval.startMs, kind: 'start', index });
    events.push({ ms: interval.endMs, kind: 'end', index });
  });
  events.sort((left, right) => {
    if (left.ms !== right.ms) {
      return left.ms - right.ms;
    }
    if (left.kind !== right.kind) {
      return left.kind === 'end' ? -1 : 1;
    }
    return left.index - right.index;
  });

  const active = new Set<number>();
  let lastMs: number | undefined;
  let weighted = 0;
  let coverageMs = 0;

  for (const event of events) {
    if (lastMs !== undefined && event.ms > lastMs && active.size > 0) {
      let firstIndex = Number.POSITIVE_INFINITY;
      for (const index of active) {
        if (index < firstIndex) {
          firstIndex = index;
        }
      }
      const durationMs = event.ms - lastMs;
      weighted += intervals[firstIndex]!.bpm * (durationMs / 1_000);
      coverageMs += durationMs;
    }

    if (event.kind === 'start') {
      active.add(event.index);
    } else {
      active.delete(event.index);
    }
    lastMs = event.ms;
  }

  const coverageSeconds = coverageMs / 1_000;
  return {
    coverageSeconds,
    avgBpm: coverageSeconds === 0 ? 0 : weighted / coverageSeconds,
  };
}

function finalizeMinute(minute: MutableMinute): AggregatedHeartRateMinute {
  const { coverageSeconds, avgBpm } = coverageStats(minute.intervals);
  const local = civilDateFromOffset(minute.minuteStartMs, minute.utcOffsetMinutes);
  return {
    userId: minute.userId,
    sourceFamily: minute.sourceFamily,
    minuteStartUtc: minute.minuteStartUtc,
    civilDate: local.civilDate,
    utcOffsetMinutes: minute.utcOffsetMinutes,
    ianaTimeZone: null,
    localMinuteOfDay: local.localMinuteOfDay,
    avgBpm,
    minBpm: minute.minBpm,
    maxBpm: minute.maxBpm,
    sampleCount: minute.samples.size,
    coverageSeconds,
    coverageIntervals: minute.intervals.map((interval) => ({
      start: toIso(interval.startMs),
      end: toIso(interval.endMs),
      bpm: interval.bpm,
    })),
    eligible: coverageSeconds >= ELIGIBLE_COVERAGE_SECONDS,
  };
}

function addHold(
  minutes: Map<string, MutableMinute>,
  input: { userId: string; sourceFamily: 'google-wearables' },
  sample: HeartRateSample,
  startMs: number,
  endMs: number,
) {
  if (endMs <= startMs) {
    return;
  }

  let cursor = startMs;
  while (cursor < endMs) {
    const minuteStartMs = Math.floor(cursor / MINUTE_MS) * MINUTE_MS;
    const pieceEnd = Math.min(endMs, minuteStartMs + MINUTE_MS);
    const key = toIso(minuteStartMs);
    const existing = minutes.get(key);
    if (existing) {
      existing.intervals.push({ startMs: cursor, endMs: pieceEnd, bpm: sample.beatsPerMinute });
      existing.samples.add(sample.physicalTime);
      existing.minBpm = Math.min(existing.minBpm, sample.beatsPerMinute);
      existing.maxBpm = Math.max(existing.maxBpm, sample.beatsPerMinute);
    } else {
      minutes.set(key, {
        userId: input.userId,
        sourceFamily: input.sourceFamily,
        minuteStartUtc: key,
        minuteStartMs,
        utcOffsetMinutes: sample.utcOffsetMinutes,
        intervals: [{ startMs: cursor, endMs: pieceEnd, bpm: sample.beatsPerMinute }],
        samples: new Set([sample.physicalTime]),
        minBpm: sample.beatsPerMinute,
        maxBpm: sample.beatsPerMinute,
      });
    }
    cursor = pieceEnd;
  }
}

export function aggregateHeartRateMinutes(input: {
  userId: string;
  sourceFamily: 'google-wearables';
  samples: HeartRateSample[];
  lookaheadSample?: HeartRateSample;
  closeAt?: string;
}): AggregatedHeartRateMinute[] {
  const sorted = [...input.samples].sort((left, right) => Date.parse(left.physicalTime) - Date.parse(right.physicalTime));
  const minutes = new Map<string, MutableMinute>();

  for (let index = 0; index < sorted.length; index += 1) {
    const sample = sorted[index];
    const startMs = Date.parse(sample.physicalTime);
    const nextMs =
      index + 1 < sorted.length
        ? Date.parse(sorted[index + 1].physicalTime)
        : input.lookaheadSample
          ? Date.parse(input.lookaheadSample.physicalTime)
          : input.closeAt
            ? Date.parse(input.closeAt)
            : startMs + MAX_HOLD_MS;
    const endMs = Math.min(startMs + MAX_HOLD_MS, Math.max(startMs, nextMs));
    addHold(minutes, input, sample, startMs, endMs);
  }

  return [...minutes.values()].map(finalizeMinute).sort((left, right) => left.minuteStartUtc.localeCompare(right.minuteStartUtc));
}

export function mergeHeartRateMinuteCoverages(pages: AggregatedHeartRateMinute[][]): AggregatedHeartRateMinute[] {
  const merged = new Map<string, MutableMinute>();

  for (const page of pages) {
    for (const minute of page) {
      const existing = merged.get(minute.minuteStartUtc);
      const intervals = minute.coverageIntervals.map((interval) => ({
        startMs: Date.parse(interval.start),
        endMs: Date.parse(interval.end),
        bpm: interval.bpm,
      }));
      if (!existing) {
        merged.set(minute.minuteStartUtc, {
          userId: minute.userId,
          sourceFamily: minute.sourceFamily,
          minuteStartUtc: minute.minuteStartUtc,
          minuteStartMs: Date.parse(minute.minuteStartUtc),
          utcOffsetMinutes: minute.utcOffsetMinutes,
          intervals,
          samples: new Set(minute.coverageIntervals.map((interval) => interval.start)),
          minBpm: minute.minBpm,
          maxBpm: minute.maxBpm,
        });
        continue;
      }

      existing.intervals.push(...intervals);
      existing.minBpm = Math.min(existing.minBpm, minute.minBpm);
      existing.maxBpm = Math.max(existing.maxBpm, minute.maxBpm);
      for (const interval of minute.coverageIntervals) {
        existing.samples.add(interval.start);
      }
    }
  }

  return [...merged.values()].map(finalizeMinute).sort((left, right) => left.minuteStartUtc.localeCompare(right.minuteStartUtc));
}

export function assignActivityLevel(minuteStartUtc: string, intervals: ActivityLevelInterval[]): MinuteActivityLevel {
  const startMs = Date.parse(minuteStartUtc);
  const endMs = startMs + MINUTE_MS;
  const byType = new Map<ActivityLevelType, Array<{ startMs: number; endMs: number }>>();

  for (const interval of intervals) {
    const clipped = clipToRange(Date.parse(interval.startTime), Date.parse(interval.endTime), startMs, endMs);
    if (!clipped) {
      continue;
    }
    const current = byType.get(interval.activityLevelType) ?? [];
    current.push(clipped);
    byType.set(interval.activityLevelType, current);
  }

  let best: ActivityLevelType | undefined;
  let bestMs = -1;
  for (const [type, parts] of byType) {
    const milliseconds = coverageSecondsFrom(parts) * 1_000;
    if (milliseconds > bestMs || (milliseconds === bestMs && best !== undefined && ACTIVITY_PRECEDENCE[type] > ACTIVITY_PRECEDENCE[best])) {
      best = type;
      bestMs = milliseconds;
    }
  }

  return best ?? 'unknown';
}

export function isStrainAttributedMinute(input: {
  activityLevel: MinuteActivityLevel;
  sleepOverlapSeconds: number;
  exerciseOverlapSeconds: number;
}): boolean {
  if (input.exerciseOverlapSeconds >= EXERCISE_ATTRIBUTION_SECONDS) {
    return true;
  }
  if (input.sleepOverlapSeconds > 0) {
    return false;
  }
  return ACTIVE_LEVELS.has(input.activityLevel);
}

function intervalOverlapSeconds(minuteStartUtc: string, intervals: Array<{ startTime: string; endTime: string }>): number {
  const startMs = Date.parse(minuteStartUtc);
  const endMs = startMs + MINUTE_MS;
  const clipped: Array<{ startMs: number; endMs: number }> = [];
  for (const interval of intervals) {
    const overlap = clipToRange(Date.parse(interval.startTime), Date.parse(interval.endTime), startMs, endMs);
    if (overlap) {
      clipped.push(overlap);
    }
  }
  return coverageSecondsFrom(clipped);
}

function isEligibleMinute(minute: HeartRateMinuteAggregate): boolean {
  return minute.coverageSeconds >= ELIGIBLE_COVERAGE_SECONDS;
}

function incrementZone(zoneMinutes: ZoneMinutes, zone: HeartRateZoneId): void {
  zoneMinutes[zone] += 1;
}

function strainFromDose(dose: number): number {
  return Math.round(Math.min(21, 21 * (1 - Math.exp(-dose / 140))) * 10) / 10;
}

function windowBounds(localDayLengthMinutes: number): Array<{ start: number; end: number }> {
  return [
    { start: 6 * 60, end: 12 * 60 },
    { start: 12 * 60, end: 18 * 60 },
    { start: 18 * 60, end: localDayLengthMinutes },
  ];
}

function maxKnownContextGap(covered: Set<number>, start: number, end: number): number {
  let longest = 0;
  let current = 0;
  for (let minute = start; minute < end; minute += 1) {
    if (covered.has(minute)) {
      current = 0;
      continue;
    }
    current += 1;
    if (current > longest) {
      longest = current;
    }
  }
  return longest;
}

function isFresh(lastKnownContextAt: string | null, now: string | undefined, maxAgeMinutes: number): boolean {
  if (!lastKnownContextAt || !now) {
    return false;
  }
  return Date.parse(now) - Date.parse(lastKnownContextAt) <= maxAgeMinutes * 60_000;
}

export function computeStrain(input: ComputeStrainInput): StrainResult {
  const localDayLengthMinutes = input.localDayLengthMinutes ?? 1_440;
  const dayMinutes = input.minutes.filter((minute) => minute.civilDate === input.date);
  const eligible = dayMinutes.filter(isEligibleMinute);
  const zoneMinutes = emptyZoneMinutes();
  let attributedMinutes = 0;
  let usedExercise = false;

  for (const minute of eligible) {
    const sleepOverlapSeconds = intervalOverlapSeconds(minute.minuteStartUtc, input.sleepSessions);
    const exerciseOverlapSeconds = intervalOverlapSeconds(minute.minuteStartUtc, input.exerciseIntervals);
    if (exerciseOverlapSeconds >= EXERCISE_ATTRIBUTION_SECONDS) {
      usedExercise = true;
    }
    if (
      !isStrainAttributedMinute({
        activityLevel: minute.activityLevel,
        sleepOverlapSeconds,
        exerciseOverlapSeconds,
      })
    ) {
      continue;
    }
    attributedMinutes += 1;
    if (!input.zones) {
      continue;
    }
    const zone = classifyHeartRateZone(minute.avgBpm, input.zones);
    if (zone) {
      incrementZone(zoneMinutes, zone);
    }
  }

  const known = eligible.filter((minute) => minute.activityLevel !== 'unknown');
  const knownContextMinutes = known.length;
  const lastKnown = known.reduce<HeartRateMinuteAggregate | undefined>((latest, minute) => {
    if (!latest || minute.localMinuteOfDay > latest.localMinuteOfDay) {
      return minute;
    }
    return latest;
  }, undefined);
  const coverage = emptyCoverage({
    knownContextMinutes,
    rawHeartRateMinutes: eligible.length,
    attributedMinutes,
    lastKnownContextAt: lastKnown?.minuteStartUtc ?? null,
  });
  const source = emptySource({
    heartRateZones: Boolean(input.zones),
    activityLevel: knownContextMinutes > 0,
    exercise: usedExercise,
    sleep: input.sleepSessions.length > 0,
    timeZone: input.timezoneUnambiguous ? 'unambiguous' : 'ambiguous',
  });
  const dose = input.zones
    ? 0.5 * zoneMinutes.light + zoneMinutes.moderate + 2 * zoneMinutes.vigorous + 3 * zoneMinutes.peak
    : null;
  const score = dose === null ? null : strainFromDose(dose);
  const evidence: MetricEvidence[] = [
    { label: '剂量', date: input.date, value: dose ?? 0 },
    { label: 'light', date: input.date, value: zoneMinutes.light },
    { label: 'moderate', date: input.date, value: zoneMinutes.moderate },
    { label: 'vigorous', date: input.date, value: zoneMinutes.vigorous },
    { label: 'peak', date: input.date, value: zoneMinutes.peak },
  ];

  const result = (
    status: StrainStatus,
    kind: StrainResult['kind'],
    reason: StrainUnavailableReason | null,
    resultScore: number | null,
  ): StrainResult => ({
    kind,
    score: resultScore,
    status,
    reason,
    dose,
    zoneMinutes,
    coverage,
    source,
    evidence,
    metricVersion: WHOOP_STYLE_METRIC_VERSION,
  });

  if (!input.zones) {
    return result('unavailable', 'no_score', 'heart_rate_zones_missing', null);
  }

  if (!input.timezoneUnambiguous) {
    if (attributedMinutes > 0) {
      return result('timezone_ambiguous', 'score', 'timezone_ambiguous', score);
    }
    return result('timezone_ambiguous', 'no_score', 'timezone_ambiguous', null);
  }

  const coveredMinutes = new Set(known.map((minute) => minute.localMinuteOfDay));
  const windows = windowBounds(localDayLengthMinutes);
  const windowsComplete = windows.every((window) => {
    const knownInWindow = known.filter((minute) => minute.localMinuteOfDay >= window.start && minute.localMinuteOfDay < window.end).length;
    return knownInWindow >= WINDOW_MIN_KNOWN_MINUTES && maxKnownContextGap(coveredMinutes, window.start, window.end) <= WINDOW_MAX_GAP_MINUTES;
  });
  const lastSampleCloseToDayEnd = (lastKnown?.localMinuteOfDay ?? -1) >= localDayLengthMinutes - PAST_LAST_SAMPLE_MAX_GAP_MINUTES;
  const pastComplete =
    !input.isCurrentDay &&
    knownContextMinutes >= PAST_KNOWN_CONTEXT_MINUTES &&
    lastSampleCloseToDayEnd &&
    windowsComplete;

  if (input.isCurrentDay) {
    const currentFresh = isFresh(coverage.lastKnownContextAt, input.now, CURRENT_LAST_SAMPLE_MAX_GAP_MINUTES);
    const provisional = (knownContextMinutes >= CURRENT_KNOWN_CONTEXT_MINUTES && currentFresh) || usedExercise;
    if (provisional) {
      return result('provisional', 'score', null, score ?? 0);
    }
    return result('incomplete', 'no_score', knownContextMinutes === 0 ? 'unknown_context' : 'insufficient_coverage', null);
  }

  if (pastComplete) {
    return result('complete', 'score', null, attributedMinutes === 0 ? 0 : (score ?? 0));
  }

  if (attributedMinutes > 0) {
    return result('provisional', 'score', null, score ?? 0);
  }

  if (knownContextMinutes === 0) {
    return result('incomplete', 'no_score', 'unknown_context', null);
  }

  return result('incomplete', 'no_score', 'insufficient_coverage', null);
}

export function metricsAffectedByStrainRecompute(strainDate: string): {
  strainDate: string;
  sleepPerformanceDate: string;
  recoveryDate: string;
} {
  const nextDate = addCivilDays(strainDate, 1);
  return {
    strainDate,
    sleepPerformanceDate: nextDate,
    recoveryDate: nextDate,
  };
}

function selectSleepGoal(goals: SleepGoal[], targetDate: string): SleepGoal | undefined {
  return [...goals]
    .filter((goal) => goal.effectiveCivilDate <= targetDate)
    .sort((left, right) => right.effectiveCivilDate.localeCompare(left.effectiveCivilDate))[0];
}

function longestNonNapMinutes(sessions: SleepSession[], civilDate: string): number | null {
  const nonNaps = sessions.filter((session) => session.civilEndDate === civilDate && !session.isNap);
  if (nonNaps.length === 0) {
    return null;
  }
  return nonNaps.reduce((longest, session) => Math.max(longest, session.minutesAsleep), 0);
}

export function computeSleepPerformance(input: ComputeSleepPerformanceInput): SleepPerformanceResult {
  const goal = selectSleepGoal(input.goals, input.targetDate);
  const primary = selectPrimarySleepSession(input.sessions, input.targetDate);
  const source = emptySource({
    sleep: Boolean(primary) || input.sessions.some((session) => session.civilEndDate === input.targetDate),
    sleepGoal: Boolean(goal),
  });
  const base: Omit<SleepPerformanceResult, 'kind' | 'score' | 'reason'> = {
    minutesAsleep: primary?.minutesAsleep ?? null,
    goalMinutes: goal?.goalMinutes ?? null,
    needMinutes: null,
    debtMinutes: 0,
    debtCompensationMinutes: 0,
    strainCompensationMinutes: 0,
    sleepHistoryIncomplete: false,
    coverage: emptyCoverage(),
    source,
    evidence: [],
    metricVersion: WHOOP_STYLE_METRIC_VERSION,
  };

  const unavailable = (reason: SleepUnavailableReason, evidence: MetricEvidence[] = []): SleepPerformanceResult => ({
    kind: 'no_score',
    score: null,
    reason,
    ...base,
    evidence,
  });

  if (!goal) {
    return unavailable('sleep_goal_missing', primary ? [{ label: '实际睡眠', date: input.targetDate, value: primary.minutesAsleep }] : []);
  }

  if (!primary) {
    return unavailable('primary_sleep_missing');
  }

  const windowDates = Array.from({ length: 7 }, (_, index) => addCivilDays(input.targetDate, -(7 - index)));
  let debtMinutes = 0;
  let sleepHistoryIncomplete = false;
  const evidence: MetricEvidence[] = [
    { label: '主睡眠', date: input.targetDate, value: primary.id },
    { label: '实际睡眠', date: input.targetDate, value: primary.minutesAsleep },
    { label: '睡眠目标', date: input.targetDate, value: goal.goalMinutes },
  ];

  for (const windowDate of windowDates) {
    const actual = longestNonNapMinutes(input.sessions, windowDate);
    if (actual === null) {
      sleepHistoryIncomplete = true;
      debtMinutes += goal.goalMinutes;
      evidence.push({ label: '睡眠债窗口', date: windowDate, value: 0 });
      continue;
    }
    debtMinutes += Math.max(0, goal.goalMinutes - actual);
    evidence.push({ label: '睡眠债窗口', date: windowDate, value: actual });
  }

  const previousComplete = input.previousDayStrain?.status === 'complete' && input.previousDayStrain.score !== null;
  const strainCompensationMinutes = previousComplete ? Math.min(30, 5 * Math.max(0, input.previousDayStrain!.score! - 10)) : 0;
  const debtCompensationMinutes = Math.min(60, 0.5 * debtMinutes);
  const needMinutes = Math.round(goal.goalMinutes + debtCompensationMinutes + strainCompensationMinutes);
  const score = Math.round(Math.min(100, (100 * primary.minutesAsleep) / needMinutes));

  return {
    kind: 'score',
    score,
    reason: null,
    minutesAsleep: primary.minutesAsleep,
    goalMinutes: goal.goalMinutes,
    needMinutes,
    debtMinutes,
    debtCompensationMinutes,
    strainCompensationMinutes,
    sleepHistoryIncomplete,
    coverage: emptyCoverage(),
    source: { ...source, sleep: true, sleepGoal: true },
    evidence: [
      ...evidence,
      { label: '动态需求', date: input.targetDate, value: needMinutes },
      { label: '睡眠债补偿', date: input.targetDate, value: debtCompensationMinutes },
      { label: 'Strain补偿', date: input.targetDate, value: strainCompensationMinutes },
    ],
    metricVersion: WHOOP_STYLE_METRIC_VERSION,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function baselineValues<T extends { date: string; userId: string }>(
  targetDate: string,
  userId: string,
  records: T[],
  toValue: (record: T) => number,
  isValid: (value: number) => boolean,
): number[] {
  return records
    .filter((record) => record.userId === userId && record.date < targetDate && isValid(toValue(record)))
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, STABLE_BASELINE_DAYS)
    .map(toValue);
}

function robustSubscore(value: number, window: number[], direction: 'higher_is_better' | 'lower_is_better', floor: number) {
  const midpoint = median(window);
  const scale = Math.max(1.4826 * median(window.map((candidate) => Math.abs(candidate - midpoint))), floor);
  const signed = ((value - midpoint) / scale) * (direction === 'higher_is_better' ? 1 : -1);
  return { baseline: midpoint, score: clamp(50 + 15 * signed, 0, 100) };
}

export function computeRecovery(input: ComputeRecoveryInput): WhoopStyleRecoveryResult {
  const evidence: MetricEvidence[] = [];
  const components: WhoopStyleRecoveryResult['components'] = {};
  const weighted: Array<{ score: number; weight: number }> = [];
  const source = emptySource({
    hrv: Boolean(input.hrv),
    rhr: Boolean(input.rhr),
    sleep: input.sleep?.kind === 'score',
    sleepGoal: Boolean(input.sleep?.goalMinutes),
  });
  const sleepHistoryIncomplete = input.sleep?.sleepHistoryIncomplete ?? false;

  const hrvValue = input.hrv && input.hrv.valueMs >= HRV_MIN_MS && input.hrv.valueMs <= HRV_MAX_MS ? input.hrv.valueMs : undefined;
  const rhrValue = input.rhr && input.rhr.valueBpm >= RHR_MIN_BPM && input.rhr.valueBpm <= RHR_MAX_BPM ? input.rhr.valueBpm : undefined;

  if (input.hrv && hrvValue !== undefined) {
    const window = baselineValues(
      input.targetDate,
      input.hrv.userId,
      input.historicalHrv,
      (record) => record.valueMs,
      (value) => value >= HRV_MIN_MS && value <= HRV_MAX_MS,
    );
    if (window.length >= MIN_BASELINE_DAYS) {
      const calculated = robustSubscore(hrvValue, window, 'higher_is_better', HRV_FLOOR_MS);
      components.hrv = { score: calculated.score, weight: 0.4, value: hrvValue, baseline: calculated.baseline, baselineDays: window.length };
      weighted.push({ score: calculated.score, weight: 0.4 });
      evidence.push({ label: 'HRV', date: input.hrv.date, value: hrvValue });
    }
  }

  if (input.rhr && rhrValue !== undefined) {
    const window = baselineValues(
      input.targetDate,
      input.rhr.userId,
      input.historicalRhr,
      (record) => record.valueBpm,
      (value) => value >= RHR_MIN_BPM && value <= RHR_MAX_BPM,
    );
    if (window.length >= MIN_BASELINE_DAYS) {
      const calculated = robustSubscore(rhrValue, window, 'lower_is_better', RHR_FLOOR_BPM);
      components.rhr = { score: calculated.score, weight: 0.3, value: rhrValue, baseline: calculated.baseline, baselineDays: window.length };
      weighted.push({ score: calculated.score, weight: 0.3 });
      evidence.push({ label: '静息心率', date: input.rhr.date, value: rhrValue });
    }
  }

  if (input.sleep?.kind === 'score' && input.sleep.score !== null) {
    components.sleep = { score: input.sleep.score, weight: 0.3, value: input.sleep.score };
    weighted.push({ score: input.sleep.score, weight: 0.3 });
    evidence.push({ label: 'Sleep Performance', date: input.targetDate, value: input.sleep.score });
  }

  const unavailable = (reason: WhoopStyleRecoveryResult['reason']): WhoopStyleRecoveryResult => ({
    kind: 'no_score',
    score: null,
    quality: 'unavailable',
    reason,
    components,
    sleepHistoryIncomplete,
    coverage: emptyCoverage(),
    source,
    evidence,
    metricVersion: WHOOP_STYLE_METRIC_VERSION,
  });

  if (weighted.length < 2) {
    return unavailable('insufficient_recovery_components');
  }

  const totalWeight = weighted.reduce((total, component) => total + component.weight, 0);
  const rawScore = weighted.reduce((total, component) => total + component.score * component.weight, 0) / totalWeight;
  const score = Math.round(rawScore);
  const stale =
    !input.lastSuccessfulSyncAt || Date.parse(input.now) - Date.parse(input.lastSuccessfulSyncAt) > STALE_SYNC_MS;
  const shortBaseline =
    (components.hrv !== undefined && components.hrv.baselineDays < STABLE_BASELINE_DAYS) ||
    (components.rhr !== undefined && components.rhr.baselineDays < STABLE_BASELINE_DAYS);
  const allThree = Boolean(components.hrv && components.rhr && components.sleep);
  const stablePhysio =
    (components.hrv?.baselineDays ?? 0) >= STABLE_BASELINE_DAYS && (components.rhr?.baselineDays ?? 0) >= STABLE_BASELINE_DAYS;

  let quality: RecoveryQuality = 'medium';
  if (stale || shortBaseline || sleepHistoryIncomplete) {
    quality = 'provisional';
  } else if (allThree && stablePhysio && !sleepHistoryIncomplete) {
    quality = 'high';
  }

  return {
    kind: 'score',
    score,
    quality,
    reason: null,
    components,
    sleepHistoryIncomplete,
    coverage: emptyCoverage(),
    source,
    evidence,
    metricVersion: WHOOP_STYLE_METRIC_VERSION,
  };
}

export { sleepGoalEffectiveCivilDate };
