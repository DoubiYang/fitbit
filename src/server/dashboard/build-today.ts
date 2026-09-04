import type { DailyCardioLoad, DailyHeartRateZones, MetricResult } from '../../domain/cardio-records';
import { BODY_AGE_REFERENCE_VERSION, type BodyAgeDataGaps, type BodyAgeStatus, type BodyAgeRoute } from '../../domain/body-age';
import {
  type MetricCoverageState,
  type MetricEvidence,
  type MetricSourceState,
  type RecoveryQuality,
  type StrainStatus,
  type ZoneMinutes,
} from '../../domain/metric-types';
import { computeRecovery, computeSleepPerformance } from '../../domain/whoop-style-metrics';
import type { UserHealthRecords } from '../health/provider';
import type { HealthMetricsStore } from '../health/cardio-store';
import { BODY_AGE_ALGORITHM_VERSION, BODY_AGE_WINDOW_DAYS } from '../health/body-age-recompute';
import { bodyAgeFingerprintContext, bodyAgeInputFingerprint } from '../health/body-age-fingerprint';
import type { HealthProvider } from '../health/provider';
import { buildCardioLoadTimeline, type CardioLoadTimeline } from './cardio-load-timeline';
import { civilDateDaysAgo, DEFAULT_CIVIL_TIME_ZONE, resolveDashboardCivilDate } from '../time/civil-date';

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
  heartRateZones?: DailyHeartRateZones['zones'];
  timeInZone?: ZoneMinutes;
  activityZoneMinutes?: ZoneMinutes;
  dose?: number | null;
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

export type CardioLoadMetricView = {
  label: string;
  dailyLoad: number | null;
  status: DailyCardioLoad['status'] | 'unavailable';
  detail: string;
  timeline: CardioLoadTimeline;
  observation: {
    observedThrough: string | null;
    qualifiedMinutes: number;
    unverifiedElevatedHrMinutes: number;
  };
  capacity: {
    status: 'scored' | 'calibrating' | 'unavailable';
    usableLoad: number | null;
    utilization: number | null;
    recoveryAdjusted: boolean;
  };
  weekly: {
    status: 'stable' | 'frozen' | 'calibrating' | 'unavailable';
    baseline: number | null;
    weekToDateLoad: number | null;
  };
};

export type BodyAgeMetricView = {
  label: string;
  age: number | null;
  edge: 'below_reference_min' | 'above_reference_max' | null;
  status: BodyAgeStatus | 'data_updating';
  route: BodyAgeRoute;
  coverageDays: number;
  latestInputCivilDate: string | null;
  lastCalculatedCivilDate: string | null;
  referenceVersion: string;
  chronologicalAgeDeltaYears: number | null;
  dataGaps: BodyAgeDataGaps;
  disclaimer: 'non_medical_non_calibrated_estimate';
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
    cardioLoad: CardioLoadMetricView;
    /** Present in API/build output; optional only while the dashboard UI rolls out separately. */
    bodyAge?: BodyAgeMetricView;
  };
};

/** Browser-facing homepage projection. Keep the internal TodayView server-only. */
export type HomepageTodayView = {
  localDate: string;
  freshness: 'fresh' | 'stale';
  primaryAction: {
    kind: 'recommendation' | 'data_state';
    text: string;
  };
  metrics: {
    recovery: Pick<RecoveryMetricView, 'label' | 'score' | 'quality' | 'detail'>;
    sleepPerformance: Pick<SleepPerformanceMetricView, 'label' | 'score' | 'detail'>;
    cardioLoad: CardioLoadMetricView;
    bodyAge?: BodyAgeMetricView;
  };
};

