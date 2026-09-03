import { Leaf, Settings2, Utensils } from 'lucide-react';

import type { HomepageTodayView } from '../../server/dashboard/build-today';

import { BodyAgeCard } from './body-age-card';
import { StrainTimeline } from './strain-timeline';

function dateLabel(civilDate: string): string {
  const match = civilDate.match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (!match) return '今天';
  return `${Number(match[1])}月${Number(match[2])}日`;
}

function recoveryState(quality: HomepageTodayView['metrics']['recovery']['quality']): string {
  if (quality === 'high') return '状态良好';
  if (quality === 'medium') return '恢复中';
  if (quality === 'provisional') return '正在校准';
  return '等待数据';
}

function recoveryQuality(quality: HomepageTodayView['metrics']['recovery']['quality']): string {
  const labels = { high: '高', medium: '中等', provisional: '临时', unavailable: '不可用' } as const;
  return labels[quality];
}

function strainQuality(status: HomepageTodayView['metrics']['strain']['status']): string {
  const labels = {
    complete: '完整', provisional: '临时', incomplete: '覆盖不足', timezone_ambiguous: '时区不明', unavailable: '不可用',
  } as const;
  return labels[status];
}

function score(value: number | null, digits = 0): string {
  return value === null ? '—' : value.toFixed(digits);
}

const unavailableBodyAge: NonNullable<HomepageTodayView['metrics']['bodyAge']> = {
  label: '身体年龄', age: null, edge: null, status: 'profile_missing', route: null,
  coverageDays: 0, latestInputCivilDate: null, lastCalculatedCivilDate: null,
  referenceVersion: 'chinese-community-cycle-vo2peak-p50-v1', chronologicalAgeDeltaYears: null,
  dataGaps: { dailyVo2DaysNeeded: 7, rhrDaysNeeded: 7, observedHrPeakRequired: true },
  disclaimer: 'non_medical_non_calibrated_estimate',
};

export function EditorialHomepage({
  view,
  variant,
}: {
  view: HomepageTodayView;
  variant: 'demo' | 'oauth';
}) {
  const recovery = view.metrics.recovery;
  const strain = view.metrics.strain;

  return (
    <main className="editorial-home">
      <header className="editorial-home__header">
        <p className="editorial-home__brand"><Leaf aria-hidden="true" size={22} strokeWidth={2.2} />节律</p>
        {variant === 'oauth' ? (
          <a className="editorial-home__settings" href="/rhythm/settings" aria-label="打开设置">
            <Settings2 aria-hidden="true" size={21} strokeWidth={1.9} />
          </a>
        ) : <span className="editorial-home__demo">演示</span>}
      </header>

      <section className="editorial-home__intro" aria-labelledby="today-heading">
        <h1 id="today-heading">今日 <span>· {dateLabel(view.localDate)}</span></h1>
      </section>

      <details className="editorial-quality">
        <summary>
          <span>数据质量会影响参考程度</span>
          <span className={`editorial-quality__state editorial-quality__state--${view.freshness}`}>
            {view.freshness === 'fresh' ? '已同步' : '等待同步'}
          </span>
        </summary>
        <p>恢复：{recovery.detail}</p>
        <p>睡眠表现：{view.metrics.sleepPerformance.detail}</p>
        <p>负荷：{strain.detail}</p>
        <p>仅展示已验证的汇总指标；原始测量不会进入本页。</p>
        {view.metrics.sleepPerformance.detail.includes('尚未设置基础睡眠目标') ? (
          <a href="/rhythm/settings">前往设置睡眠目标</a>
        ) : null}
      </details>

      <section className="editorial-recovery" aria-labelledby="recovery-heading">
        <div className="editorial-recovery__score" aria-label={`${recovery.label} ${score(recovery.score)}`}>
          <strong>{score(recovery.score)}</strong>
          <span>/ 100</span>
        </div>
        <div className="editorial-recovery__copy">
          <p className="editorial-kicker">今日恢复</p>
          <h2 id="recovery-heading">{recoveryState(recovery.quality)}</h2>
          <p>{recovery.detail}</p>
          <small>数据质量：{recoveryQuality(recovery.quality)}</small>
        </div>
      </section>

      <section className="editorial-strain" aria-labelledby="strain-heading">
        <div className="editorial-strain__heading">
          <div>
            <p className="editorial-kicker">全天心肺负荷</p>
            <h2 id="strain-heading">今天的身体投入</h2>
          </div>
          <p className="editorial-strain__quality">{strainQuality(strain.status)}</p>
        </div>
        <p className="editorial-strain__value">
          <span className="editorial-strain__score">{score(strain.score, 1)}</span>
          <span>/ 21</span>
        </p>
        {strain.timeline ? <StrainTimeline timeline={strain.timeline} /> : <p className="editorial-strain__detail">{strain.detail}</p>}
      </section>

      <BodyAgeCard metric={view.metrics.bodyAge ?? unavailableBodyAge} variant="inline" />

      <section className="editorial-action" aria-labelledby="action-heading">
        <p className="editorial-kicker">今天的提示</p>
        <h2 id="action-heading">{view.primaryAction.text}</h2>
      </section>

      <a className="editorial-meal-cta" href="/rhythm/meals/new">
        <Utensils aria-hidden="true" size={20} strokeWidth={2} />
        记录一餐
      </a>
    </main>
  );
}
