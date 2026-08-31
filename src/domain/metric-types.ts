export const METRIC_VERSION = 'p1-v1';
export const WHOOP_STYLE_METRIC_VERSION = 'whoop-style-v2';

export type MetricQuality = 'high' | 'medium' | 'low' | 'calibrating';
export type RecoveryQuality = 'unavailable' | 'provisional' | 'medium' | 'high';
export type StrainStatus = 'complete' | 'provisional' | 'incomplete' | 'timezone_ambiguous' | 'unavailable';
export type HeartRateZoneId = 'light' | 'moderate' | 'vigorous' | 'peak';
export type MetricName = 'strain' | 'sleep_performance' | 'recovery';

export type ZoneMinutes = {
  light: number;
  moderate: number;
  vigorous: number;
  peak: number;
};

export type MetricSourceState = {
  heartRateZones: boolean;
  activityLevel: boolean;
  exercise: boolean;
  sleep: boolean;
  hrv: boolean;
  rhr: boolean;
  sleepGoal: boolean;
  timeZone: 'unambiguous' | 'ambiguous' | 'missing';
};

export type MetricCoverageState = {
  knownContextMinutes: number;
  rawHeartRateMinutes: number;
  attributedMinutes: number;
  lastKnownContextAt: string | null;
};

export type StrainUnavailableReason =
  | 'heart_rate_zones_missing'
  | 'activity_context_missing'
  | 'insufficient_coverage'
  | 'timezone_ambiguous'
  | 'unknown_context';

export type SleepUnavailableReason = 'sleep_missing' | 'sleep_goal_missing' | 'primary_sleep_missing';

export type RecoveryUnavailableReason = 'insufficient_recovery_components' | 'out_of_range';

export type MetricEvidence = {
  label: string;
  date: string;
  value: number | string;
};

export type SleepComponents = {
  duration: number;
  efficiency?: number;
  interruptions?: number;
  regularity?: number;
};

export type SleepCompletenessResult = {
  kind: 'score' | 'no_score';
  score: number | null;
  quality: MetricQuality;
  reason?: 'sleep_missing' | 'sleep_goal_missing' | 'insufficient_sleep_inputs';
  components: SleepComponents;
  evidence: MetricEvidence[];
  metricVersion: typeof METRIC_VERSION;
};

export type RecoveryComponent = {
  score: number;
  weight: number;
  value?: number;
  baseline?: number;
};

export type RecoverySignalResult = {
  kind: 'score' | 'no_score';
  score: number | null;
  quality: MetricQuality;
  reason?: 'insufficient_recovery_components';
  status?: '恢复优先' | '维持' | '状态较好';
  components: {
    hrv?: RecoveryComponent;
    rhr?: RecoveryComponent;
    sleep?: RecoveryComponent;
  };
  evidence: MetricEvidence[];
  metricVersion: typeof METRIC_VERSION;
};

export type SessionLoadResult = {
  load: number | null;
  source: 'zone_summary' | 'minute_hr' | 'session_fallback' | 'unavailable';
};

export type TrainingBalanceResult = {
  kind: 'score' | 'no_score';
  ratio: number | null;
  quality: MetricQuality;
  reason?: 'training_baseline_calibrating' | 'training_data_incomplete';
  label?: '低于近期习惯' | '接近近期习惯' | '增加较快';
  metricVersion: typeof METRIC_VERSION;
};

export type StrainResult = {
  kind: 'score' | 'no_score';
  score: number | null;
  status: StrainStatus;
  reason: StrainUnavailableReason | null;
  dose: number | null;
  zoneMinutes: ZoneMinutes;
  coverage: MetricCoverageState;
  source: MetricSourceState;
  evidence: MetricEvidence[];
  metricVersion: typeof WHOOP_STYLE_METRIC_VERSION;
};

export type SleepPerformanceResult = {
  kind: 'score' | 'no_score';
  score: number | null;
  reason: SleepUnavailableReason | null;
  minutesAsleep: number | null;
  goalMinutes: number | null;
  needMinutes: number | null;
  debtMinutes: number;
  debtCompensationMinutes: number;
  strainCompensationMinutes: number;
  sleepHistoryIncomplete: boolean;
  coverage: MetricCoverageState;
  source: MetricSourceState;
  evidence: MetricEvidence[];
  metricVersion: typeof WHOOP_STYLE_METRIC_VERSION;
};

export type WhoopStyleRecoveryResult = {
  kind: 'score' | 'no_score';
  score: number | null;
  quality: RecoveryQuality;
  reason: RecoveryUnavailableReason | null;
  components: {
    hrv?: RecoveryComponent & { baselineDays: number };
    rhr?: RecoveryComponent & { baselineDays: number };
    sleep?: RecoveryComponent;
  };
  sleepHistoryIncomplete: boolean;
  coverage: MetricCoverageState;
  source: MetricSourceState;
  evidence: MetricEvidence[];
  metricVersion: typeof WHOOP_STYLE_METRIC_VERSION;
};
