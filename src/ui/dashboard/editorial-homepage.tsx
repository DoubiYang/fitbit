import { HeartPulse, Info, Sprout, UserRound, Utensils } from 'lucide-react';
import type { CSSProperties } from 'react';

import type { HomepageTodayView } from '../../server/dashboard/build-today';

import { BodyAgeInfoSheet } from './body-age-info-sheet';
import { bodyAgeCardContent } from './body-age-card';

function dateLabel(civilDate: string): string {
  const match = civilDate.match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (!match) return '今天';
  return `${Number(match[1])}月${Number(match[2])}日`;
}

function dateMetaLabel(civilDate: string): string {
  const match = civilDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '日期待确认';
  const dayOfWeek = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][
    new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()
  ];
  return `${match[1]}年${match[2]}月${match[3]}日 · ${dayOfWeek}`;
}

function dataQualityLabel(view: HomepageTodayView): string {
  if (view.freshness !== 'fresh') return '待同步';
  if (view.metrics.recovery.quality === 'provisional' || view.metrics.recovery.quality === 'unavailable') return '临时数据';
  if (view.metrics.cardioLoad.status !== 'scored') return '临时数据';
  return '已同步';
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

function recoverySummary(recovery: HomepageTodayView['metrics']['recovery']): string {
  if (recovery.quality === 'provisional') return '数据仍在积累，分数会继续校准。';
  return recovery.detail;
}

function compactBodyAgeValue(bodyAge: ReturnType<typeof bodyAgeCardContent>): string {
  if (bodyAge.value !== '—') return bodyAge.value;
  return bodyAge.statusLabel === '资料待补充' ? '待补充' : bodyAge.statusLabel;
}

function score(value: number | null, digits = 0): string {
  return value === null ? '—' : value.toFixed(digits);
}

function observationSummary(observation: HomepageTodayView['metrics']['cardioLoad']['observation']): string {
  if (observation.observedThrough === null) return '暂无心率观测；未知数据不会记为零负荷。';
  return `观测截至 ${observation.observedThrough} · 有效动作 ${observation.qualifiedMinutes.toFixed(1)} 分钟 · 未验证升高心率 ${observation.unverifiedElevatedHrMinutes.toFixed(1)} 分钟`;
}

function cardioLoadState(state: HomepageTodayView['metrics']['cardioLoad']['timeline']['state']): string {
  const labels = {
    verified_load: '已验证负荷',
    unverified_elevated_hr: '未验证升高心率',
    no_verified_load: '暂无可验证负荷',
  } as const;
  return labels[state];
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
  const cardioLoad = view.metrics.cardioLoad;
  const bodyAgeMetric = view.metrics.bodyAge ?? unavailableBodyAge;
  const bodyAge = bodyAgeCardContent(bodyAgeMetric);
  const qualityLabel = dataQualityLabel(view);
  const recoveryProgress = recovery.score === null ? 0 : Math.min(100, Math.max(0, recovery.score));
  const recoveryDetail = recoverySummary(recovery);

  return (
    <main className="editorial-home">
      <header className="editorial-home__header">
        <div className="editorial-home__brand-lockup">
          <p className="editorial-home__brand"><Sprout aria-hidden="true" size={22} strokeWidth={2.2} />节律</p>
          <p className="editorial-home__tagline">让身体回到自己的节奏</p>
        </div>
        {variant === 'oauth' ? (
          <a className="editorial-home__profile" href="/rhythm/account" aria-label="打开账户">
            <UserRound aria-hidden="true" size={17} strokeWidth={1.7} />
          </a>
        ) : <span className="editorial-home__profile editorial-home__profile--demo" aria-label="演示账户"><UserRound aria-hidden="true" size={17} strokeWidth={1.7} /></span>}
      </header>

      <section className="editorial-home__intro" aria-labelledby="today-heading">
        <h1 id="today-heading">今日 <span>· {dateLabel(view.localDate)}</span></h1>
        <div className="editorial-home__date-row">
          <time className="editorial-home__date-meta" dateTime={view.localDate}>{dateMetaLabel(view.localDate)}</time>
          <details className="editorial-quality">
            <summary className="editorial-quality__summary">
              <span className={`editorial-quality__state editorial-quality__state--${view.freshness}`}>
                {qualityLabel}
              </span>
              <Info aria-hidden="true" size={15} strokeWidth={1.8} />
            </summary>
            <div className="editorial-quality__content">
              <p>恢复：{recovery.detail}</p>
              <p>睡眠表现：{view.metrics.sleepPerformance.detail}</p>
              <p>负荷：{cardioLoad.detail}</p>
              <p>仅展示已验证的汇总指标；原始测量不会进入本页。</p>
              {view.metrics.sleepPerformance.detail.includes('尚未设置基础睡眠目标') ? (
                <a href="/rhythm/settings">前往设置睡眠目标</a>
              ) : null}
            </div>
          </details>
        </div>
      </section>

      <section className="editorial-recovery" aria-labelledby="recovery-heading">
        <div
          className="editorial-recovery__meter"
          data-score-available={recovery.score !== null}
          role="meter"
          aria-label={recovery.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={recovery.score ?? undefined}
          style={{ '--recovery-progress': `${recoveryProgress}%` } as CSSProperties}
        >
          <div className="editorial-recovery__score" aria-hidden="true">
            <span className="editorial-recovery__score-label">恢复评分</span>
            <strong>{score(recovery.score)}</strong>
            <span>{recoveryQuality(recovery.quality)}</span>
          </div>
        </div>
        <div className="editorial-recovery__copy">
          <p className="editorial-kicker">今日恢复</p>
          <h2 id="recovery-heading">{recoveryState(recovery.quality)}</h2>
          <p>{recoveryDetail}</p>
          <div className="editorial-recovery__body-age">
            <HeartPulse aria-hidden="true" size={18} strokeWidth={1.7} />
            <span>身体年龄<strong>{compactBodyAgeValue(bodyAge)}</strong></span>
            <BodyAgeInfoSheet metric={bodyAgeMetric} />
            {bodyAge.settingsCta ? <a href="/rhythm/settings">完善资料</a> : null}
          </div>
        </div>
      </section>

      <section className="editorial-cardio-load" aria-labelledby="cardio-load-heading">
        <div className="editorial-cardio-load__summary">
          <div className="editorial-cardio-load__heading">
            <p className="editorial-kicker">全天心肺负荷</p>
            <h2 id="cardio-load-heading">全天心肺负荷</h2>
            <p className="editorial-cardio-load__subtitle">仅累计已验证的活动与清醒时间交集</p>
          </div>
          <div className="editorial-cardio-load__value-block">
            <p className="editorial-cardio-load__value">
              <span className="editorial-cardio-load__score">{score(cardioLoad.dailyLoad, 1)}</span>
              <span>TRIMP</span>
            </p>
            <span className="editorial-cardio-load__current-label">当前负荷</span>
          </div>
        </div>
        <div className="editorial-cardio-load__state">
          <span className={`editorial-cardio-load__state-dot editorial-cardio-load__state-dot--${cardioLoad.timeline.state}`} aria-hidden="true" />
          <strong>{cardioLoadState(cardioLoad.timeline.state)}</strong>
          <p>{cardioLoad.timeline.detail}</p>
        </div>
        <p className="editorial-cardio-load__detail">{cardioLoad.detail}</p>
        <p className="editorial-cardio-load__observation">{observationSummary(cardioLoad.observation)}</p>
        <div className="editorial-cardio-load__grid">
          <section className="editorial-cardio-load__mini" aria-label="今日可用负荷">
            <p>今日可用负荷</p>
            <strong>{score(cardioLoad.capacity.usableLoad, 1)} <span>TRIMP</span></strong>
            <small>{cardioLoad.capacity.status === 'scored'
              ? `${cardioLoad.capacity.recoveryAdjusted ? '已纳入恢复状态 · ' : ''}使用率 ${score(cardioLoad.capacity.utilization, 1)}%`
              : '恢复或历史数据仍在校准'}</small>
          </section>
          <section className="editorial-cardio-load__mini" aria-label="本周提升基线">
            <p>本周提升基线</p>
            <strong>{score(cardioLoad.weekly.baseline, 1)} <span>TRIMP</span></strong>
            <small>{cardioLoad.weekly.status === 'frozen'
              ? '本周数据不完整；保持上次稳定基线'
              : cardioLoad.weekly.weekToDateLoad === null
                ? '完整周数据仍在积累'
                : `本周已累计 ${score(cardioLoad.weekly.weekToDateLoad, 1)} TRIMP`}</small>
          </section>
        </div>
      </section>

      <section className="editorial-action" aria-labelledby="action-heading">
        <div className="editorial-action__content">
          <p className="editorial-kicker">今天的提示</p>
          <h2 id="action-heading">{view.primaryAction.text}</h2>
          <a className="editorial-action__meal" href="/rhythm/meals/new">
            <Utensils aria-hidden="true" size={20} strokeWidth={2} />
            记录一餐
          </a>
        </div>
        <img className="editorial-action__art" src="/rhythm/images/editorial-home-botanical-v2.png" alt="" />
      </section>
    </main>
  );
}
