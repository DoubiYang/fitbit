import type { MetricResult } from '../../domain/cardio-records';
import {
  type MetricCoverageState,
  type MetricEvidence,
  type MetricSourceState,
  type RecoveryQuality,
  type StrainStatus,
} from '../../domain/metric-types';
import { computeRecovery, computeSleepPerformance } from '../../domain/whoop-style-metrics';
import type { UserHealthRecords } from '../health/provider';
import type { HealthMetricsStore } from '../health/cardio-store';
import type { HealthProvider } from '../health/provider';
import { civilDateDaysAgo, resolveDashboardCivilDate } from '../time/civil-date';

type BuildTodayInput = {
  provider: HealthProvider;
  userId: string;
  now: string;
  lastSuccessfulSyncAt: string | undefined;
  timeZone?: string;
  allowDefaultTimeZone?: boolean;
  healthMetrics?: HealthMetricsStore;
};

export type StrainMetricView = {
  label: string;
  score: number | null;
  status: StrainStatus;
  detail: string;
  coverage?: MetricCoverageState;
  source?: MetricSourceState;
  evidence?: MetricEvidence[];
};

export type RecoveryMetricView = {
  label: string;
  score: number | null;
  quality: RecoveryQuality;
  detail: string;
  evidence?: MetricEvidence[];
};

export type SleepPerformanceMetricView = {
  label: string;
  score: number | null;
  detail: string;
  evidence?: MetricEvidence[];
};

type TodayAction =
  | {
      kind: 'recommendation';
      text: string;
      evidence: MetricEvidence[];
    }
  | {
      kind: 'data_state';
      text: string;
      evidence: MetricEvidence[];
    };

export type TodayView = {
  userId: string;
  generatedAt: string;
  localDate: string;
  freshness: 'fresh' | 'stale';
  primaryAction: TodayAction;
  metrics: {
    strain: StrainMetricView;
    recovery: RecoveryMetricView;
    sleepPerformance: SleepPerformanceMetricView;
  };
};

const STALE_SYNC_MS = 36 * 60 * 60 * 1_000;

function scopedRecords(records: UserHealthRecords, userId: string): UserHealthRecords {
  return {
    sleepSessions: records.sleepSessions.filter((record) => record.userId === userId),
    dailyHrv: records.dailyHrv.filter((record) => record.userId === userId),
    dailyRhr: records.dailyRhr.filter((record) => record.userId === userId),
    trainingDays: records.trainingDays.filter((record) => record.userId === userId),
  };
}

function strainDetail(status: StrainStatus, reason: string | null | undefined): string {
  if (status === 'complete') {
    return '完整日心肺负荷，仅计入可归因活动分钟。';
  }
  if (status === 'provisional') {
    return '临时心肺负荷，不可与完整日直接比较。';
  }
  if (status === 'timezone_ambiguous') {
    return '时区不明确，当地日无法作为完整日。';
  }
  if (status === 'incomplete' || reason === 'insufficient_coverage') {
    return '覆盖不足，因此没有完整日 Strain。';
  }
  return '缺少心率区间、活动上下文或同步结果，因此没有 Strain 分数。';
}

function recoveryDetail(quality: RecoveryQuality): string {
  if (quality === 'high') {
    return '恢复分数相对你近期的个人常态。这是趋势说明。';
  }
  if (quality === 'medium') {
    return '恢复分数相对你近期的个人常态，部分输入仍在校准。';
  }
  if (quality === 'provisional') {
    return '数据质量为临时：基线、覆盖或同步尚未满足完整条件。';
  }
  return '数据不足或同步待完成，因此没有恢复分数。';
}

function sleepDetail(score: number | null, reason: string | null | undefined): string {
  if (score !== null) {
    return '昨夜主睡眠相对于动态睡眠需求的完成度。';
  }
  if (reason === 'sleep_goal_missing') {
    return '尚未设置基础睡眠目标，因此没有 Sleep Performance。';
  }
  if (reason === 'primary_sleep_missing' || reason === 'sleep_missing') {
    return '没有可用的主睡眠记录，因此没有 Sleep Performance。';
  }
  return '睡眠表现尚未计算。';
}

function primaryAction(input: {
  score: number | null;
  quality: RecoveryQuality;
  evidence: MetricEvidence[];
}): TodayAction {
  const evidence = input.evidence.slice(0, 3);
  if (input.score !== null && input.quality === 'high') {
    return {
      kind: 'recommendation',
      text: '恢复分数相对你近期个人常态较高。这只说明趋势。',
      evidence,
    };
  }
  if (input.score !== null && input.quality === 'medium') {
    return {
      kind: 'recommendation',
      text: '恢复分数接近你近期个人常态。这只说明趋势。',
      evidence,
    };
  }
  if (input.quality === 'provisional') {
    return {
      kind: 'data_state',
      text: '数据质量为临时：基线、覆盖或同步尚未满足完整条件。',
      evidence,
    };
  }
  return {
    kind: 'data_state',
    text: '数据不足或同步待完成，因此没有可比较的恢复分数。',
    evidence,
  };
}

