import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    strain: { label: '全天心肺负荷', score: 8.4, status: 'complete', detail: '完整日心肺负荷，仅计入可归因活动分钟。' },
    sleepPerformance: { label: '睡眠表现', score: 82, detail: '昨夜主睡眠相对于动态睡眠需求的完成度。' },
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

test('renders the approved editorial reading flow with body age before the single factual action', () => {
  const html = render();

  assert.match(html, /class="editorial-home"/);
  assert.match(html, /<h1 id="today-heading">今日 <span>· 8月22日<\/span><\/h1>/);
  assert.match(html, /恢复/);
  assert.match(html, /全天心肺负荷/);
  assert.match(html, /身体年龄/);
  assert.match(html, /记录一餐/);
  assert.match(html, /<nav[^>]*aria-label="主要导航"/);
  assert.equal((html.match(/<details/g) ?? []).length, 1);
  assert.ok(html.indexOf('editorial-recovery') < html.indexOf('editorial-strain'));
  assert.ok(html.indexOf('editorial-strain') < html.indexOf('body-age-card'));
  assert.ok(html.indexOf('body-age-card') < html.indexOf('editorial-action'));
  assert.ok(html.indexOf('editorial-action') < html.indexOf('记录一餐'));
  assert.doesNotMatch(html, /metric-grid|Google 当日阈值|全天区间时长|依据/);
  assertNoRawHealthData(html);
});

test('does not invent a score or an activity timeline when no verified projection is present', () => {
  const html = render({
    metrics: {
      ...view.metrics,
      strain: { label: '全天心肺负荷', score: null, status: 'incomplete', detail: '覆盖不足，因此没有完整日 Strain。' },
      recovery: { ...view.metrics.recovery, score: null, quality: 'unavailable' },
    },
  });
  assert.match(html, /class="editorial-strain__score">—/);
  assert.match(html, /覆盖不足，因此没有完整日 Strain。/);
  assert.doesNotMatch(html, /editorial-timeline/);
  assert.doesNotMatch(html, />0\.0</);
});

test('renders an approved timeline without raw heart-rate values and retains exact zero strain', () => {
  const html = render({
    metrics: {
      ...view.metrics,
      strain: {
        ...view.metrics.strain,
        score: 0,
        timeline: {
          observedThrough: '2026-08-22T10:00:00.000Z',
          observedThroughLabel: 'UTC+8 18:00',
          buckets: [
            { start: '2026-08-22T08:00:00.000Z', end: '2026-08-22T08:15:00.000Z', label: 'UTC+8 16:00', observedHeartRateMinutes: 15, knownContextMinutes: 15, attributedMinutes: 0, intensity: 0 },
            { start: '2026-08-22T08:15:00.000Z', end: '2026-08-22T08:30:00.000Z', label: 'UTC+8 16:15', observedHeartRateMinutes: 15, knownContextMinutes: 0, attributedMinutes: 0, intensity: null },
            { start: '2026-08-22T08:30:00.000Z', end: '2026-08-22T08:45:00.000Z', label: 'UTC+8 16:30', observedHeartRateMinutes: 0, knownContextMinutes: 0, attributedMinutes: 0, intensity: null },
            { start: '2026-08-22T08:45:00.000Z', end: '2026-08-22T09:00:00.000Z', label: 'UTC+8 16:45', observedHeartRateMinutes: 15, knownContextMinutes: 15, attributedMinutes: 15, intensity: 0 },
            { start: '2026-08-22T09:00:00.000Z', end: '2026-08-22T09:15:00.000Z', label: 'UTC+8 17:00', observedHeartRateMinutes: 15, knownContextMinutes: 10, attributedMinutes: 15, intensity: 2 },
          ],
        } as HomepageTodayView['metrics']['strain']['timeline'],
      },
    },
  });
  assert.match(html, /class="editorial-strain__score">0\.0/);
  assert.match(html, /class="editorial-timeline"/);
  assert.match(html, /UTC\+8 16:00：未归因/);
  assert.match(html, /UTC\+8 16:15：上下文未知/);
  assert.match(html, /UTC\+8 16:30：未观测/);
  assert.match(html, /UTC\+8 16:45：低强度/);
  assert.match(html, /UTC\+8 17:00：运动归因 · 中等强度（活动上下文未知）/);
  assert.match(html, /观测截至 UTC\+8 18:00；后续暂无数据。/);
  assert.match(html, /<p class="editorial-timeline__caption"><span class="editorial-timeline__start">UTC\+8 16:00<\/span><span class="editorial-timeline__center">日内观测<\/span><span class="editorial-timeline__end">UTC\+8 17:00<\/span><\/p>/);
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
  assert.match(html, /还差 3 天 Air 心肺数据/);
  assert.match(html, /aria-label="了解身体年龄估算"/);
  assert.doesNotMatch(html, /偏低|低于同龄/);
});

test('keeps the inline profile CTA large enough to tap', () => {
  const html = render({
    metrics: {
      ...view.metrics,
      bodyAge: { ...bodyAge, age: null, edge: null, status: 'profile_missing', route: null, coverageDays: 0, latestInputCivilDate: null, lastCalculatedCivilDate: null, chronologicalAgeDeltaYears: null },
    },
  });
  const css = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');

  assert.match(html, /class="body-age-card__settings-link"/);
  assert.match(css, /\.body-age-card--inline \.body-age-card__settings-link\s*\{[^}]*min-height:\s*2\.75rem;[^}]*padding:/s);
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
