import type { TodayView } from '../../server/dashboard/build-today';

import { DataState, EvidenceList } from './data-state';
import { MetricCard } from './metric-card';

export function TodayDashboard({ view, variant = 'demo' }: { view: TodayView; variant?: 'demo' | 'oauth' }) {
  const action = view.primaryAction;

  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <p className="eyebrow">{variant === 'demo' ? '节律 · 演示' : '节律'}</p>
        <div className="dashboard-header__title-row">
          <h1>今日节律</h1>
          <p className={view.freshness === 'fresh' ? 'freshness freshness--fresh' : 'freshness freshness--stale'}>
            {view.freshness === 'fresh' ? '数据新鲜' : '等待同步'}
          </p>
        </div>
        <p className="lede">
          {variant === 'demo'
            ? '基于演示样本生成。分数只作辅助，建议始终保留给你的主观感受。'
            : '基于你最近同步的睡眠、恢复与训练记录生成。分数只作辅助，建议始终保留给你的主观感受。'}
        </p>
        <p>
          <a href="/rhythm/account">账户</a>
        </p>
        <p>
          <a href="/rhythm/meals/new">记录餐食</a>
        </p>
      </header>

      <section className="action-card" aria-labelledby="today-action-heading">
        <p className="section-kicker">优先事项</p>
        <h2 id="today-action-heading">今天的建议</h2>
        {action.kind === 'recommendation' ? (
          <>
            <p className="action-card__text">{action.text}</p>
            <EvidenceList evidence={action.evidence} />
          </>
        ) : (
          <DataState text={action.text} evidence={action.evidence} />
        )}
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
          <MetricCard metric={view.metrics.recovery} />
          <MetricCard metric={view.metrics.sleep} />
          <MetricCard metric={view.metrics.training} />
        </div>
      </section>
    </main>
  );
}
