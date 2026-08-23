import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { TodayView } from '../../src/server/dashboard/build-today';
import { TodayDashboard } from '../../src/ui/dashboard/today-dashboard';

const view: TodayView = {
  userId: 'demo_user',
  generatedAt: '2026-08-22T08:00:00.000Z',
  freshness: 'fresh',
  primaryAction: {
    kind: 'recommendation',
    text: '今天建议维持原有节奏。',
    evidence: [
      { label: 'HRV', date: '2026-08-22', value: 51 },
      { label: '睡眠完整度', date: '2026-08-22', value: 82 },
    ],
  },
  metrics: {
    recovery: { label: '恢复信号', score: 66, quality: 'medium', detail: '存在部分缺失或临时基线。' },
    sleep: { label: '睡眠完整度', score: 82, quality: 'high', detail: '数据完整。' },
    training: { label: '训练负荷', score: 1.1, quality: 'medium', detail: '存在部分缺失或临时基线。' },
  },
};

test('shows the action evidence and data quality instead of a metric wall', () => {
  const html = renderToStaticMarkup(React.createElement(TodayDashboard, { view }));

  assert.match(html, /今天的建议/);
  assert.match(html, /今天建议维持原有节奏/);
  assert.match(html, /HRV · 2026-08-22：51/);
  assert.match(html, /恢复信号/);
  assert.match(html, /数据质量：中/);
  assert.match(html, /数据新鲜/);
});