export function toHomepageTodayView(view: TodayView): HomepageTodayView {
  const bodyAge = view.metrics.bodyAge;
  const staleDetail = '同步数据已超过 36 小时，请等待下一次同步或重新同步后再查看趋势。';
  const isStale = view.freshness === 'stale';
  return {
    localDate: view.localDate,
    freshness: view.freshness,
    primaryAction: {
      kind: view.primaryAction.kind,
      text: view.primaryAction.text,
    },
    metrics: {
      recovery: {
        label: view.metrics.recovery.label,
        score: isStale ? null : view.metrics.recovery.score,
        quality: isStale ? 'unavailable' : view.metrics.recovery.quality,
        detail: isStale ? staleDetail : view.metrics.recovery.detail,
      },
      sleepPerformance: {
        label: view.metrics.sleepPerformance.label,
        score: view.metrics.sleepPerformance.score,
        detail: view.metrics.sleepPerformance.detail,
      },
      cardioLoad: isStale
        ? unavailableCardioLoad(staleDetail)
        : view.metrics.cardioLoad,
      ...(bodyAge ? {
        bodyAge: {
          label: bodyAge.label,
          age: bodyAge.age,
          edge: bodyAge.edge,
          status: bodyAge.status,
          route: bodyAge.route,
          coverageDays: bodyAge.coverageDays,
          latestInputCivilDate: bodyAge.latestInputCivilDate,
          lastCalculatedCivilDate: bodyAge.lastCalculatedCivilDate,
          referenceVersion: bodyAge.referenceVersion,
          chronologicalAgeDeltaYears: bodyAge.chronologicalAgeDeltaYears,
          dataGaps: {
            dailyVo2DaysNeeded: bodyAge.dataGaps.dailyVo2DaysNeeded,
            rhrDaysNeeded: bodyAge.dataGaps.rhrDaysNeeded,
            observedHrPeakRequired: bodyAge.dataGaps.observedHrPeakRequired,
          },
          disclaimer: bodyAge.disclaimer,
        },
      } : {}),
    },
  };
}

