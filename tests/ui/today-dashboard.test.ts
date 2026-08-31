import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { TodayView } from '../../src/server/dashboard/build-today';
import { TodayDashboard } from '../../src/ui/dashboard/today-dashboard';

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
