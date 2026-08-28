import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AccountPanel } from '../../src/ui/account/account-panel';

test('renders each account safety state without secrets', () => {
  const states = {
    unconfigured: renderToStaticMarkup(React.createElement(AccountPanel, { view: { state: 'unconfigured' } })),
    unauthenticated: renderToStaticMarkup(React.createElement(AccountPanel, { view: { state: 'unauthenticated' } })),
    connected: renderToStaticMarkup(
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
    partial: renderToStaticMarkup(
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
    expired: renderToStaticMarkup(React.createElement(AccountPanel, { view: { state: 'expired', testingExpiryNote: true } })),
    callbackError: renderToStaticMarkup(React.createElement(AccountPanel, { view: { state: 'callback_error', code: 'access_denied' } })),
  };

  assert.match(states.unconfigured, /需要本地 Google Health 配置/);
  assert.match(states.unauthenticated, /连接 Google Health/);
  assert.match(states.unauthenticated, /Google 第三方应用权限/);
  assert.match(states.unauthenticated, /尝试同步最近 14 天/);
  assert.match(states.connected, /已连接/);
  assert.match(states.connected, /最近一次成功保存的本地快照/);
  assert.match(states.partial, /权限不完整/);
  assert.match(states.expired, /需要重新连接/);
  assert.match(states.callbackError, /已取消 Google 授权/);

  for (const html of Object.values(states)) {
    assert.match(html, /aria-label="主要导航"/);
    assert.match(html, /href="\/rhythm\/account"[^>]*aria-current="page"/);
    assert.doesNotMatch(html, /refresh-token/);
    assert.doesNotMatch(html, /healthUserId/);
    assert.doesNotMatch(html, /GOCSPX/);
  }

  assert.match(states.unauthenticated, /<form[^>]*action="\/rhythm\/api\/auth\/google\/start"[^>]*method="post">/);
  assert.match(states.callbackError, /<form[^>]*action="\/rhythm\/api\/auth\/google\/start"[^>]*method="post">/);
  for (const html of [states.connected, states.partial, states.expired]) {
    assert.match(html, /<form[^>]*action="\/rhythm\/api\/account\/reauthorize"[^>]*method="post">/);
    assert.match(html, /<form[^>]*action="\/rhythm\/api\/account\/logout"[^>]*method="post">/);
    assert.match(html, /<form[^>]*action="\/rhythm\/api\/account\/disconnect"[^>]*method="post">/);
  }
});