function addCivilDays(civilDate: string, days: number): string {
  const next = new Date(`${civilDate}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function mondayOf(civilDate: string): string {
  const date = new Date(`${civilDate}T00:00:00.000Z`);
  return addCivilDays(civilDate, -((date.getUTCDay() + 6) % 7));
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}

function unavailableCardioLoad(detail = '尚无可用的全天心肺负荷。'): CardioLoadMetricView {
  return {
    label: '全天心肺负荷',
    dailyLoad: null,
    status: 'unavailable',
    detail,
    timeline: { state: 'no_verified_load', detail },
    observation: { observedThrough: null, qualifiedMinutes: 0, unverifiedElevatedHrMinutes: 0 },
    capacity: { status: 'unavailable', usableLoad: null, utilization: null, recoveryAdjusted: false },
    weekly: { status: 'unavailable', baseline: null, weekToDateLoad: null },
  };
}

function cardioLoadDetail(input: { daily: DailyCardioLoad | undefined; isCurrentDay: boolean }): string {
  if (!input.daily) return '尚无可用的全天心肺负荷。';
  if (input.daily.status === 'invalid_hr_reserve') return '心率储备参数无效，因此没有 TRIMP。';
  if (input.daily.status === 'timezone_ambiguous') return '时区不明确，因此无法计算当地日 TRIMP。';
  if (input.daily.status === 'insufficient_context') return '覆盖或活动上下文不足，因此不把当天显示为零负荷。';
  if (input.isCurrentDay) return '今日 TRIMP 仅累计已验证的活动与清醒时间交集。';
  return input.daily.dailyLoad === 0
    ? '完整日没有达到计入阈值的已验证活动，因此为 0.0 TRIMP。'
    : '完整日 TRIMP 基于已验证的活动、清醒时间和心率交集。';
}

function cardioLoadFromRows(input: {
  daily: DailyCardioLoad | undefined;
  capacity: Awaited<ReturnType<HealthMetricsStore['getDailyLoadCapacity']>>;
  weekly: Awaited<ReturnType<HealthMetricsStore['getWeeklyCardioBaseline']>>;
  observedThrough: string | null;
  isCurrentDay: boolean;
}): CardioLoadMetricView {
  const displayDailyLoad = input.daily?.dailyLoad === 0 && input.isCurrentDay && input.daily.qualifiedSeconds === 0
    ? null
    : input.daily?.dailyLoad ?? null;
  const detail = cardioLoadDetail({ daily: input.daily, isCurrentDay: input.isCurrentDay });
  return {
    label: '全天心肺负荷',
    dailyLoad: displayDailyLoad,
    status: input.daily?.status ?? 'unavailable',
    detail,
    timeline: buildCardioLoadTimeline({ daily: input.daily, isCurrentDay: input.isCurrentDay }),
    observation: {
      observedThrough: input.observedThrough,
      qualifiedMinutes: roundOne((input.daily?.qualifiedSeconds ?? 0) / 60),
      unverifiedElevatedHrMinutes: roundOne((input.daily?.unverifiedElevatedHrSeconds ?? 0) / 60),
    },
    capacity: {
      status: input.capacity?.status ?? 'unavailable',
      usableLoad: input.capacity?.usableLoad ?? null,
      utilization: input.capacity?.utilization ?? null,
      recoveryAdjusted: input.capacity?.recoveryTier !== null && input.capacity?.recoveryTier !== undefined && input.capacity.recoveryTier !== 'unadjusted',
    },
    weekly: {
      status: input.weekly?.status ?? 'unavailable',
      baseline: input.weekly?.baseline ?? null,
      weekToDateLoad: input.weekly?.weekToDateLoad ?? null,
    },
  };
}

function observationTime(instant: string | undefined, timeZone: string): string | null {
  if (!instant) return null;
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(instant));
  } catch {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(instant));
  }
}

const STALE_SYNC_MS = 36 * 60 * 60 * 1_000;

function scopedRecords(records: UserHealthRecords, userId: string): UserHealthRecords {
  return {
    sleepSessions: records.sleepSessions.filter((record) => record.userId === userId && record.source === 'google_health'),
    dailyHrv: records.dailyHrv.filter((record) => record.userId === userId && record.source === 'google_health'),
    dailyRhr: records.dailyRhr.filter((record) => record.userId === userId && record.source === 'google_health'),
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
  freshness: 'fresh' | 'stale';
}): TodayAction {
  const evidence = input.evidence.slice(0, 3);
  if (input.freshness === 'stale') {
    return {
      kind: 'data_state',
      text: '同步数据已超过 36 小时，请等待下一次同步或重新同步后再查看趋势。',
      evidence,
    };
  }
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

function genericBodyAgeDataGaps(): BodyAgeDataGaps {
  return { dailyVo2DaysNeeded: 7, rhrDaysNeeded: 7, observedHrPeakRequired: true };
}

function unavailableBodyAge(status: 'profile_missing' | 'data_accumulating' | 'data_updating'): BodyAgeMetricView {
  return {
    label: '身体年龄',
    age: null,
    edge: null,
    status,
    route: null,
    coverageDays: 0,
    latestInputCivilDate: null,
    lastCalculatedCivilDate: null,
    referenceVersion: BODY_AGE_REFERENCE_VERSION,
    chronologicalAgeDeltaYears: null,
    dataGaps: genericBodyAgeDataGaps(),
    disclaimer: 'non_medical_non_calibrated_estimate',
  };
}

function bodyAgeResultView(result: NonNullable<Awaited<ReturnType<HealthMetricsStore['readLatestBodyAgeResult']>>>): BodyAgeMetricView {
  const age = result.estimate.age;
  return {
    label: '身体年龄',
    age: typeof age === 'number' ? age : null,
    edge: age === 'below_reference_min' || age === 'above_reference_max' ? age : null,
    status: result.estimate.status,
    route: result.estimate.route,
    coverageDays: result.estimate.coverageDays,
    latestInputCivilDate: result.estimate.latestInputCivilDate,
    lastCalculatedCivilDate: result.lastCalculatedCivilDate,
    referenceVersion: result.estimate.referenceVersion,
    chronologicalAgeDeltaYears: typeof age === 'number' ? result.chronologicalAgeDeltaYears : null,
    dataGaps: { ...result.estimate.dataGaps },
    disclaimer: result.estimate.disclaimer,
  };
}

async function bodyAgeFromStore(input: {
  store: HealthMetricsStore;
  userId: string;
  now: Date;
  records: UserHealthRecords;
}): Promise<BodyAgeMetricView> {
  const [profile, result, timeZoneHistory] = await Promise.all([
    input.store.getBodyAgeProfile({ userId: input.userId }),
    input.store.readLatestBodyAgeResult({ userId: input.userId, algorithmVersion: BODY_AGE_ALGORITHM_VERSION }),
    input.store.listTimeZoneHistory(input.userId),
  ]);
  if (!profile?.birthDate || !profile.referenceSex) return unavailableBodyAge('profile_missing');
  if (!result) return unavailableBodyAge('data_accumulating');
  if (profile.profileRevision !== result.profileRevision) return unavailableBodyAge('data_updating');

  try {
    const fingerprintContext = bodyAgeFingerprintContext({
      timeZoneHistory,
      now: input.now,
      windowDays: BODY_AGE_WINDOW_DAYS,
    });
    const dailyVo2 = await input.store.listDailyVo2({
      userId: input.userId,
      fromCivilDate: fingerprintContext.fromCivilDate,
      toCivilDate: fingerprintContext.asOfCivilDate,
    });
    const currentFingerprint = bodyAgeInputFingerprint({
      algorithmVersion: BODY_AGE_ALGORITHM_VERSION,
      windowDays: BODY_AGE_WINDOW_DAYS,
      userId: input.userId,
      profile,
      timeZoneHistory,
      now: input.now,
      dailyVo2,
      records: input.records,
    });
    if (currentFingerprint !== result.inputFingerprint) return unavailableBodyAge('data_updating');
  } catch {
    return unavailableBodyAge('data_updating');
  }
  return bodyAgeResultView(result);
}

async function metricsFromStore(
  store: HealthMetricsStore,
  userId: string,
  localDate: string,
  now: Date,
  records: UserHealthRecords,
  timeZone: string,
): Promise<TodayView['metrics']> {
  const [strain, recovery, sleepPerformance, zones, timeInZone, dailyCardio, cardioLoad, loadCapacity, weeklyBaseline, heartRateMinutes, bodyAge] = await Promise.all([
    store.getMetricResult({ userId, civilDate: localDate, metricName: 'strain' }),
    store.getMetricResult({ userId, civilDate: localDate, metricName: 'recovery' }),
    store.getMetricResult({ userId, civilDate: localDate, metricName: 'sleep_performance' }),
    store.getHeartRateZones({ userId, civilDate: localDate }),
    store.getTimeInZone({ userId, civilDate: localDate }),
    store.getDailyCardio({ userId, civilDate: localDate }),
    store.getDailyCardioLoad({ userId, civilDate: localDate }),
    store.getDailyLoadCapacity({ userId, civilDate: localDate }),
    store.getWeeklyCardioBaseline({ userId, weekStart: mondayOf(localDate) }),
    store.listMinutesByCivilDate({ userId, civilDate: localDate }),
    bodyAgeFromStore({ store, userId, now, records }),
  ]);
  const storedRecovery = recoveryFromResult(recovery);
  const sleepHistoryIncomplete = sleepPerformance?.qualityFlags.includes('sleep_history_incomplete') === true;
  const recoveryView = sleepHistoryIncomplete && storedRecovery.score !== null
    ? {
        ...storedRecovery,
        quality: 'provisional' as const,
        detail: recoveryDetail('provisional'),
      }
    : storedRecovery;
  return {
    strain: {
      ...strainFromResult(strain),
      ...(zones ? { heartRateZones: zones.zones } : {}),
      ...(timeInZone ? { timeInZone: timeInZone.minutes } : {}),
      ...(dailyCardio ? { activityZoneMinutes: dailyCardio.zoneMinutes, dose: dailyCardio.dose } : {}),
    },
    recovery: recoveryView,
    sleepPerformance: sleepFromResult(sleepPerformance),
    cardioLoad: cardioLoadFromRows({
      daily: cardioLoad,
      capacity: loadCapacity,
      weekly: weeklyBaseline,
      observedThrough: observationTime(heartRateMinutes.at(-1)?.minuteStartUtc, timeZone),
      isCurrentDay: true,
    }),
    bodyAge,
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
    cardioLoad: unavailableCardioLoad(),
    bodyAge: unavailableBodyAge('profile_missing'),
  };
}

export async function buildTodayView(input: BuildTodayInput): Promise<TodayView> {
  const dashboardTimeZone = input.timeZone ?? (input.allowDefaultTimeZone ? DEFAULT_CIVIL_TIME_ZONE : 'UTC');
  const localDate = resolveDashboardCivilDate(
    new Date(input.now),
    dashboardTimeZone,
    input.allowDefaultTimeZone ? 'default' : 'utc',
  );
  const records = scopedRecords(
    await input.provider.listRecords(input.userId, {
      from: civilDateDaysAgo(localDate, 90),
      to: localDate,
    }),
    input.userId,
  );
  const metrics = input.healthMetrics
    ? await metricsFromStore(input.healthMetrics, input.userId, localDate, new Date(input.now), records, dashboardTimeZone)
    : await metricsFromRecords(
        records,
        input.userId,
        localDate,
        input.now,
        input.lastSuccessfulSyncAt,
      );

  const freshness = freshnessOf(input.now, input.lastSuccessfulSyncAt);
  return {
    userId: input.userId,
    generatedAt: input.now,
    localDate,
    freshness,
    primaryAction: primaryAction({
      score: metrics.recovery.score,
      quality: metrics.recovery.quality,
      evidence: metrics.recovery.evidence ?? [],
      freshness,
    }),
    metrics,
  };
}

/** Homepage-only projection. No raw health records cross this boundary. */
export async function buildHomepageTodayView(input: BuildTodayInput): Promise<HomepageTodayView> {
  const view = await buildTodayView(input);
  return toHomepageTodayView(view);
}
