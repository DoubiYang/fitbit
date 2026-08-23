export const METRIC_VERSION = 'p1-v1';

export type MetricQuality = 'high' | 'medium' | 'low' | 'calibrating';

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
