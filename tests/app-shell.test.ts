import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import Home, { dynamic } from '../app/page';

test('renders the editorial today dashboard from the server-side safe view', async () => {
  const html = renderToStaticMarkup(await Home());

  assert.match(html, /今日/);
  assert.match(html, /· \d{1,2}月\d{1,2}日/);
  assert.match(html, /今日恢复/);
  assert.match(html, /全天心肺负荷/);
  assert.match(html, /身体年龄/);
  assert.match(html, /记录一餐/);
});

test('keeps the dashboard request-rendered so a synced view is not frozen at build time', () => {
  assert.equal(dynamic, 'force-dynamic');
});
