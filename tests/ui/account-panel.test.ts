import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AccountPanel } from '../../src/ui/account/account-panel';

test('renders each account safety state without secrets', () => {
  const states = [
    renderToStaticMarkup(React.createElement(AccountPanel, { view: { state: 'unconfigured' } })),
    renderToStaticMarkup(React.createElement(AccountPanel, { view: { state: 'unauthenticated' } })),
    renderToStaticMarkup(
      React.createElement(AccountPanel, {
        view: {
          state: 'connected',
          connectedAt: '2026-08-24T12:00:00.000Z',
          scopeLabels: ['睡眠'],
          canWriteNutrition: true,
          testingExpiryNote: true,
        },
      }),
    ),
    renderToStaticMarkup(
      React.createElement(AccountPanel, {
        view: {
          state: 'partial',
          connectedAt: '2026-08-24T12:00:00.000Z',
          scopeLabels: ['睡眠'],
          missingLabels: ['心电图'],
          missingCore: false,
          canWriteNutrition: false,
          testingExpiryNote: true,
        },
      }),
    ),
    renderToStaticMarkup(React.createElement(AccountPanel, { view: { state: 'expired', testingExpiryNote: true } })),
    renderToStaticMarkup(React.createElement(AccountPanel, { view: { state: 'callback_error', code: 'access_denied' } })),
  ];

  assert.match(states[0], /需要本地 Google Health 配置/);
  assert.match(states[1], /连接 Google Health/);
  assert.match(states[1], /Google 第三方应用权限/);
  assert.match(states[1], /尝试同步最近 14 天/);
  assert.match(states[2], /已连接/);
  assert.match(states[2], /最近一次成功保存的本地快照/);
  assert.match(states[3], /权限不完整/);
  assert.match(states[4], /需要重新连接/);
  assert.match(states[5], /已取消 Google 授权/);
  for (const html of states) {
    assert.doesNotMatch(html, /refresh-token/);
    assert.doesNotMatch(html, /healthUserId/);
    assert.doesNotMatch(html, /GOCSPX/);
  }
});
