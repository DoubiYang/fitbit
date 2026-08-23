import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import Home from '../app/page';

test('renders the controlled today dashboard for the demo user', async () => {
  const html = renderToStaticMarkup(await Home());

  assert.match(html, /今日节律/);
  assert.match(html, /今天的建议/);
  assert.match(html, /恢复信号/);
  assert.match(html, /数据新鲜/);
});
