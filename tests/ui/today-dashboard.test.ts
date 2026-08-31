import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { TodayView } from '../../src/server/dashboard/build-today';
import { TodayDashboard } from '../../src/ui/dashboard/today-dashboard';
import { submitBrowserTimeZone, TimeZoneBootstrap } from '../../src/ui/settings/time-zone-bootstrap';

const coverage = {
  knownContextMinutes: 600,
  rawHeartRateMinutes: 610,
  attributedMinutes: 24,
  lastKnownContextAt: '2026-08-22T15:40:00.000Z',
};

const source = {
  heartRateZones: true,
  activityLevel: true,
  exercise: false,
  sleep: true,
  hrv: true,
  rhr: true,
  sleepGoal: true,
  timeZone: 'unambiguous' as const,
};

const view: TodayView = {
  userId: 'demo_user',
  generatedAt: '2026-08-22T08:00:00.000Z',
  localDate: '2026-08-22',
  freshness: 'fresh',
  primaryAction: {
    kind: 'recommendation',
    text: '恢复分数相对你近期个人常态。这只说明趋势。',
    evidence: [
      { label: 'HRV', date: '2026-08-22', value: 51 },
      { label: 'Sleep Performance', date: '2026-08-22', value: 82 },
    ],
  },
  metrics: {
    recovery: { label: '恢复', score: 66, quality: 'medium', detail: '存在部分缺失或临时基线。' },
    strain: { label: '全天心肺负荷', score: 8.4, status: 'complete', detail: '完整日心肺负荷。' },
    sleepPerformance: { label: '睡眠表现', score: 82, detail: '昨夜主睡眠相对于动态睡眠需求的完成度。' },
  },
};

function render(input: Partial<TodayView> & { metrics?: TodayView['metrics'] } = {}, variant?: 'demo' | 'oauth') {
  return renderToStaticMarkup(
    React.createElement(TodayDashboard, {
      view: { ...view, ...input, metrics: input.metrics ?? view.metrics },
      variant,
    }),
  );
}

function assertSageDashboard(html: string) {
  assert.match(html, /class="dashboard dashboard--today"/);
  assert.match(html, /class="metric-card"/);
  assert.match(html, /class="quality"/);
  assert.match(html, /appShell__/);
  assert.match(html, /section-kicker/);
}

function assertNoTrainingPermission(html: string) {
  assert.doesNotMatch(html, /可按原计划/);
  assert.doesNotMatch(html, /可以训练/);
  assert.doesNotMatch(html, /训练许可/);
  assert.doesNotMatch(html, /安全加练/);
  assert.doesNotMatch(html, /can train/i);
  assert.doesNotMatch(html, /train as planned/i);
}

