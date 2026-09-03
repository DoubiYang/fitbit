import type { DailyHeartRateZones } from '../../domain/cardio-records';
import type { ZoneMinutes } from '../../domain/metric-types';
import type { StrainMetricView, TodayView } from '../../server/dashboard/build-today';
import { TimeZoneBootstrap } from '../settings/time-zone-bootstrap';
import { AppShell } from '../shell/app-shell';

import { DataState, EvidenceList } from './data-state';
import { BodyAgeCard } from './body-age-card';
import { formatMetricQuality, formatMetricScore, MetricCard } from './metric-card';

const zoneThresholdOrder: Array<[keyof DailyHeartRateZones['zones'], string]> = [
  ['LIGHT', '低'],
  ['MODERATE', '中'],
  ['VIGOROUS', '高'],
  ['PEAK', '峰值'],
];

const zoneMinuteOrder: Array<[keyof ZoneMinutes, string]> = [
  ['light', '低'],
  ['moderate', '中'],
  ['vigorous', '高'],
  ['peak', '峰值'],
];

function recordDate(view: TodayView): string {
  if (view.localDate) {
    return view.localDate;
  }
  return '日期未知';
}

function hasZoneBreakdown(strain: StrainMetricView): boolean {
  return Boolean(strain.heartRateZones || strain.timeInZone || strain.activityZoneMinutes || strain.dose != null);
}

function ZoneMinuteList({ minutes, label }: { minutes: ZoneMinutes; label: string }) {
  return (
    <ol className="evidence-list" aria-label={label}>
      {zoneMinuteOrder.map(([id, name]) => (
        <li key={id}>
          {name} <span>{minutes[id]}</span>
        </li>
      ))}
    </ol>
  );
}

function ZoneBreakdown({ strain }: { strain: StrainMetricView }) {
  if (!hasZoneBreakdown(strain)) {
    return null;
  }

  return (
    <section className="today-advice" aria-labelledby="zone-heading">
      <div className="today-advice__heading">
        <p className="section-kicker">心率区间</p>
        <h2 id="zone-heading">Google 当日阈值</h2>
      </div>
      {strain.heartRateZones ? (
        <ol className="evidence-list" aria-label="Google 心率区间">
          {zoneThresholdOrder.map(([id, name]) => {
            const zone = strain.heartRateZones![id];
            return (
              <li key={id}>
                {name} {zone.minBeatsPerMinute}–{zone.maxBeatsPerMinute}
              </li>
            );
          })}
        </ol>
      ) : null}
      {strain.timeInZone ? (
        <>
          <h3>全天区间时长</h3>
          <p className="lede">展示用，不直接计入心肺负荷。</p>
          <ZoneMinuteList minutes={strain.timeInZone} label="全天区间时长" />
        </>
      ) : null}
      {strain.activityZoneMinutes || strain.dose != null ? (
        <>
          <h3>活动归因剂量</h3>
          <p className="lede">仅计入可归因活动分钟。</p>
          {strain.activityZoneMinutes ? (
            <ZoneMinuteList minutes={strain.activityZoneMinutes} label="活动归因分钟" />
          ) : null}
          {strain.dose != null ? <p className="lede">剂量 {strain.dose}</p> : null}
        </>
      ) : null}
    </section>
  );
}

function SettingsCallouts({ view }: { view: TodayView }) {
  const missingGoal = view.metrics.sleepPerformance.detail.includes('尚未设置基础睡眠目标');
  const timezoneIssue =
    view.metrics.strain.status === 'timezone_ambiguous' || view.metrics.strain.source?.timeZone === 'missing';
  if (!missingGoal && !timezoneIssue) {
    return null;
  }

  return (
    <section className="action-card">
      {missingGoal ? (
        <p className="action-card__text">
          尚未设置基础睡眠目标，因此没有 Sleep Performance。
          {' '}
          <a href="/rhythm/settings">去设置睡眠目标</a>
        </p>
      ) : null}
      {timezoneIssue ? (
        <p className="action-card__text">
          时区不明确，完整日心肺负荷暂不可比。
          {' '}
          <a href="/rhythm/settings">查看时区设置</a>
        </p>
      ) : null}
    </section>
  );
}

