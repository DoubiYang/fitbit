import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { HomepageTodayView } from '../../src/server/dashboard/build-today';
import { TodayDashboard } from '../../src/ui/dashboard/today-dashboard';
import {
  submitBrowserTimeZone,
  submitBrowserTimeZoneAndRefresh,
  TimeZoneBootstrap,
} from '../../src/ui/settings/time-zone-bootstrap';

const bodyAge: NonNullable<HomepageTodayView['metrics']['bodyAge']> = {
  label: '身体年龄', age: 34, edge: null, status: 'daily_vo2_provisional', route: 'daily_vo2',
  coverageDays: 8, latestInputCivilDate: '2026-08-22', lastCalculatedCivilDate: '2026-08-22',
  referenceVersion: 'chinese-community-cycle-vo2peak-p50-v1', chronologicalAgeDeltaYears: -2,
  dataGaps: { dailyVo2DaysNeeded: 0, rhrDaysNeeded: 0, observedHrPeakRequired: false },
  disclaimer: 'non_medical_non_calibrated_estimate',
};

const view: HomepageTodayView = {
  localDate: '2026-08-22',
  freshness: 'fresh',
  primaryAction: { kind: 'recommendation', text: '恢复分数相对你近期个人常态。这只说明趋势。' },
  metrics: {
    recovery: { label: '恢复', score: 66, quality: 'medium', detail: '恢复分数相对你近期个人常态，部分输入仍在校准。' },
    sleepPerformance: { label: '睡眠表现', score: 82, detail: '昨夜主睡眠相对于动态睡眠需求的完成度。' },
    cardioLoad: {
      label: '全天心肺负荷', dailyLoad: 6.4, status: 'scored', detail: '今日 TRIMP 仅累计已验证的活动与清醒时间交集。',
      timeline: { state: 'verified_load', detail: '已验证的活动负荷会随当天记录累计。' },
      observation: { observedThrough: '11:41', qualifiedMinutes: 30, unverifiedElevatedHrMinutes: 2 },
      capacity: { status: 'scored', usableLoad: 7.2, utilization: 88.9, recoveryAdjusted: true },
      weekly: { status: 'stable', baseline: 56, weekToDateLoad: 6.4 },
    },
    bodyAge,
  },
};

function render(input: Partial<HomepageTodayView> & { metrics?: HomepageTodayView['metrics'] } = {}) {
  return renderToStaticMarkup(React.createElement(TodayDashboard, {
    view: { ...view, ...input, metrics: input.metrics ?? view.metrics },
    variant: 'oauth',
  }));
}

function assertNoRawHealthData(html: string): void {
  for (const forbidden of [
    'userId', 'generatedAt', 'evidence', 'avgBpm', 'beatsPerMinute', 'sampleCount', 'minBeatsPerMinute',
    'maxBeatsPerMinute', 'inputFingerprint', 'calculationContext', 'GOCSPX', 'refresh-token', 'Bearer ',
  ]) assert.equal(html.includes(forbidden), false, forbidden);
}

test('renders the approved editorial reading flow with body age compactly inside recovery', () => {
  const html = render();

  assert.match(html, /class="editorial-home"/);
  assert.match(html, /<h1 id="today-heading">今日 <span>· 8月22日<\/span><\/h1>/);
  assert.match(html, /恢复/);
  assert.match(html, /全天心肺负荷/);
  assert.match(html, /身体年龄/);
  assert.match(html, /记录一餐/);
  assert.match(html, /<nav[^>]*aria-label="主要导航"/);
  assert.equal((html.match(/<details/g) ?? []).length, 1);
  assert.ok(html.indexOf('editorial-recovery') < html.indexOf('editorial-cardio-load'));
  assert.match(html, /class="editorial-recovery__body-age"/);
  assert.match(html, /身体年龄<strong>34 岁<\/strong>/);
  assert.doesNotMatch(html, /body-age-card--inline/);
  assert.ok(html.indexOf('editorial-action') < html.indexOf('记录一餐'));
  assert.doesNotMatch(html, /metric-grid|Google 当日阈值|全天区间时长|依据/);
  assertNoRawHealthData(html);
});

test('renders the selected editorial header with local date context and an account entry', () => {
  const html = render();

  assert.match(html, /class="editorial-home__brand-lockup"/);
  assert.match(html, /class="editorial-home__tagline">让身体回到自己的节奏<\/p>/);
  assert.match(html, /<time[^>]*class="editorial-home__date-meta"[^>]*dateTime="2026-08-22"[^>]*>2026年08月22日 · 周六<\/time>/);
  assert.match(html, /class="editorial-home__profile"[^>]*href="\/rhythm\/account"[^>]*aria-label="打开账户"/);
});

test('uses the project-owned botanical artwork in the integrated meal action', () => {
  const html = render();

  assert.equal(existsSync(new URL('../../public/images/editorial-home-botanical-v2.png', import.meta.url)), true);
  assert.match(html, /class="editorial-action__art"[^>]*src="\/rhythm\/images\/editorial-home-botanical-v2\.png"[^>]*alt=""/);
  assert.match(html, /class="editorial-action__meal"[^>]*href="\/rhythm\/meals\/new"/);
});

