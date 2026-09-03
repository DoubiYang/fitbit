import type { BodyAgeMetricView } from '../../server/dashboard/build-today';

import { BodyAgeInfoSheet } from './body-age-info-sheet';

export type BodyAgeCardContent = {
  value: string;
  estimateLabel: string | null;
  routeLabel: string | null;
  statusLabel: string;
  detail: string[];
  chronologicalDelta: string | null;
  settingsCta: boolean;
};

function displayAge(metric: BodyAgeMetricView): string {
  if (typeof metric.age === 'number') return `${metric.age} 岁`;
  if (metric.edge === 'below_reference_min') return '≤25 岁';
  if (metric.edge === 'above_reference_max') return '≥75 岁';
  return '—';
}

function routeLabel(route: BodyAgeMetricView['route']): string | null {
  if (route === 'daily_vo2') return 'Air 每日心肺估算';
  if (route === 'observed_peak_ratio') return 'Air 观察峰值心率比估算';
  return null;
}

function chronologicalDeltaLabel(delta: number | null, metric: BodyAgeMetricView): string | null {
  if (typeof metric.age !== 'number' || delta === null || !Number.isFinite(delta)) return null;
  if (delta === 0) return '与实际年龄相近';
  const years = Math.abs(delta);
  return delta < 0 ? `较实际年龄低 ${years} 岁` : `较实际年龄高 ${years} 岁`;
}

function accumulatingDetail(metric: BodyAgeMetricView): string[] {
  const detail: string[] = [];
  if (metric.dataGaps.dailyVo2DaysNeeded > 0) {
    detail.push(`还差 ${metric.dataGaps.dailyVo2DaysNeeded} 天 Air 心肺数据`);
  }
  if (metric.dataGaps.rhrDaysNeeded > 0) {
    detail.push(`若暂没有日心肺数据，静息心率还差 ${metric.dataGaps.rhrDaysNeeded} 天`);
  }
  if (metric.dataGaps.observedHrPeakRequired) {
    detail.push('若暂没有日心肺数据，还需要历史观察峰值');
  }
  return detail.length > 0 ? detail : ['Air 数据正在积累，暂不显示估算年龄。'];
}

/**
 * Maps the public dashboard allowlist into display copy. This deliberately
 * accepts no birthday, raw cardio value, raw heart-rate sample, or provider payload.
 */
export function bodyAgeCardContent(metric: BodyAgeMetricView): BodyAgeCardContent {
  if (metric.status === 'profile_missing') {
    return {
      value: '—', estimateLabel: null, routeLabel: null, statusLabel: '资料待补充',
      detail: ['填写出生日期和参考表选择后，才能开始这项非医疗估算。'],
      chronologicalDelta: null, settingsCta: true,
    };
  }
  if (metric.status === 'data_accumulating') {
    return {
      value: '—', estimateLabel: null, routeLabel: null, statusLabel: '数据待积累',
      detail: accumulatingDetail(metric), chronologicalDelta: null, settingsCta: false,
    };
  }
  if (metric.status === 'data_updating') {
    return {
      value: '—', estimateLabel: null, routeLabel: null, statusLabel: '数据更新中',
      detail: ['资料或 Air 数据刚更新，正在生成新的估算。'], chronologicalDelta: null, settingsCta: false,
    };
  }
  if (metric.status === 'stale') {
    return {
      value: '—', estimateLabel: null, routeLabel: null, statusLabel: '数据已过期',
      detail: [
        metric.lastCalculatedCivilDate
          ? `上次计算于 ${metric.lastCalculatedCivilDate}`
          : '上次计算日期暂不可用',
        'Air 心肺数据尚未更新，因此不展示当前年龄结论。',
      ],
      chronologicalDelta: null, settingsCta: false,
    };
  }

  const isStable = metric.status === 'daily_vo2_stable';
  return {
    value: displayAge(metric),
    estimateLabel: '估算',
    routeLabel: routeLabel(metric.route),
    statusLabel: isStable ? '稳定' : '初步',
    detail: [
      `${metric.coverageDays}/28 天`,
      metric.latestInputCivilDate ? `最新 Air 输入：${metric.latestInputCivilDate}` : '最新 Air 输入日期暂不可用',
    ],
    chronologicalDelta: chronologicalDeltaLabel(metric.chronologicalAgeDeltaYears, metric),
    settingsCta: false,
  };
}

export function BodyAgeCard({ metric }: { metric: BodyAgeMetricView }) {
  const content = bodyAgeCardContent(metric);

  return (
    <section className="body-age-card" data-status={metric.status} aria-labelledby="body-age-heading">
      <div className="body-age-card__topline">
        <div>
          <p className="section-kicker">身体状态</p>
          <h2 id="body-age-heading">{metric.label}</h2>
        </div>
        <BodyAgeInfoSheet metric={metric} />
      </div>

      <div className="body-age-card__value-row">
        <p className="body-age-card__value">{content.value}</p>
        {content.estimateLabel ? <p className="body-age-card__estimate">{content.estimateLabel}</p> : null}
      </div>
      {content.routeLabel ? <p className="body-age-card__route">{content.routeLabel}</p> : null}
      <p className="body-age-card__status">{content.statusLabel}</p>
      <div className="body-age-card__details">
        {content.detail.map((detail) => <p key={detail}>{detail}</p>)}
        {content.chronologicalDelta ? <p>{content.chronologicalDelta}</p> : null}
      </div>
      {content.settingsCta ? <a className="body-age-card__settings-link" href="/rhythm/settings">完成资料后开始估算</a> : null}
    </section>
  );
}