export function TodayDashboard({
  view,
  variant = 'demo',
  bootstrapTimeZone,
}: {
  view: TodayView;
  variant?: 'demo' | 'oauth';
  bootstrapTimeZone?: boolean;
}) {
  const action = view.primaryAction;
  const recovery = view.metrics.recovery;
  const showBootstrap = bootstrapTimeZone ?? variant === 'oauth';

  return (
    <AppShell active="today">
      {showBootstrap ? <TimeZoneBootstrap /> : null}
      <main className="dashboard dashboard--today">
        <header className="dashboard-header">
          <p className="eyebrow">{variant === 'demo' ? '节律 · 演示' : '节律'}</p>
          <div className="dashboard-header__title-row">
            <h1>今日记录</h1>
            {variant === 'oauth' ? <a href="/rhythm/settings">设置</a> : null}
          </div>
          <p className="dashboard-sync">
            <time dateTime={view.generatedAt}>记录日期 {recordDate(view)}</time>
            <span className={view.freshness === 'fresh' ? 'freshness freshness--fresh' : 'freshness freshness--stale'}>
              {view.freshness === 'fresh' ? '数据新鲜' : '等待同步'}
            </span>
          </p>
        </header>

        <section className="recovery-status" aria-labelledby="recovery-status-heading">
          <div>
            <p className="section-kicker">恢复状态</p>
            <h2 id="recovery-status-heading">{recovery.label}</h2>
          </div>
          <p className="recovery-status__summary">
            <span className="recovery-status__score">{formatMetricScore(recovery.score)}</span>
            <span className="quality" data-quality={recovery.quality}>
              数据质量：{formatMetricQuality(recovery.quality)}
            </span>
          </p>
          <p className="recovery-status__detail">{recovery.detail}</p>
        </section>

        <section aria-labelledby="metric-heading">
          <div className="section-heading">
            <div>
              <p className="section-kicker">今日三项</p>
              <h2 id="metric-heading">可解释的指标</h2>
            </div>
            <p className="section-note">数据质量会影响参考程度</p>
          </div>
          <div className="metric-grid">
            <MetricCard metric={view.metrics.strain} />
            <MetricCard metric={recovery} />
            <MetricCard metric={view.metrics.sleepPerformance} />
          </div>
        </section>

        <ZoneBreakdown strain={view.metrics.strain} />

        <BodyAgeCard metric={view.metrics.bodyAge ?? {
          label: '身体年龄', age: null, edge: null, status: 'profile_missing', route: null,
          coverageDays: 0, latestInputCivilDate: null, lastCalculatedCivilDate: null,
          referenceVersion: 'chinese-community-cycle-vo2peak-p50-v1', chronologicalAgeDeltaYears: null,
          dataGaps: { dailyVo2DaysNeeded: 7, rhrDaysNeeded: 7, observedHrPeakRequired: true },
          disclaimer: 'non_medical_non_calibrated_estimate',
        }} />

        <section className="today-advice" aria-labelledby="today-action-heading">
          <div className="today-advice__heading">
            <p className="section-kicker">今日建议</p>
            <h2 id="today-action-heading">今天的建议</h2>
          </div>
          {action.kind === 'recommendation' ? (
            <>
              <p className="today-advice__text">{action.text}</p>
              <EvidenceList evidence={action.evidence} />
            </>
          ) : (
            <DataState text={action.text} evidence={action.evidence} />
          )}
        </section>

        {variant === 'oauth' ? <SettingsCallouts view={view} /> : null}

        <section className="dashboard-record" aria-labelledby="meal-record-heading">
          <div>
            <p className="section-kicker">行动</p>
            <h2 id="meal-record-heading">为今天留下一笔</h2>
          </div>
          <a className="dashboard-record__action" href="/rhythm/meals/new">记录餐食</a>
        </section>

        <p className="lede dashboard-context">
          {variant === 'demo'
            ? '基于演示样本生成。分数只作辅助，建议始终保留给你的主观感受。'
            : '基于你最近同步的睡眠、恢复与训练记录生成。分数只作辅助，建议始终保留给你的主观感受。'}
        </p>
      </main>
    </AppShell>
  );
}