test('binds the editorial recovery meter to the real score and never copies reference health claims', () => {
  const html = render();
  const unavailableHtml = render({
    metrics: {
      ...view.metrics,
      recovery: { ...view.metrics.recovery, score: null, quality: 'unavailable' },
    },
  });
  const homepageCss = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');

  assert.match(html, /class="editorial-recovery__meter"[^>]*data-score-available="true"[^>]*style="--recovery-progress:66%"/);
  assert.match(unavailableHtml, /class="editorial-recovery__meter"[^>]*data-score-available="false"[^>]*style="--recovery-progress:0%"/);
  assert.match(homepageCss, /\.editorial-recovery__meter\s*\{[^}]*border-radius:\s*50%/s);
  assert.match(homepageCss, /\.editorial-action\s*\{[^}]*position:\s*relative/s);
  assert.match(html, /恢复分数相对你近期个人常态。这只说明趋势。/);
  assert.doesNotMatch(html, /心肺状态：平稳|一次轻松步行|20–30 分钟|出微汗即可|预计变化/);
});

test('frames TRIMP as a current verified load with capacity and weekly baseline', () => {
  const html = render();

  assert.match(html, /class="editorial-cardio-load__summary"/);
  assert.match(html, /6\.4\s*TRIMP/);
  assert.match(html, /今日可用负荷/);
  assert.match(html, /7\.2\s*<span>TRIMP/);
  assert.match(html, /使用率\s*88\.9%/);
  assert.match(html, /本周提升基线/);
  assert.match(html, /56\.0\s*<span>TRIMP/);
  assert.match(html, /已验证负荷/);
  assert.match(html, /观测截至 11:41 · 有效动作 30.0 分钟 · 未验证升高心率 2.0 分钟/);
  assert.doesNotMatch(html, /\/ 21|全天已观测变化|预测变化|预计变化/);
});

test('renders an unknown TRIMP state without inventing a zero or chart', () => {
  const html = render({
    metrics: {
      ...view.metrics,
      cardioLoad: {
        label: '全天心肺负荷', dailyLoad: null, status: 'insufficient_context', detail: '覆盖或活动上下文不足，因此不把当天显示为零负荷。',
        timeline: { state: 'no_verified_load', detail: '今天尚无可验证的活动负荷。' },
        observation: { observedThrough: null, qualifiedMinutes: 0, unverifiedElevatedHrMinutes: 0 },
        capacity: { status: 'unavailable', usableLoad: null, utilization: null, recoveryAdjusted: false },
        weekly: { status: 'calibrating', baseline: null, weekToDateLoad: null },
      },
      recovery: { ...view.metrics.recovery, score: null, quality: 'unavailable' },
    },
  });
  assert.match(html, /class="editorial-cardio-load__score">—/);
  assert.match(html, /覆盖或活动上下文不足，因此不把当天显示为零负荷。/);
  assert.doesNotMatch(html, /editorial-timeline/);
  assert.doesNotMatch(html, />0\.0</);
});

test('retains an exact zero only for a verified closed-day TRIMP result', () => {
  const html = render({
    metrics: {
      ...view.metrics,
      cardioLoad: {
        ...view.metrics.cardioLoad,
        dailyLoad: 0,
        detail: '完整日没有达到计入阈值的已验证活动，因此为 0.0 TRIMP。',
        timeline: { state: 'verified_load', detail: '这是完整日中已验证的活动负荷。' },
      },
    },
  });
  assert.match(html, /class="editorial-cardio-load__score">0\.0/);
  assert.match(html, /完整日没有达到计入阈值的已验证活动，因此为 0\.0 TRIMP。/);
  assert.match(html, /已验证负荷/);
  assert.doesNotMatch(html, /editorial-timeline|\/ 21/);
  assertNoRawHealthData(html);
});

test('keeps body-age data states compact and retains its explanation control', () => {
  const html = render({
    metrics: {
      ...view.metrics,
      bodyAge: { ...bodyAge, age: null, edge: null, status: 'data_accumulating', route: null, coverageDays: 0, latestInputCivilDate: null, lastCalculatedCivilDate: null, chronologicalAgeDeltaYears: null, dataGaps: { dailyVo2DaysNeeded: 3, rhrDaysNeeded: 2, observedHrPeakRequired: true } },
    },
  });
  assert.match(html, /数据待积累/);
  assert.match(html, /身体年龄<strong>数据待积累<\/strong>/);
  assert.match(html, /aria-label="了解身体年龄估算"/);
  assert.doesNotMatch(html, /偏低|低于同龄/);
});

test('keeps the compact profile CTA large enough to tap', () => {
  const html = render({
    metrics: {
      ...view.metrics,
      bodyAge: { ...bodyAge, age: null, edge: null, status: 'profile_missing', route: null, coverageDays: 0, latestInputCivilDate: null, lastCalculatedCivilDate: null, chronologicalAgeDeltaYears: null },
    },
  });
  const css = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');

  assert.match(html, /<a href="\/rhythm\/settings">完善资料<\/a>/);
  assert.match(css, /\.editorial-recovery__body-age a\s*\{[^}]*min-height:\s*2\.25rem;/s);
});

