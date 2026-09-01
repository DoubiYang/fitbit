import type { MetricCoverageState, MetricSourceState } from '../../domain/metric-types';

export type DashboardMetric = {
  label: string;
  score: number | null;
  quality?: string;
  status?: string;
  detail: string;
  coverage?: MetricCoverageState;
  source?: MetricSourceState;
};

const qualityLabels: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
  calibrating: '校准中',
  unavailable: '不可用',
  provisional: '临时',
  complete: '完整',
  incomplete: '不完整',
  timezone_ambiguous: '时区不明',
};

const sourceLabels: Array<[Exclude<keyof MetricSourceState, 'timeZone'>, string]> = [
  ['heartRateZones', '心率区间'],
  ['activityLevel', '活动水平'],
  ['exercise', '锻炼'],
  ['sleep', '睡眠'],
  ['hrv', 'HRV'],
  ['rhr', '静息心率'],
  ['sleepGoal', '睡眠目标'],
];

export function formatMetricScore(score: number | null, options?: { alwaysOneDecimal?: boolean }): string {
  if (score === null) {
    return '—';
  }

  if (options?.alwaysOneDecimal) {
    return score.toFixed(1);
  }

  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

export function formatMetricQuality(quality: string): string {
  return qualityLabels[quality] ?? quality;
}

function coverageDisclosure(coverage: MetricCoverageState): string {
  return `覆盖：已知上下文 ${coverage.knownContextMinutes} 分钟，活动归因 ${coverage.attributedMinutes} 分钟`;
}

function sourceDisclosure(source: MetricSourceState): string {
  const parts = sourceLabels.filter(([key]) => source[key]).map(([, label]) => label);
  if (source.timeZone === 'unambiguous') {
    parts.push('时区明确');
  } else if (source.timeZone === 'ambiguous') {
    parts.push('时区不明');
  } else if (source.timeZone === 'missing') {
    parts.push('缺少时区');
  }
  return parts.length > 0 ? `来源：${parts.join('、')}` : '';
}

export function MetricCard({ metric }: { metric: DashboardMetric }) {
  const badge = metric.quality ?? metric.status;
  const alwaysOneDecimal = metric.status !== undefined && metric.score !== null;
  const coverage = metric.coverage ? coverageDisclosure(metric.coverage) : '';
  const source = metric.source ? sourceDisclosure(metric.source) : '';

  return (
    <article className="metric-card">
      <div className="metric-card__topline">
        <h3>{metric.label}</h3>
        {badge ? (
          <span className="quality" data-quality={badge}>
            数据质量：{formatMetricQuality(badge)}
          </span>
        ) : null}
      </div>
      <p className="metric-card__score">{formatMetricScore(metric.score, { alwaysOneDecimal })}</p>
      <p className="metric-card__detail">{metric.detail}</p>
      {coverage ? <p className="metric-card__detail">{coverage}</p> : null}
      {source ? <p className="metric-card__detail">{source}</p> : null}
    </article>
  );
}