function assertNoRawSecrets(html: string) {
  assert.doesNotMatch(html, /GOCSPX/);
  assert.doesNotMatch(html, /refresh-token/);
  assert.doesNotMatch(html, /Bearer /);
  assert.doesNotMatch(html, /avgBpm/);
  assert.doesNotMatch(html, /sampleCount/);
  assert.doesNotMatch(html, /beatsPerMinute":/);
}

test('renders an action-first health journal inside the primary navigation', () => {
  const html = renderToStaticMarkup(React.createElement(TodayDashboard, { view }));

  assert.match(html, /<nav[^>]*aria-label="主要导航"/);
  assert.match(html, /今日记录/);
  assert.match(html, /记录餐食/);
  assert.match(html, /<a[^>]*href="\/rhythm\/meals\/new"[^>]*>记录餐食<\/a>/);
  assert.match(html, /今天的建议/);
  assert.match(html, /这只说明趋势/);
  assert.match(html, /HRV · 2026-08-22：51/);
  assert.match(html, /恢复/);
  assert.match(html, /睡眠表现/);
  assert.match(html, /全天心肺负荷/);
  assert.doesNotMatch(html, /训练负荷/);
  assert.match(html, /数据质量：中/);
  assert.match(html, /数据新鲜/);
  assert.equal((html.match(/<main\b/g) ?? []).length, 1);
});

test('renders missing metric scores as a dash without inventing a numeric value', () => {
  const html = renderToStaticMarkup(
    React.createElement(TodayDashboard, {
      view: {
        ...view,
        metrics: {
          ...view.metrics,
          recovery: { ...view.metrics.recovery, score: null },
          strain: { ...view.metrics.strain, score: null },
          sleepPerformance: { ...view.metrics.sleepPerformance, score: null },
        },
      },
    }),
  );

  assert.equal((html.match(/<p class="metric-card__score">—<\/p>/g) ?? []).length, 3);
  assert.doesNotMatch(html, /<p class="metric-card__score">\d/);
});

test('distinguishes demo context from an OAuth-backed view', () => {
  const demoHtml = renderToStaticMarkup(React.createElement(TodayDashboard, { view, variant: 'demo' }));
  const oauthHtml = renderToStaticMarkup(React.createElement(TodayDashboard, { view, variant: 'oauth' }));

  assert.match(demoHtml, /节律 · 演示/);
  assert.doesNotMatch(oauthHtml, /节律 · 演示/);
});

test('renders the record date from the view local date while preserving the ISO timestamp', () => {
  const generatedAt = '2026-08-22T16:30:00.000Z';
  const html = renderToStaticMarkup(
    React.createElement(TodayDashboard, { view: { ...view, generatedAt, localDate: '2026-08-23' } }),
  );

  assert.match(html, /<time dateTime="2026-08-22T16:30:00.000Z">记录日期 2026-08-23<\/time>/);
});

test('does not throw when a manually constructed view has an invalid timestamp', () => {
  assert.doesNotThrow(() => renderToStaticMarkup(
    React.createElement(TodayDashboard, { view: { ...view, generatedAt: 'not-an-iso-timestamp' } }),
  ));
});

test('renders complete rest-day strain as 0.0 rather than an unavailable dash', () => {
  const html = render({
    metrics: {
      ...view.metrics,
      strain: { label: '全天心肺负荷', score: 0, status: 'complete', detail: '完整日心肺负荷，仅计入可归因活动分钟。' },
    },
  });

  assert.match(html, /全天心肺负荷/);
  assert.match(html, /<p class="metric-card__score">0\.0<\/p>/);
  assert.doesNotMatch(html, /<p class="metric-card__score">0<\/p>/);
  assert.doesNotMatch(html, /<p class="metric-card__score">—<\/p>/);
  assert.match(html, /数据质量：完整/);
  assertSageDashboard(html);
  assertNoTrainingPermission(html);
});

test('renders unavailable strain as a dash and not 0.0', () => {
  const html = render({
    metrics: {
      ...view.metrics,
      strain: { label: '全天心肺负荷', score: null, status: 'unavailable', detail: '缺少心率区间、活动上下文或同步结果，因此没有 Strain 分数。' },
    },
  });

  assert.match(html, /全天心肺负荷[\s\S]*?<p class="metric-card__score">—<\/p>/);
  assert.doesNotMatch(html, /<p class="metric-card__score">0\.0<\/p>/);
  assert.doesNotMatch(html, /<p class="metric-card__score">0<\/p>/);
  assert.match(html, /数据质量：不可用/);
});

test('labels provisional strain so it is not compared with a complete day', () => {
  const html = render({
    metrics: {
      ...view.metrics,
      strain: {
        label: '全天心肺负荷',
        score: 4.2,
        status: 'provisional',
        detail: '临时心肺负荷，不可与完整日直接比较。',
      },
    },
  });

  assert.match(html, /<p class="metric-card__score">4\.2<\/p>/);
  assert.match(html, /data-quality="provisional"/);
  assert.match(html, /数据质量：临时/);
  assert.match(html, /不可与完整日直接比较/);
  assert.doesNotMatch(html, /可以训练/);
});

test('discloses coverage and sources without dumping raw heart-rate samples', () => {
  const html = render({
    metrics: {
      ...view.metrics,
      strain: {
        label: '全天心肺负荷',
        score: 8.4,
        status: 'complete',
        detail: '完整日心肺负荷，仅计入可归因活动分钟。',
        coverage,
        source,
      },
    },
  });

  assert.match(html, /已知上下文/);
  assert.match(html, /600/);
  assert.match(html, /活动归因/);
  assert.match(html, /24/);
  assert.match(html, /来源/);
  assert.match(html, /心率区间/);
  assert.match(html, /活动水平/);
  assertNoRawSecrets(html);
});

test('renders timezone_ambiguous strain with a settings CTA', () => {
  const html = render({
    metrics: {
      ...view.metrics,
      strain: {
        label: '全天心肺负荷',
        score: null,
        status: 'timezone_ambiguous',
        detail: '时区不明确，当地日无法作为完整日。',
        source: { ...source, timeZone: 'ambiguous' },
      },
    },
  }, 'oauth');

  assert.match(html, /数据质量：时区不明/);
  assert.match(html, /data-quality="timezone_ambiguous"/);
  assert.match(html, /href="\/rhythm\/settings"/);
  assert.match(html, /时区/);
  assertSageDashboard(html);
});

test('explains sleep performance against the dynamic target and links a missing goal', () => {
  const complete = render();
  assert.match(complete, /昨夜主睡眠相对于动态睡眠需求的完成度/);
  assert.doesNotMatch(complete, /480 分钟目标/);

  const missing = render({
    metrics: {
      ...view.metrics,
      sleepPerformance: {
        label: '睡眠表现',
        score: null,
        detail: '尚未设置基础睡眠目标，因此没有 Sleep Performance。',
      },
    },
  }, 'oauth');

  assert.match(missing, /尚未设置基础睡眠目标/);
  assert.match(missing, /<a[^>]*href="\/rhythm\/settings"[^>]*>[^<]*睡眠目标/);
  assert.doesNotMatch(missing, /可以训练/);
  assertSageDashboard(missing);
});

test('shows Google zone thresholds separately from all-day zone time and activity dose', () => {
  const html = render({
    metrics: {
      ...view.metrics,
      strain: {
        label: '全天心肺负荷',
        score: 8.4,
        status: 'complete',
        detail: '完整日心肺负荷，仅计入可归因活动分钟。',
        heartRateZones: {
          LIGHT: { minBeatsPerMinute: 97, maxBeatsPerMinute: 116 },
          MODERATE: { minBeatsPerMinute: 117, maxBeatsPerMinute: 136 },
          VIGOROUS: { minBeatsPerMinute: 137, maxBeatsPerMinute: 155 },
          PEAK: { minBeatsPerMinute: 156, maxBeatsPerMinute: 200 },
        },
        timeInZone: { light: 400, moderate: 20, vigorous: 5, peak: 1 },
        activityZoneMinutes: { light: 10, moderate: 8, vigorous: 4, peak: 2 },
        dose: 18.5,
      },
    },
  });

  assert.match(html, /Google/);
  assert.match(html, /97/);
  assert.match(html, /116/);
  assert.match(html, /156/);
  assert.match(html, /全天区间时长/);
  assert.match(html, /400/);
  assert.match(html, /活动归因/);
  assert.match(html, />10</);
  assert.match(html, /18\.5/);
  assert.doesNotMatch(html, /avgBpm/);
});

test('does not invent zone thresholds or zone time when the view omits them', () => {
  const html = render();
  assert.doesNotMatch(html, /minBeatsPerMinute/);
  assert.doesNotMatch(html, /全天区间时长/);
  assert.doesNotMatch(html, /97–116/);
});

test('oauth dashboard mounts time-zone bootstrap; demo and unauthenticated views do not', () => {
  const oauthHtml = render({}, 'oauth');
  const demoHtml = render({}, 'demo');
  const bootstrapHtml = renderToStaticMarkup(React.createElement(TimeZoneBootstrap));

  assert.match(oauthHtml, /data-timezone-bootstrap/);
  assert.match(oauthHtml, /href="\/rhythm\/settings"/);
  assert.doesNotMatch(demoHtml, /data-timezone-bootstrap/);
  assert.match(bootstrapHtml, /data-timezone-bootstrap="idle"/);
  assertSageDashboard(oauthHtml);
});

test('first authenticated load submits the browser IANA zone over the settings endpoint', async () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ ianaTimeZone: zone, effectiveAt: '2026-08-01T00:00:00.000Z', isBackfillAnchor: true }), {
      status: 200,
    });
  };

  const result = await submitBrowserTimeZone(fetchImpl as typeof fetch);
  assert.equal(result, 'submitted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, '/rhythm/api/settings/time-zone');
  assert.equal(calls[0]?.init.method, 'PUT');
  assert.equal(calls[0]?.init.credentials, 'same-origin');
  assert.match(String(calls[0]?.init.headers && (calls[0].init.headers as Record<string, string>)['content-type']), /application\/json/i);
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { ianaTimeZone: zone });
});

test('refreshed read model can show reindexed historical complete strain', () => {
  const html = render({
    localDate: '2026-08-10',
    metrics: {
      ...view.metrics,
      strain: {
        label: '全天心肺负荷',
        score: 0,
        status: 'complete',
        detail: '完整日心肺负荷，仅计入可归因活动分钟。',
        coverage,
        source: { ...source, timeZone: 'unambiguous' },
      },
    },
  }, 'oauth');

  assert.match(html, /记录日期 2026-08-10/);
  assert.match(html, /<p class="metric-card__score">0\.0<\/p>/);
  assert.match(html, /数据质量：完整/);
  assert.match(html, /时区明确|心率区间/);
  assertNoTrainingPermission(html);
  assertNoRawSecrets(html);
});