test('keeps the selected homepage as one phone canvas at every viewport width', () => {
  const homepageCss = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');
  const shellCss = readFileSync(new URL('../../src/ui/shell/app-shell.module.css', import.meta.url), 'utf8');

  assert.match(homepageCss, /\.editorial-home\s*\{[^}]*width:\s*min\(100%, 26\.625rem\);/s);
  assert.doesNotMatch(homepageCss, /grid-template-columns:\s*minmax\(0, 4fr\)\s+minmax\(0, 8fr\)/);
  assert.doesNotMatch(homepageCss, /\.body-age-card--inline\s*\{[^}]*grid-column:/s);
  assert.match(shellCss, /:global\(\.appShell__shell\)\s*\{[^}]*width:\s*min\(100%, 26\.625rem\);[^}]*margin-inline:\s*auto;/s);
  assert.match(shellCss, /:global\(\.appShell__navigation\)\s*\{(?=[^}]*width:\s*min\(100%, 26\.625rem\);)(?=[^}]*left:\s*50%;)(?=[^}]*transform:\s*translateX\(-50%\);)/s);
  assert.doesNotMatch(shellCss, /@media \(min-width: 48rem\)/);
});

test('keeps the 426px editorial hierarchy dense enough to reach the meal action without enlarging observed data', () => {
  const homepageCss = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');

  assert.match(homepageCss, /\.editorial-home__intro\s*\{[^}]*margin-top:\s*2\.7rem;/s);
  assert.match(homepageCss, /\.editorial-recovery\s*\{[^}]*padding:\s*0 0 0\.3rem;/s);
  assert.match(homepageCss, /\.editorial-timeline__plot\s*\{[^}]*height:\s*5\.25rem;/s);
  assert.match(homepageCss, /\.editorial-action__art\s*\{[^}]*bottom:\s*2\.5rem;/s);
});

test('uses the selected prototype’s compact display scale without shrinking the matched recovery ring', () => {
  const homepageCss = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');
  const html = render();
  const narrowViewportCss = homepageCss.slice(homepageCss.indexOf('@media (max-width: 22rem)'));

  assert.match(homepageCss, /\.editorial-home__profile\s*\{[^}]*width:\s*2rem;[^}]*height:\s*2rem;/s);
  assert.match(html, /class="editorial-home__profile"[^>]*><svg[^>]*width="17"[^>]*height="17"/);
  assert.match(homepageCss, /\.editorial-home__intro h1\s*\{[^}]*font-size:\s*clamp\(2\.45rem, 9vw, 2\.5rem\);[^}]*font-weight:\s*550;[^}]*letter-spacing:\s*-0\.075em;/s);
  assert.match(homepageCss, /\.editorial-home__intro h1 span\s*\{[^}]*font-size:\s*0\.68em;/s);
  assert.match(homepageCss, /\.editorial-recovery__meter\s*\{[^}]*width:\s*7rem;[^}]*margin-left:\s*1rem;/s);
  assert.match(homepageCss, /\.editorial-recovery__copy\s*\{[^}]*padding-left:\s*1\.75rem;/s);
  assert.match(homepageCss, /\.editorial-recovery__score strong\s*\{[^}]*font-size:\s*clamp\(2rem, 7\.8vw, 2\.2rem\);/s);
  assert.match(homepageCss, /\.editorial-cardio-load h2\s*\{[^}]*font-size:\s*clamp\(1\.4rem, 5\.2vw, 1\.48rem\);/s);
  assert.match(homepageCss, /\.editorial-cardio-load__score\s*\{[^}]*font-size:\s*clamp\(2\.75rem, 11\.5vw, 3\.25rem\);/s);
  assert.doesNotMatch(narrowViewportCss, /\.editorial-home__intro h1\s*\{[^}]*font-size:/s);
  assert.doesNotMatch(narrowViewportCss, /\.editorial-recovery__meter\s*\{[^}]*width:/s);
  assert.doesNotMatch(narrowViewportCss, /\.editorial-strain__score\s*\{[^}]*font-size:/s);
});

test('first authenticated load submits the browser IANA zone over the settings endpoint', async () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ ianaTimeZone: zone }), { status: 200 });
  };

  assert.equal(await submitBrowserTimeZone(fetchImpl as typeof fetch), 'submitted');
  assert.equal(calls[0]?.url, '/rhythm/api/settings/time-zone');
  assert.equal(calls[0]?.init.method, 'PUT');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { ianaTimeZone: zone });
  assert.match(renderToStaticMarkup(React.createElement(TimeZoneBootstrap)), /data-timezone-bootstrap="idle"/);
});

test('a successful browser timezone update refreshes once; a failure does not retry', async () => {
  let refreshes = 0;
  assert.equal(await submitBrowserTimeZoneAndRefresh(() => { refreshes += 1; }, async () => new Response('{}', { status: 200 })), 'submitted');
  assert.equal(await submitBrowserTimeZoneAndRefresh(() => { refreshes += 1; }, async () => new Response('{}', { status: 500 })), 'failed');
  assert.equal(refreshes, 1);
});
