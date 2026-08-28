import assert from 'node:assert/strict';
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

  assert.match(html, /已授权的健康记录会同步为本地健康快照/);
  assert.match(html, /在本地读取和展示/);
  assert.match(html, /经你同意后，当前餐食照片只用于一次视觉识别/);
  assert.match(html, /保存后不会保留照片或识别来源/);
  assert.match(html, /餐食助手只会收到当前结构化餐食和当前问题/);
  assert.match(html, /不会收到照片、OAuth、会话或刷新令牌/);
  assert.match(html, /OAuth 凭据会加密保存在服务器数据库/);
  assert.match(html, /不会进入浏览器存储或模型请求/);
  assert.match(html, /断开连接会删除本地授权/);
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
