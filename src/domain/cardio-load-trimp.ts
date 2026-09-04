import { CARDIO_LOAD_TRIMP_VERSION } from './metric-types';

export { CARDIO_LOAD_TRIMP_VERSION };

export type TimeInterval = {
  start: string;
  end: string;
};

export type DerivedHeartRateSegment = TimeInterval & {
  bpm: number;
};

export type QualifiedHeartRate = {
  qualifiedSeconds: number;
  avgBpm: number | null;
  segments: DerivedHeartRateSegment[];
};

type MillisecondInterval = {
  startMs: number;
  endMs: number;
};

type MillisecondHeartRateSegment = MillisecondInterval & {
  bpm: number;
};

function toMilliseconds(interval: TimeInterval): MillisecondInterval | undefined {
  const startMs = Date.parse(interval.start);
  const endMs = Date.parse(interval.end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs ? { startMs, endMs } : undefined;
}

function overlaps(interval: MillisecondInterval, atMs: number): boolean {
  return interval.startMs <= atMs && atMs < interval.endMs;
}

function serialize(segment: MillisecondHeartRateSegment): DerivedHeartRateSegment {
  return {
    start: new Date(segment.startMs).toISOString(),
    end: new Date(segment.endMs).toISOString(),
    bpm: segment.bpm,
  };
}

function splitAtMinuteBoundaries(segment: MillisecondHeartRateSegment): MillisecondHeartRateSegment[] {
  const pieces: MillisecondHeartRateSegment[] = [];
  let cursor = segment.startMs;
  while (cursor < segment.endMs) {
    const minuteEnd = (Math.floor(cursor / 60_000) + 1) * 60_000;
    const endMs = Math.min(minuteEnd, segment.endMs);
    pieces.push({ startMs: cursor, endMs, bpm: segment.bpm });
    cursor = endMs;
  }
  return pieces;
}

function normalizeHeartRateSegments(segments: DerivedHeartRateSegment[]): MillisecondHeartRateSegment[] {
  const parsed = segments.flatMap((segment, index) => {
    const interval = toMilliseconds(segment);
    return interval && Number.isFinite(segment.bpm) ? [{ ...interval, bpm: segment.bpm, index }] : [];
  });
  const boundaries = [...new Set(parsed.flatMap((segment) => [segment.startMs, segment.endMs]))].sort((left, right) => left - right);
  const normalized: MillisecondHeartRateSegment[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startMs = boundaries[index]!;
    const endMs = boundaries[index + 1]!;
    const source = parsed
      .filter((segment) => segment.startMs <= startMs && segment.endMs >= endMs)
      .sort((left, right) => left.startMs - right.startMs || left.index - right.index)[0];
    if (!source) {
      continue;
    }
    const previous = normalized.at(-1);
    if (previous && previous.endMs === startMs && previous.bpm === source.bpm) {
      previous.endMs = endMs;
      continue;
    }
    normalized.push({ startMs, endMs, bpm: source.bpm });
  }
  return normalized;
}

export function deriveQualifiedHeartRate(input: {
  segments: DerivedHeartRateSegment[];
  activityIntervals: TimeInterval[];
  exerciseIntervals: TimeInterval[];
  sleepIntervals: TimeInterval[];
}): QualifiedHeartRate {
  const activityIntervals = input.activityIntervals.map(toMilliseconds).filter((item): item is MillisecondInterval => Boolean(item));
  const exerciseIntervals = input.exerciseIntervals.map(toMilliseconds).filter((item): item is MillisecondInterval => Boolean(item));
  const sleepIntervals = input.sleepIntervals.map(toMilliseconds).filter((item): item is MillisecondInterval => Boolean(item));
  const qualifiedSegments: MillisecondHeartRateSegment[] = [];

  for (const rawSegment of normalizeHeartRateSegments(input.segments)) {
    const segment = rawSegment;
    const boundaries = new Set<number>([segment.startMs, segment.endMs]);
    for (const interval of [...activityIntervals, ...exerciseIntervals, ...sleepIntervals]) {
      if (interval.endMs > segment.startMs && interval.startMs < segment.endMs) {
        boundaries.add(Math.max(interval.startMs, segment.startMs));
        boundaries.add(Math.min(interval.endMs, segment.endMs));
      }
    }
    const sortedBoundaries = [...boundaries].sort((left, right) => left - right);
    for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
      const startMs = sortedBoundaries[index]!;
      const endMs = sortedBoundaries[index + 1]!;
      const midpoint = startMs + (endMs - startMs) / 2;
      const exercising = exerciseIntervals.some((interval) => overlaps(interval, midpoint));
      const active = exercising || activityIntervals.some((interval) => overlaps(interval, midpoint));
      const asleep = sleepIntervals.some((interval) => overlaps(interval, midpoint));
      if (active && (!asleep || exercising)) {
        qualifiedSegments.push({ startMs, endMs, bpm: rawSegment.bpm });
      }
    }
  }

  const piecesByMinute = new Map<number, MillisecondHeartRateSegment[]>();
  for (const segment of qualifiedSegments.flatMap(splitAtMinuteBoundaries)) {
    const minuteStartMs = Math.floor(segment.startMs / 60_000) * 60_000;
    const pieces = piecesByMinute.get(minuteStartMs) ?? [];
    pieces.push(segment);
    piecesByMinute.set(minuteStartMs, pieces);
  }
  const eligibleSegments = [...piecesByMinute.values()].flatMap((pieces) => (
    pieces.reduce((total, piece) => total + piece.endMs - piece.startMs, 0) >= 30_000 ? pieces : []
  ));
  let qualifiedSeconds = 0;
  let weightedBpmSeconds = 0;
  for (const segment of eligibleSegments) {
    const seconds = (segment.endMs - segment.startMs) / 1_000;
    qualifiedSeconds += seconds;
    weightedBpmSeconds += segment.bpm * seconds;
  }

  return {
    qualifiedSeconds,
    avgBpm: qualifiedSeconds === 0 ? null : weightedBpmSeconds / qualifiedSeconds,
    segments: eligibleSegments.map(serialize),
  };
}

