import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);

require.extensions['.css'] = (module) => {
  module.exports = new Proxy({}, { get: (_target, key) => (key === '__esModule' ? false : String(key)) });
};

const PrivacyPage = require('../../app/privacy/page').default as () => React.ReactNode;
const TermsPage = require('../../app/terms/page').default as () => React.ReactNode;

test('public app introduction identifies Air Recovery and links directly to the privacy policy', () => {
  assert.ok(existsSync(new URL('../../app/about/page.tsx', import.meta.url)), 'Public app introduction route is missing');
  const AboutPage = require('../../app/about/page').default as () => React.ReactNode;
  const html = renderToStaticMarkup(React.createElement(AboutPage));
  assert.match(html, /<h1[^>]*>Air Recovery<\/h1>/);
  assert.match(html, /href="\/rhythm\/privacy"[^>]*>隐私政策/);
  assert.match(html, /Google Health/);
  assert.match(html, /睡眠、心率/);
  assert.match(html, /恢复趋势/);
  assert.doesNotMatch(html, /尚未登录|无法显示今日视图/);
});

function assertAccountNavigation(html: string) {
  assert.match(html, /aria-label="主要导航"/);
  assert.match(html, /href="\/rhythm\/account"[^>]*aria-current="page"/);
  assert.match(html, /href="\/rhythm\/account">返回账户</);
  assert.doesNotMatch(html, /refresh-token/);
  assert.doesNotMatch(html, /healthUserId/);
  assert.doesNotMatch(html, /GOCSPX/);
}

test('privacy page accurately discloses the current data handling', () => {
  const html = renderToStaticMarkup(React.createElement(PrivacyPage));

  assert.match(html, /Air Recovery 隐私政策/);
  assert.match(html, /健康快照.*42 天/);
  assert.match(html, /MCP.*授权/);
  assert.match(html, /DeepSeek/);
  assert.match(html, /同步这一餐/);
  assert.match(html, /OAuth 凭据会加密保存在服务器数据库/);
  assert.match(html, /断开连接.*停止后续同步.*删除/);
  assert.match(html, /https:\/\/myaccount\.google\.com\/permissions/);
  assert.match(html, /Limited Use/);
  assert.match(html, /mailto:tibet211@gmail\.com/);
  assert.doesNotMatch(html, /本阶段不会拉取、展示或向模型发送你的真实健康记录/);
  assertAccountNavigation(html);
});

test('terms page retains its non-medical boundaries and account controls', () => {
  const html = renderToStaticMarkup(React.createElement(TermsPage));

  assert.match(html, /非医疗的生活方式参考/);
  assert.match(html, /不构成诊断、治疗或急救建议/);
  assert.match(html, /自己的 Google 账号完成授权/);
  assert.match(html, /测试模式的授权可能在约 7 天后过期/);
  assert.match(html, /随时断开连接或撤销 Google 权限/);
  assert.match(html, /自行保管部署环境中的密钥与数据/);
  assertAccountNavigation(html);
});
