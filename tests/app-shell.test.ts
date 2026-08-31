import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import Home, { dynamic } from '../app/page';

test('renders the controlled today dashboard for the demo user', async () => {
  const html = renderToStaticMarkup(await Home());

  assert.match(html, /今日记录/);
  assert.match(html, /今天的建议/);
  assert.match(html, /恢复状态/);
  assert.match(html, /数据新鲜/);
});

test('keeps the dashboard request-rendered so a synced view is not frozen at build time', () => {
  assert.equal(dynamic, 'force-dynamic');
});