export function computeDailyTrimp(input: {
  sex: 'female' | 'male';
  rhrBaseBpm: number;
  hrMaxEstBpm: number;
  qualified: QualifiedHeartRate;
}): { status: 'scored' | 'invalid_hr_reserve'; dailyLoad: number | null } {
  if (input.hrMaxEstBpm <= input.rhrBaseBpm) {
    return { status: 'invalid_hr_reserve', dailyLoad: null };
  }

  const k = input.sex === 'male' ? 1.92 : 1.67;
  const dailyLoad = input.qualified.segments.reduce((total, segment) => {
    const milliseconds = toMilliseconds(segment);
    if (!milliseconds) {
      return total;
    }
    const hrr = Math.max(0, Math.min(1, (segment.bpm - input.rhrBaseBpm) / (input.hrMaxEstBpm - input.rhrBaseBpm)));
    if (hrr < 0.3) {
      return total;
    }
    return total + 0.64 * hrr * Math.exp(k * hrr) * ((milliseconds.endMs - milliseconds.startMs) / 60_000);
  }, 0);

  return {
    status: 'scored',
    dailyLoad,
  };
}

function unionIntervals(intervals: MillisecondInterval[]): MillisecondInterval[] {
  const merged: MillisecondInterval[] = [];
  for (const interval of [...intervals].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)) {
    const previous = merged.at(-1);
    if (previous && interval.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, interval.endMs);
      continue;
    }
    merged.push({ ...interval });
  }
  return merged;
}

