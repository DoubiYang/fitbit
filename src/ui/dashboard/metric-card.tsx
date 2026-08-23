import type { MetricQuality } from '../../domain/metric-types';

export type DashboardMetric = {
  label: string;
  score: number | null;
  quality: MetricQuality;
  detail: string;
};

const qualityLabels: Record<MetricQuality, string> = {
  high: '高',
  medium: '中',
  low: '低',
  calibrating: '校准中',
};

function formatScore(score: number | null): string {
  if (score === null) {
    return '—';
  }

  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

export function MetricCard({ metric }: { metric: DashboardMetric }) {
  return (
    <article className="metric-card">
      <div className="metric-card__topline">
        <h3>{metric.label}</h3>
        <span className="quality" data-quality={metric.quality}>
          数据质量：{qualityLabels[metric.quality]}
        </span>
      </div>
      <p className="metric-card__score">{formatScore(metric.score)}</p>
      <p className="metric-card__detail">{metric.detail}</p>
    </article>
  );
}
