import { isPrimarySleepCandidate, type DailyHrv, type DailyRhr, type SleepSession, type TrainingDay } from './health-records';
import {
  METRIC_VERSION,
  type MetricEvidence,
  type MetricQuality,
  type RecoverySignalResult,
  type SessionLoadResult,
  type SleepCompletenessResult,
  type TrainingBalanceResult,
} from './metric-types';

const DAY_MS = 24 * 60 * 60 * 1_000;

type SleepCompletenessInput = {
  target: SleepSession | undefined;
  historicalPrimarySleeps: SleepSession[];
  sleepGoalMinutes: number | undefined;
};

type RecoverySignalInput = {
  targetDate: string;
  hrv: DailyHrv | undefined;
  rhr: DailyRhr | undefined;
  historicalHrv: DailyHrv[];
  historicalRhr: DailyRhr[];
  sleep: SleepCompletenessResult;
  now: string;
  lastSuccessfulSyncAt: string | undefined;
};

type ZoneMinutes = {
  light: number;
  moderate: number;
  vigorous: number;
  peak: number;
};

type HeartRateSample = {
  bpm: number;
  minutes: number;
};

type SessionLoadInput = {
  id: string;
  durationMinutes: number;
  zoneMinutes?: ZoneMinutes;
  heartRateSamples?: HeartRateSample[];
  rhrBpm?: number;
  hrMax?: number;
  age?: number;
  providerIntensity?: 'low' | 'moderate' | 'high';
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundScore(value: number): number {
  return Math.round(value * 10) / 10;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function toLocalMinutes(instant: string, utcOffsetMinutes: number): number {
  const local = new Date(Date.parse(instant) + utcOffsetMinutes * 60_000);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

function bedtimeCoordinate(session: SleepSession): number {
  const minutes = toLocalMinutes(session.startTime, session.utcOffsetMinutes);
  return minutes < 720 ? minutes + 1_440 : minutes;
}

function previousSessions(target: SleepSession, sessions: SleepSession[]): SleepSession[] {
  return sessions
    .filter((session) => session.userId === target.userId)
    .filter(isPrimarySleepCandidate)
    .filter((session) => session.civilEndDate < target.civilEndDate)
    .sort((left, right) => right.civilEndDate.localeCompare(left.civilEndDate))
    .slice(0, 28);
}

function qualityForSleep(components: SleepCompletenessResult['components'], historyCount: number): MetricQuality {
  if (historyCount < 14) {
    return 'calibrating';
  }

  return components.efficiency !== undefined && components.interruptions !== undefined && components.regularity !== undefined
    ? 'high'
    : 'medium';
}

export function selectPrimarySleepSession(sessions: SleepSession[], targetDate: string): SleepSession | undefined {
  return sessions
    .filter((session) => session.civilEndDate === targetDate)
    .filter(isPrimarySleepCandidate)
    .sort((left, right) => {
      if (right.minutesAsleep !== left.minutesAsleep) {
        return right.minutesAsleep - left.minutesAsleep;
      }

      if (right.processed !== left.processed) {
        return Number(right.processed) - Number(left.processed);
      }

      const startDifference = Date.parse(left.startTime) - Date.parse(right.startTime);
      return startDifference !== 0 ? startDifference : left.id.localeCompare(right.id);
    })[0];
}

export function computeSleepCompleteness(input: SleepCompletenessInput): SleepCompletenessResult {
  const target = input.target;

  if (!target) {
    return {
      kind: 'no_score',
      score: null,
      quality: 'low',
      reason: 'sleep_missing',
      components: { duration: 0 },
      evidence: [],
      metricVersion: METRIC_VERSION,
    };
  }

  if (!input.sleepGoalMinutes || input.sleepGoalMinutes <= 0) {
    return {
      kind: 'no_score',
      score: null,
      quality: 'low',
      reason: 'sleep_goal_missing',
      components: { duration: 0 },
      evidence: [{ label: '实际睡眠', date: target.civilEndDate, value: target.minutesAsleep }],
      metricVersion: METRIC_VERSION,
    };
  }

  const components: SleepCompletenessResult['components'] = {
    duration: clamp((100 * target.minutesAsleep) / input.sleepGoalMinutes, 0, 100),
  };
  const weightedComponents: Array<{ score: number; weight: number }> = [{ score: components.duration, weight: 0.4 }];

  if (target.timeInBedMinutes && target.timeInBedMinutes > 0) {
    components.efficiency = clamp((100 * target.minutesAsleep) / target.timeInBedMinutes, 0, 100);
    weightedComponents.push({ score: components.efficiency, weight: 0.25 });
  }

  if (target.awakeMinutes !== undefined && target.awakeSegments !== undefined) {
    components.interruptions = clamp(100 - 0.75 * target.awakeMinutes - 5 * target.awakeSegments, 0, 100);
    weightedComponents.push({ score: components.interruptions, weight: 0.15 });
  }

  const history = previousSessions(target, input.historicalPrimarySleeps);
  if (history.length >= 14) {
    const reference = history.slice(0, 14);
    const bedtimeMedian = median(reference.map(bedtimeCoordinate));
    const wakeMedian = median(reference.map((session) => toLocalMinutes(session.endTime, session.utcOffsetMinutes)));
    const bedtimeDifference = Math.abs(bedtimeCoordinate(target) - bedtimeMedian);
    const wakeDifference = Math.abs(toLocalMinutes(target.endTime, target.utcOffsetMinutes) - wakeMedian);
    components.regularity = clamp(100 - 0.8 * (bedtimeDifference + wakeDifference), 0, 100);
    weightedComponents.push({ score: components.regularity, weight: 0.2 });
  }

  const totalWeight = weightedComponents.reduce((total, component) => total + component.weight, 0);
  if (totalWeight < 0.4) {
    return {
      kind: 'no_score',
      score: null,
      quality: 'low',
      reason: 'insufficient_sleep_inputs',
      components,
      evidence: [{ label: '实际睡眠', date: target.civilEndDate, value: target.minutesAsleep }],
      metricVersion: METRIC_VERSION,
    };
  }

  const score = weightedComponents.reduce((total, component) => total + component.score * component.weight, 0) / totalWeight;
  return {
    kind: 'score',
    score: roundScore(score),
    quality: qualityForSleep(components, history.length),
    components,
    evidence: [
      { label: '实际睡眠', date: target.civilEndDate, value: target.minutesAsleep },
      { label: '睡眠目标', date: target.civilEndDate, value: input.sleepGoalMinutes },
    ],
    metricVersion: METRIC_VERSION,
  };
}

function baselineFor<T extends { date: string; userId: string }>(
  targetDate: string,
  userId: string,
  records: T[],
  toValue: (record: T) => number,
): number[] {
  return records
    .filter((record) => record.userId === userId && record.date < targetDate)
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, 28)
    .map(toValue);
}

function robustScore(value: number, baselineValues: number[], direction: 'higher_is_better' | 'lower_is_better', floor: number) {
  const baseline = median(baselineValues);
  const deviations = baselineValues.map((candidate) => Math.abs(candidate - baseline));
  const scale = Math.max(1.4826 * median(deviations), floor);
  const z = (value - baseline) / scale;
  const signedZ = direction === 'higher_is_better' ? z : -z;

  return { baseline, score: clamp(50 + 15 * signedZ, 0, 100) };
}

function staleSync(now: string, lastSuccessfulSyncAt: string | undefined): boolean {
  if (!lastSuccessfulSyncAt) {
    return true;
  }

  return Date.parse(now) - Date.parse(lastSuccessfulSyncAt) > 36 * 60 * 60 * 1_000;
}

export function computeRecoverySignal(input: RecoverySignalInput): RecoverySignalResult {
  const components: RecoverySignalResult['components'] = {};
  const evidence: MetricEvidence[] = [];
  const weightedComponents: Array<{ score: number; weight: number }> = [];
  let hrvBaselineCount = 0;
  let rhrBaselineCount = 0;

  if (input.hrv) {
    const baselineValues = baselineFor(input.targetDate, input.hrv.userId, input.historicalHrv, (record) => record.valueMs);
    hrvBaselineCount = baselineValues.length;
    if (baselineValues.length >= 14) {
      const calculated = robustScore(input.hrv.valueMs, baselineValues, 'higher_is_better', 5);
      components.hrv = { score: calculated.score, weight: 0.4, value: input.hrv.valueMs, baseline: calculated.baseline };
      weightedComponents.push({ score: calculated.score, weight: 0.4 });
      evidence.push({ label: 'HRV', date: input.hrv.date, value: input.hrv.valueMs });
    }
  }

  if (input.rhr) {
    const baselineValues = baselineFor(input.targetDate, input.rhr.userId, input.historicalRhr, (record) => record.valueBpm);
    rhrBaselineCount = baselineValues.length;
    if (baselineValues.length >= 14) {
      const calculated = robustScore(input.rhr.valueBpm, baselineValues, 'lower_is_better', 3);
      components.rhr = { score: calculated.score, weight: 0.3, value: input.rhr.valueBpm, baseline: calculated.baseline };
      weightedComponents.push({ score: calculated.score, weight: 0.3 });
      evidence.push({ label: '静息心率', date: input.rhr.date, value: input.rhr.valueBpm });
    }
  }

  if (input.sleep.kind === 'score' && input.sleep.score !== null) {
    components.sleep = { score: input.sleep.score, weight: 0.3, value: input.sleep.score };
    weightedComponents.push({ score: input.sleep.score, weight: 0.3 });
    evidence.push({ label: '睡眠完整度', date: input.targetDate, value: input.sleep.score });
  }

  if (weightedComponents.length < 2) {
    return {
      kind: 'no_score',
      score: null,
      quality: 'calibrating',
      reason: 'insufficient_recovery_components',
      components,
      evidence,
      metricVersion: METRIC_VERSION,
    };
  }

  const totalWeight = weightedComponents.reduce((total, component) => total + component.weight, 0);
  const score = weightedComponents.reduce((total, component) => total + component.score * component.weight, 0) / totalWeight;
  const isStale = staleSync(input.now, input.lastSuccessfulSyncAt);
  const quality: MetricQuality = isStale
    ? 'low'
    : weightedComponents.length === 3 && hrvBaselineCount >= 28 && rhrBaselineCount >= 28 && input.sleep.quality === 'high'
      ? 'high'
      : 'medium';
  const roundedScore = roundScore(score);
  const status = roundedScore <= 39 ? '恢复优先' : roundedScore <= 69 ? '维持' : '状态较好';

  return {
    kind: 'score',
    score: roundedScore,
    quality,
    status,
    components,
    evidence,
    metricVersion: METRIC_VERSION,
  };
}

export function computeSessionLoad(input: SessionLoadInput): SessionLoadResult {
  if (input.zoneMinutes) {
    const zones = input.zoneMinutes;
    const values = [zones.light, zones.moderate, zones.vigorous, zones.peak];
    if (values.every((value) => Number.isFinite(value) && value >= 0)) {
      return {
        source: 'zone_summary',
        load: zones.light + 3 * zones.moderate + 4 * zones.vigorous + 5 * zones.peak,
      };
    }
  }

  const hrMax = input.hrMax ?? (input.age === undefined ? undefined : 208 - 0.7 * input.age);
  const hasValidHrInputs =
    input.heartRateSamples &&
    input.heartRateSamples.length > 0 &&
    input.rhrBpm !== undefined &&
    hrMax !== undefined &&
    hrMax >= 100 &&
    hrMax <= 230 &&
    hrMax >= input.rhrBpm + 20;

  if (hasValidHrInputs && input.heartRateSamples && input.rhrBpm !== undefined && hrMax !== undefined) {
    const load = input.heartRateSamples.reduce((total, sample) => {
      const reserve = (sample.bpm - input.rhrBpm!) / (hrMax - input.rhrBpm!);
      const weight = reserve < 0.5 ? 1 : reserve < 0.6 ? 2 : reserve < 0.7 ? 3 : reserve < 0.8 ? 4 : 5;
      return total + weight * sample.minutes;
    }, 0);
    return { source: 'minute_hr', load };
  }

  if (input.providerIntensity) {
    const weight = input.providerIntensity === 'low' ? 1 : input.providerIntensity === 'moderate' ? 3 : 5;
    return { source: 'session_fallback', load: input.durationMinutes * weight };
  }

  return { source: 'unavailable', load: null };
}

function sevenDaysBefore(targetDate: string): string {
  return new Date(Date.parse(`${targetDate}T00:00:00.000Z`) - 6 * DAY_MS).toISOString().slice(0, 10);
}

export function computeTrainingBalance(days: TrainingDay[], targetDate: string): TrainingBalanceResult {
  const periodDays = days
    .filter((day) => day.date <= targetDate)
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, 28);
  const completeDays = periodDays.filter((day) => day.completeness === 'complete' && day.load !== null);
  const nonZeroDays = completeDays.filter((day) => (day.load ?? 0) > 0);

  if (completeDays.length < 24 || nonZeroDays.length < 8) {
    return {
      kind: 'no_score',
      ratio: null,
      quality: 'calibrating',
      reason: 'training_baseline_calibrating',
      metricVersion: METRIC_VERSION,
    };
  }

  const shortStart = sevenDaysBefore(targetDate);
  const shortDays = completeDays.filter((day) => day.date >= shortStart);
  if (shortDays.length < 7) {
    return {
      kind: 'no_score',
      ratio: null,
      quality: 'low',
      reason: 'training_data_incomplete',
      metricVersion: METRIC_VERSION,
    };
  }

  const shortAverage = shortDays.reduce((total, day) => total + (day.load ?? 0), 0) / 7;
  const longAverage = completeDays.reduce((total, day) => total + (day.load ?? 0), 0) / 28;
  if (longAverage < 5) {
    return {
      kind: 'no_score',
      ratio: null,
      quality: 'calibrating',
      reason: 'training_baseline_calibrating',
      metricVersion: METRIC_VERSION,
    };
  }

  const ratio = shortAverage / longAverage;
  const label = ratio < 0.8 ? '低于近期习惯' : ratio <= 1.3 ? '接近近期习惯' : '增加较快';
  return {
    kind: 'score',
    ratio: roundScore(ratio),
    quality: 'high',
    label,
    metricVersion: METRIC_VERSION,
  };
}
