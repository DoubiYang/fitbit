import assert from 'node:assert/strict';
import test from 'node:test';

import manifest from '../app/manifest';

test('declares an installable Chinese PWA', () => {
  const result = manifest();

  assert.equal(result.name, '节律');
  assert.equal(result.display, 'standalone');
  assert.equal(result.lang, 'zh-CN');
  assert.equal(result.icons?.[0]?.src, '/icon.svg');
});
