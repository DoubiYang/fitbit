import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import Home from '../app/page';

test('renders an honest data-preparation state before health data is connected', () => {
  const html = renderToStaticMarkup(React.createElement(Home));

  assert.match(html, /今日节律/);
  assert.match(html, /正在准备你的个性化节律视图/);
  assert.match(html, /连接健康数据后/);
});