function addCivilDays(civilDate: string, days: number): string {
  const date = new Date(`${civilDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function isQualifiedDay(input: {
  ianaTimeZone: string | null;
  localDayStart: string;
  localDayEnd: string;
  previousMainSleepEnd: string | null;
  nextMainSleepStart: string | null;
  observedIntervals: TimeInterval[];
}): {
  status: 'qualified' | 'insufficient_coverage' | 'missing_sleep_anchor' | 'timezone_ambiguous';
  reason: 'waking_gap_exceeds_four_hours' | 'minimum_hr_coverage_not_met' | 'awake_coverage_not_met' | 'sleep_anchor_missing' | 'invalid_iana_time_zone' | null;
  hrCoverageSeconds: number;
  awakeCoverageRatio: number | null;
} {
  if (!input.ianaTimeZone) {
    return { status: 'timezone_ambiguous', reason: 'invalid_iana_time_zone', hrCoverageSeconds: 0, awakeCoverageRatio: null };
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: input.ianaTimeZone }).format();
  } catch {
    return { status: 'timezone_ambiguous', reason: 'invalid_iana_time_zone', hrCoverageSeconds: 0, awakeCoverageRatio: null };
  }

  const wakingWindow = input.previousMainSleepEnd && input.nextMainSleepStart
    ? toMilliseconds({ start: input.previousMainSleepEnd, end: input.nextMainSleepStart })
    : undefined;
  if (!wakingWindow) {
    return { status: 'missing_sleep_anchor', reason: 'sleep_anchor_missing', hrCoverageSeconds: 0, awakeCoverageRatio: null };
  }

  const localDay = toMilliseconds({ start: input.localDayStart, end: input.localDayEnd });
  if (!localDay) {
    return { status: 'timezone_ambiguous', reason: 'invalid_iana_time_zone', hrCoverageSeconds: 0, awakeCoverageRatio: null };
  }
  const observedDuringLocalDay = unionIntervals(input.observedIntervals
    .map(toMilliseconds)
    .filter((interval): interval is MillisecondInterval => Boolean(interval))
    .map((interval) => ({
      startMs: Math.max(interval.startMs, localDay.startMs),
      endMs: Math.min(interval.endMs, localDay.endMs),
    }))
    .filter((interval) => interval.endMs > interval.startMs));
  const observedDuringWakingWindow = unionIntervals(observedDuringLocalDay
    .map((interval) => ({
      startMs: Math.max(interval.startMs, wakingWindow.startMs),
      endMs: Math.min(interval.endMs, wakingWindow.endMs),
    }))
    .filter((interval) => interval.endMs > interval.startMs));
  const rawCoveredMs = observedDuringLocalDay.reduce((total, interval) => total + interval.endMs - interval.startMs, 0);
  const wakingCoveredMs = observedDuringWakingWindow.reduce((total, interval) => total + interval.endMs - interval.startMs, 0);
  const wakingMs = wakingWindow.endMs - wakingWindow.startMs;
  const awakeCoverageRatio = wakingCoveredMs / wakingMs;

  let cursor = wakingWindow.startMs;
  let largestGapMs = 0;
  for (const interval of observedDuringWakingWindow) {
    largestGapMs = Math.max(largestGapMs, interval.startMs - cursor);
    cursor = interval.endMs;
  }
  largestGapMs = Math.max(largestGapMs, wakingWindow.endMs - cursor);

  const hrCoverageSeconds = rawCoveredMs / 1_000;
  if (largestGapMs > 4 * 60 * 60 * 1_000) {
    return { status: 'insufficient_coverage', reason: 'waking_gap_exceeds_four_hours', hrCoverageSeconds, awakeCoverageRatio };
  }
  if (hrCoverageSeconds < 12 * 60 * 60) {
    return { status: 'insufficient_coverage', reason: 'minimum_hr_coverage_not_met', hrCoverageSeconds, awakeCoverageRatio };
  }
  if (awakeCoverageRatio < 0.7) {
    return { status: 'insufficient_coverage', reason: 'awake_coverage_not_met', hrCoverageSeconds, awakeCoverageRatio };
  }
  return { status: 'qualified', reason: null, hrCoverageSeconds, awakeCoverageRatio };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function computeWeeklyBuildBaseline(input: {
  targetWeekStart: string;
  completedWeeks: Array<{ weekStart: string; qualifiedDayCount: number; weeklyLoad: number | null }>;
  priorStableBaseline: number | null;
  priorWeekEwma: number | null;
}): {
  status: 'stable' | 'frozen' | 'calibrating';
  rm4: number | null;
  ewma4: number | null;
  baseline: number | null;
  reason: 'four_continuous_qualified_weeks_required' | null;
} {
  const expectedWeekStarts = [-4, -3, -2, -1].map((offset) => addCivilDays(input.targetWeekStart, offset * 7));
  const byWeekStart = new Map(input.completedWeeks.map((week) => [week.weekStart, week]));
  const priorWeeks = expectedWeekStarts.map((weekStart) => byWeekStart.get(weekStart));
  const hasFourContinuousQualifiedWeeks = priorWeeks.every((week) => week?.qualifiedDayCount === 7 && week.weeklyLoad !== null);
  if (!hasFourContinuousQualifiedWeeks) {
    return input.priorStableBaseline === null
      ? { status: 'calibrating', rm4: null, ewma4: null, baseline: null, reason: 'four_continuous_qualified_weeks_required' }
      : { status: 'frozen', rm4: null, ewma4: null, baseline: input.priorStableBaseline, reason: 'four_continuous_qualified_weeks_required' };
  }

  const loads = priorWeeks.map((week) => week!.weeklyLoad!);
  const rm4 = round(loads.reduce((total, load) => total + load, 0) / loads.length);
  const ewma4 = input.priorWeekEwma === null
    ? rm4
    : round(0.4 * loads.at(-1)! + 0.6 * input.priorWeekEwma);
  return { status: 'stable', rm4, ewma4, baseline: Math.max(rm4, ewma4), reason: null };
}

function nearestRank(values: number[], percentile: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1] ?? null;
}

type RecoveryQuality = 'unavailable' | 'provisional' | 'medium' | 'high';
type RecoveryTier = 'low' | 'middle' | 'high' | 'unadjusted';

export function computeUsableLoad(input: {
  targetCivilDate: string;
  targetRecovery: { score: number; quality: RecoveryQuality } | null;
  history: Array<{
    civilDate: string;
    dailyLoad: number | null;
    qualifiedDay: boolean;
    recoveryScore: number | null;
    recoveryQuality: RecoveryQuality;
  }>;
}): {
  status: 'scored' | 'calibrating';
  usableLoad: number | null;
  recoveryTier: RecoveryTier | null;
  tierSampleCount: number;
  globalP90: number | null;
  tierP80: number | null;
  reason:
    | 'target_recovery_not_high_quality'
    | 'insufficient_historical_days'
    | 'no_positive_historical_capacity'
    | 'recovery_tiers_indistinguishable'
    | 'recovery_tier_insufficient'
    | null;
} {
  const usableHistory = input.history
    .filter((day) => day.civilDate < input.targetCivilDate && day.qualifiedDay && day.dailyLoad !== null && day.recoveryScore !== null && ['medium', 'high'].includes(day.recoveryQuality))
    .sort((left, right) => right.civilDate.localeCompare(left.civilDate))
    .slice(0, 28);
  const globalP90 = usableHistory.length >= 28 ? nearestRank(usableHistory.map((day) => day.dailyLoad!), 0.9) : null;
  if (!input.targetRecovery || !['medium', 'high'].includes(input.targetRecovery.quality)) {
    return {
      status: 'calibrating', usableLoad: null, recoveryTier: null, tierSampleCount: 0, globalP90, tierP80: null, reason: 'target_recovery_not_high_quality',
    };
  }
  if (usableHistory.length < 28) {
    return {
      status: 'calibrating', usableLoad: null, recoveryTier: null, tierSampleCount: 0, globalP90: null, tierP80: null, reason: 'insufficient_historical_days',
    };
  }

  const positiveGlobalP90 = globalP90!;
  if (positiveGlobalP90 <= 0) {
    return {
      status: 'calibrating', usableLoad: null, recoveryTier: null, tierSampleCount: 0, globalP90: positiveGlobalP90, tierP80: null, reason: 'no_positive_historical_capacity',
    };
  }

  const lowerBoundary = nearestRank(usableHistory.map((day) => day.recoveryScore!), 1 / 3)!;
  const upperBoundary = nearestRank(usableHistory.map((day) => day.recoveryScore!), 2 / 3)!;
  if (lowerBoundary === upperBoundary) {
    return {
      status: 'calibrating',
      usableLoad: positiveGlobalP90,
      recoveryTier: 'unadjusted',
      tierSampleCount: usableHistory.length,
      globalP90: positiveGlobalP90,
      tierP80: null,
      reason: 'recovery_tiers_indistinguishable',
    };
  }

  const recoveryTier: RecoveryTier = input.targetRecovery.score <= lowerBoundary
    ? 'low'
    : input.targetRecovery.score <= upperBoundary
      ? 'middle'
      : 'high';
  const tierHistory = usableHistory.filter((day) => (
    recoveryTier === 'low'
      ? day.recoveryScore! <= lowerBoundary
      : recoveryTier === 'middle'
        ? day.recoveryScore! > lowerBoundary && day.recoveryScore! <= upperBoundary
        : day.recoveryScore! > upperBoundary
  ));
  const tierP80 = tierHistory.length >= 7 ? nearestRank(tierHistory.map((day) => day.dailyLoad!), 0.8)! : null;
  return {
    status: tierP80 === null ? 'calibrating' : 'scored',
    usableLoad: tierP80 === null ? positiveGlobalP90 : Math.min(tierP80, positiveGlobalP90),
    recoveryTier,
    tierSampleCount: tierHistory.length,
    globalP90: positiveGlobalP90,
    tierP80,
    reason: tierP80 === null ? 'recovery_tier_insufficient' : null,
  };
}
