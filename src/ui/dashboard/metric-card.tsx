export type DashboardMetric = {
  label: string;
  score: number | null;
  quality?: string;
  status?: string;
  detail: string;
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

export function formatMetricScore(score: number | null): string {
  if (score === null) {
    return '—';
  }

  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

export function formatMetricQuality(quality: string): string {
  return qualityLabels[quality] ?? quality;
}

export function MetricCard({ metric }: { metric: DashboardMetric }) {
  const badge = metric.quality ?? metric.status;

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
      <p className="metric-card__score">{formatMetricScore(metric.score)}</p>
      <p className="metric-card__detail">{metric.detail}</p>
    </article>
  );
}
