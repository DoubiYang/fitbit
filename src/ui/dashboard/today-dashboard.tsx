import type { TodayView } from '../../server/dashboard/build-today';
import { AppShell } from '../shell/app-shell';

import { DataState, EvidenceList } from './data-state';
import { formatMetricQuality, formatMetricScore, MetricCard } from './metric-card';

function recordDate(view: TodayView): string {
  if (view.localDate) {
    return view.localDate;
  }
  return '日期未知';
}

export function TodayDashboard({ view, variant = 'demo' }: { view: TodayView; variant?: 'demo' | 'oauth' }) {
  const action = view.primaryAction;
  const recovery = view.metrics.recovery;

  return (
    <AppShell active="today">
      <main className="dashboard dashboard--today">
        <header className="dashboard-header">
          <p className="eyebrow">{variant === 'demo' ? '节律 · 演示' : '节律'}</p>
          <h1>今日记录</h1>
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
      </main>
    </AppShell>
  );
}
