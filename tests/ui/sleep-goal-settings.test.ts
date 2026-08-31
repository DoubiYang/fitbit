import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  parseSleepGoalMinutes,
  saveSleepGoal,
  SleepGoalSettings,
  SleepGoalSettingsPanel,
} from '../../src/ui/settings/sleep-goal-settings';
import { submitBrowserTimeZone, TimeZoneBootstrap } from '../../src/ui/settings/time-zone-bootstrap';

function assertSageSettings(html: string) {
  assert.match(html, /class="dashboard"/);
  assert.match(html, /action-card/);
  assert.match(html, /<button/);
  assert.match(html, /appShell__/);
}

test('sleep goal form stays disabled until a time zone exists', () => {
  const html = renderToStaticMarkup(
    React.createElement(SleepGoalSettings, { initialGoalMinutes: null, hasTimeZone: false }),
  );

  assert.match(html, /基础睡眠目标/);
  assert.match(html, /<button[^>]*disabled/);
  assert.match(html, /时区/);
  assert.match(html, /不是医学处方/);
  assert.match(html, /次日/);
  assert.doesNotMatch(html, /可以训练/);
  assert.doesNotMatch(html, /可按原计划/);
});

test('sleep goal form uses Sage controls and can submit once a zone exists', () => {
  const html = renderToStaticMarkup(
    React.createElement(SleepGoalSettings, { initialGoalMinutes: 480, hasTimeZone: true }),
  );

  assert.match(html, /value="480"/);
  assert.match(html, /min="300"/);
  assert.match(html, /max="900"/);
  assert.match(html, /保存睡眠目标/);
  assert.doesNotMatch(html, /<button[^>]*disabled/);
  assertSageSettings(renderToStaticMarkup(
    React.createElement(SleepGoalSettingsPanel, { initialGoalMinutes: 480, hasTimeZone: true }),
  ));
});

test('settings panel mounts time-zone bootstrap and a settings path, not a new tab', () => {
  const html = renderToStaticMarkup(
    React.createElement(SleepGoalSettingsPanel, { initialGoalMinutes: null, hasTimeZone: false }),
  );
  const bootstrap = renderToStaticMarkup(React.createElement(TimeZoneBootstrap));

  assert.match(html, /data-timezone-bootstrap/);
  assert.match(html, /href="\/rhythm"/);
  assert.match(html, /睡眠目标/);
  assert.match(html, /aria-label="主要导航"/);
  assert.match(html, /href="\/rhythm\/account"[^>]*aria-current="page"/);
  assert.match(bootstrap, /data-timezone-bootstrap="idle"/);
  assertSageSettings(html);
  assert.doesNotMatch(html, /GOCSPX|refresh-token|avgBpm/);
});

test('parseSleepGoalMinutes accepts only integers from 300 to 900', () => {
  assert.equal(parseSleepGoalMinutes('480'), 480);
  assert.equal(parseSleepGoalMinutes('300'), 300);
  assert.equal(parseSleepGoalMinutes('900'), 900);
  assert.equal(parseSleepGoalMinutes('299'), undefined);
  assert.equal(parseSleepGoalMinutes('901'), undefined);
  assert.equal(parseSleepGoalMinutes('480.5'), undefined);
  assert.equal(parseSleepGoalMinutes(''), undefined);
});

test('saveSleepGoal PUTs minutes to the authenticated settings endpoint', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ goalMinutes: 420, effectiveCivilDate: '2026-08-24' }), { status: 200 });
  };

  const result = await saveSleepGoal(420, fetchImpl as typeof fetch);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.effectiveCivilDate, '2026-08-24');
  }
  assert.equal(calls[0]?.url, '/rhythm/api/settings/sleep-goal');
  assert.equal(calls[0]?.init.method, 'PUT');
  assert.equal(calls[0]?.init.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { goalMinutes: 420 });
});

test('settings time-zone bootstrap uses the same PUT as the authenticated dashboard', async () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), '/rhythm/api/settings/time-zone');
    assert.equal(init?.method, 'PUT');
    assert.equal(init?.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(String(init?.body)), { ianaTimeZone: zone });
    return new Response(JSON.stringify({ ianaTimeZone: zone }), { status: 200 });
  };

  assert.equal(await submitBrowserTimeZone(fetchImpl as typeof fetch), 'submitted');
});
