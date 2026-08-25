import { computeRecoverySignal, computeSleepCompleteness, computeTrainingBalance, selectPrimarySleepSession } from '../../domain/metrics';
import type { MetricEvidence, MetricQuality, RecoverySignalResult, SleepCompletenessResult, TrainingBalanceResult } from '../../domain/metric-types';
import type { UserHealthRecords } from '../health/provider';
import type { HealthProvider } from '../health/provider';
import { civilDate, civilDateDaysAgo } from '../time/civil-date';

type BuildTodayInput = {
  provider: HealthProvider;
  userId: string;
  now: string;
  lastSuccessfulSyncAt: string | undefined;
};

type TodayMetric = {
  label: string;
  score: number | null;
  quality: MetricQuality;
  detail: string;
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
  freshness: 'fresh' | 'stale';
  primaryAction: TodayAction;
  metrics: {
    recovery: TodayMetric;
    sleep: TodayMetric;
    training: TodayMetric;
  };
};

function dateFor(instant: string): string {
  return civilDate(new Date(instant));
}

function startDateFor(now: string): string {
  return civilDateDaysAgo(dateFor(now), 90);
}

function scopedRecords(records: UserHealthRecords, userId: string): UserHealthRecords {
  return {
    sleepSessions: records.sleepSessions.filter((record) => record.userId === userId),
    dailyHrv: records.dailyHrv.filter((record) => record.userId === userId),
    dailyRhr: records.dailyRhr.filter((record) => record.userId === userId),
    trainingDays: records.trainingDays.filter((record) => record.userId === userId),
  };
}

function latestDate(records: UserHealthRecords, fallback: string): string {
  return [
    ...records.sleepSessions.map((record) => record.civilEndDate),
    ...records.dailyHrv.map((record) => record.date),
    ...records.dailyRhr.map((record) => record.date),
    ...records.trainingDays.map((record) => record.date),
  ].sort((left, right) => right.localeCompare(left))[0] ?? fallback;
}

function metricDetail(result: SleepCompletenessResult | RecoverySignalResult | TrainingBalanceResult): string {
  if (result.kind === 'no_score') {
    return result.quality === 'calibrating' ? '校准中：继续积累有效数据。' : '数据不足：补齐同步或目标设置后再计算。';
  }

  return result.quality === 'high' ? '数据完整。' : result.quality === 'medium' ? '存在部分缺失或临时基线。' : '数据较旧，请先同步。';
}

function primaryAction(recovery: RecoverySignalResult): TodayAction {
  if (recovery.kind === 'score' && recovery.quality !== 'low' && recovery.evidence.length >= 2) {
    const text =
      recovery.status === '恢复优先'
        ? '今天建议以恢复为主，保持轻量活动并留意主观疲劳。'
        : recovery.status === '状态较好'
          ? '今天状态相对个人常态较好，可按原计划安排训练并根据主观感受调整。'
          : '今天建议维持原有节奏，避免在数据不完整时额外加量。';
    return { kind: 'recommendation', text, evidence: recovery.evidence.slice(0, 3) };
  }

  return {
    kind: 'data_state',
    text: '目前数据仍在校准或不够新鲜，先同步并补齐睡眠、HRV 或静息心率后再给出个性化安排。',
    evidence: recovery.evidence.slice(0, 3),
  };
}

export async function buildTodayView(input: BuildTodayInput): Promise<TodayView> {
  const nowDate = dateFor(input.now);
  const records = scopedRecords(
    await input.provider.listRecords(input.userId, { from: startDateFor(input.now), to: nowDate }),
    input.userId,
  );
  const targetDate = latestDate(records, nowDate);
  const targetSleep = selectPrimarySleepSession(records.sleepSessions, targetDate);
  const sleep = computeSleepCompleteness({
    target: targetSleep,
    historicalPrimarySleeps: records.sleepSessions,
    sleepGoalMinutes: 480,
  });
  const recovery = computeRecoverySignal({
    targetDate,
    hrv: records.dailyHrv.find((record) => record.date === targetDate),
    rhr: records.dailyRhr.find((record) => record.date === targetDate),
    historicalHrv: records.dailyHrv,
    historicalRhr: records.dailyRhr,
    sleep,
    now: input.now,
    lastSuccessfulSyncAt: input.lastSuccessfulSyncAt,
  });
  const training = computeTrainingBalance(records.trainingDays, targetDate);
  const freshness = recovery.quality === 'low' ? 'stale' : 'fresh';

  return {
    userId: input.userId,
    generatedAt: input.now,
    freshness,
    primaryAction: primaryAction(recovery),
    metrics: {
      recovery: {
        label: '恢复信号',
        score: recovery.score,
        quality: recovery.quality,
        detail: metricDetail(recovery),
      },
      sleep: {
        label: '睡眠完整度',
        score: sleep.score,
        quality: sleep.quality,
        detail: metricDetail(sleep),
      },
      training: {
        label: '训练负荷',
        score: training.ratio,
        quality: training.quality,
        detail: metricDetail(training),
      },
    },
  };
}
