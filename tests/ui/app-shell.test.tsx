import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AppShell } from '../../src/ui/shell/app-shell';

test('renders the primary navigation and identifies today as the current page', () => {
  const html = renderToStaticMarkup(
    React.createElement(AppShell, { active: 'today', children: React.createElement('p', null, '内容') }),
  );

  assert.match(html, /<nav[^>]*aria-label="主要导航"/);
  assert.match(html, /href="\/rhythm"/);
  assert.match(html, /href="\/rhythm\/meals\/new"/);
  assert.match(html, /href="\/rhythm\/account"/);
  assert.match(html, /今日/);
  assert.match(html, /餐食/);
  assert.match(html, /账户/);
  assert.match(html, /href="\/rhythm"[^>]*aria-current="page"/);
});

test('marks the account navigation item as the current page semantically', () => {
  const html = renderToStaticMarkup(
    React.createElement(AppShell, { active: 'account', children: React.createElement('p', null, '内容') }),
  );

  assert.match(html, /href="\/rhythm\/account"[^>]*aria-current="page"/);
  assert.doesNotMatch(html, /href="\/rhythm"[^>]*aria-current="page"/);
});

test('does not add a main landmark around the caller-owned main content', () => {
  const html = renderToStaticMarkup(
    React.createElement(AppShell, {
      active: 'today',
      children: React.createElement('main', null, '页面内容'),
    }),
  );

  assert.equal((html.match(/<main\b/g) ?? []).length, 1);
  assert.match(html, /<main>页面内容<\/main><\/div><nav/);
});