function freshnessOf(now: string, lastSuccessfulSyncAt: string | undefined): 'fresh' | 'stale' {
  if (!lastSuccessfulSyncAt) {
    return 'stale';
  }
  return Date.parse(now) - Date.parse(lastSuccessfulSyncAt) > STALE_SYNC_MS ? 'stale' : 'fresh';
}

function strainFromResult(result: MetricResult | undefined): StrainMetricView {
  const status = result?.status ?? 'unavailable';
  return {
    label: '全天心肺负荷',
    score: result?.score ?? null,
    status,
    detail: strainDetail(status, result?.reason),
    coverage: result?.coverage,
    source: result?.source,
    evidence: result?.evidence,
  };
}

function recoveryFromResult(result: MetricResult | undefined): RecoveryMetricView {
  const quality = result?.quality ?? 'unavailable';
  return {
    label: '恢复',
    score: result?.score ?? null,
    quality,
    detail: recoveryDetail(quality),
    evidence: result?.evidence,
  };
}

function sleepFromResult(result: MetricResult | undefined): SleepPerformanceMetricView {
  return {
    label: '睡眠表现',
    score: result?.score ?? null,
    detail: sleepDetail(result?.score ?? null, result?.reason),
    evidence: result?.evidence,
  };
}

async function metricsFromStore(
  store: HealthMetricsStore,
  userId: string,
  localDate: string,
): Promise<TodayView['metrics']> {
  const [strain, recovery, sleepPerformance] = await Promise.all([
    store.getMetricResult({ userId, civilDate: localDate, metricName: 'strain' }),
    store.getMetricResult({ userId, civilDate: localDate, metricName: 'recovery' }),
    store.getMetricResult({ userId, civilDate: localDate, metricName: 'sleep_performance' }),
  ]);
  return {
    strain: strainFromResult(strain),
    recovery: recoveryFromResult(recovery),
    sleepPerformance: sleepFromResult(sleepPerformance),
  };
}

async function metricsFromRecords(
  records: UserHealthRecords,
  userId: string,
  localDate: string,
  now: string,
  lastSuccessfulSyncAt: string | undefined,
): Promise<TodayView['metrics']> {
  const sleep = computeSleepPerformance({
    targetDate: localDate,
    sessions: records.sleepSessions,
    goals: [],
  });
  const recovery = computeRecovery({
    targetDate: localDate,
    hrv: records.dailyHrv.find((record) => record.date === localDate && record.userId === userId),
    rhr: records.dailyRhr.find((record) => record.date === localDate && record.userId === userId),
    historicalHrv: records.dailyHrv,
    historicalRhr: records.dailyRhr,
    sleep,
    now,
    lastSuccessfulSyncAt,
  });
  return {
    strain: {
      label: '全天心肺负荷',
      score: null,
      status: 'unavailable',
      detail: strainDetail('unavailable', 'heart_rate_zones_missing'),
    },
    recovery: {
      label: '恢复',
      score: recovery.score,
      quality: recovery.quality,
      detail: recoveryDetail(recovery.quality),
      evidence: recovery.evidence,
    },
    sleepPerformance: {
      label: '睡眠表现',
      score: sleep.score,
      detail: sleepDetail(sleep.score, sleep.reason),
      evidence: sleep.evidence,
    },
  };
}

export async function buildTodayView(input: BuildTodayInput): Promise<TodayView> {
  const localDate = resolveDashboardCivilDate(
    new Date(input.now),
    input.timeZone,
    input.allowDefaultTimeZone ? 'default' : 'utc',
  );
  const metrics = input.healthMetrics
    ? await metricsFromStore(input.healthMetrics, input.userId, localDate)
    : await metricsFromRecords(
        scopedRecords(
          await input.provider.listRecords(input.userId, {
            from: civilDateDaysAgo(localDate, 90),
            to: localDate,
          }),
          input.userId,
        ),
        input.userId,
        localDate,
        input.now,
        input.lastSuccessfulSyncAt,
      );

  return {
    userId: input.userId,
    generatedAt: input.now,
    localDate,
    freshness: freshnessOf(input.now, input.lastSuccessfulSyncAt),
    primaryAction: primaryAction({
      score: metrics.recovery.score,
      quality: metrics.recovery.quality,
      evidence: metrics.recovery.evidence ?? [],
    }),
    metrics,
  };
}
