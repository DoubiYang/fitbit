import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  BODY_AGE_PROFILE_ENDPOINT,
  BodyAgeProfileSettings,
  BodyAgeProfileSaveGuard,
  canSubmitBodyAgeProfile,
  createBodyAgeProfileEditorState,
  editBodyAgeProfileState,
  parseBodyAgeProfileInput,
  saveBodyAgeProfile,
  utcBodyAgeProfileCivilDate,
} from '../../src/ui/settings/body-age-settings';
import { SettingsPanel } from '../../src/ui/settings/sleep-goal-settings';

test('body-age form accepts a real past birthday and one Chinese-reference sex only', () => {
  assert.deepEqual(
    parseBodyAgeProfileInput({ birthDate: '1992-02-29', referenceSex: 'female' }, '2026-09-03'),
    { birthDate: '1992-02-29', referenceSex: 'female' },
  );
  assert.equal(parseBodyAgeProfileInput({ birthDate: '1991-02-29', referenceSex: 'female' }, '2026-09-03'), undefined);
  assert.equal(parseBodyAgeProfileInput({ birthDate: '2026-09-04', referenceSex: 'male' }, '2026-09-03'), undefined);
  assert.equal(parseBodyAgeProfileInput({ birthDate: '', referenceSex: 'male' }, '2026-09-03'), undefined);
  assert.equal(parseBodyAgeProfileInput({ birthDate: '1992-02-29', referenceSex: '' }, '2026-09-03'), undefined);
  assert.equal(parseBodyAgeProfileInput({ birthDate: '1992-02-29', referenceSex: 'other' }, '2026-09-03'), undefined);
});

test('body-age date validation uses the server UTC civil day across a local day boundary', () => {
  const instant = new Date('2026-09-02T16:30:00.000Z');
  const utcToday = utcBodyAgeProfileCivilDate(instant);

  assert.equal(utcToday, '2026-09-02');
  assert.deepEqual(
    parseBodyAgeProfileInput({ birthDate: '2026-09-02', referenceSex: 'male' }, utcToday),
    { birthDate: '2026-09-02', referenceSex: 'male' },
  );
  assert.equal(parseBodyAgeProfileInput({ birthDate: '2026-09-03', referenceSex: 'male' }, utcToday), undefined);
});

test('body-age form submission guard rejects a busy or incomplete form', () => {
  const complete = { birthDate: '1992-02-29', referenceSex: 'female' as const };

  assert.equal(canSubmitBodyAgeProfile({ busy: true, editable: true, profile: complete }), false);
  assert.equal(canSubmitBodyAgeProfile({ busy: false, editable: false, profile: complete }), false);
  assert.equal(canSubmitBodyAgeProfile({ busy: false, editable: true, profile: undefined }), false);
  assert.equal(canSubmitBodyAgeProfile({ busy: false, editable: true, profile: complete }), true);
});

test('editing either body-age profile field clears a prior save message in the state used by the form', () => {
  const saved = {
    ...createBodyAgeProfileEditorState({ birthDate: '1992-02-29', referenceSex: 'female' }),
    message: '身体年龄资料已保存。估算将在下一次数据同步后更新。',
  };

  assert.deepEqual(editBodyAgeProfileState(saved, { birthDate: '1993-02-28' }), {
    ...saved,
    birthDate: '1993-02-28',
    message: null,
  });
  assert.deepEqual(editBodyAgeProfileState(saved, { referenceSex: 'male' }), {
    ...saved,
    referenceSex: 'male',
    message: null,
  });
});

test('body-age save guard rejects the second entry before the first UI state update can render', () => {
  const guard = new BodyAgeProfileSaveGuard();

  assert.equal(guard.tryEnter(), true);
  assert.equal(guard.isBusy, true);
  assert.equal(guard.tryEnter(), false);
  guard.leave();
  assert.equal(guard.isBusy, false);
  assert.equal(guard.tryEnter(), true);
});

test('body-age save sends only profile settings to the same-origin endpoint', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({
      birthDate: '1992-02-29', referenceSex: 'female', profileRevision: 2, recomputePending: true,
    }), { status: 200 });
  };

  const result = await saveBodyAgeProfile(
    { birthDate: '1992-02-29', referenceSex: 'female' },
    fetchImpl as typeof fetch,
  );

  assert.deepEqual(result, {
    ok: true,
    profile: { birthDate: '1992-02-29', referenceSex: 'female' },
    recomputePending: true,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, BODY_AGE_PROFILE_ENDPOINT);
  assert.equal(calls[0]?.init.method, 'PUT');
  assert.equal(calls[0]?.init.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { birthDate: '1992-02-29', referenceSex: 'female' });
  assert.doesNotMatch(String(calls[0]?.init.body), /avgBpm|vo2Max|observedHrPeak|sampleCount|heartRate/i);
});

test('body-age save reports server and network failures without exposing raw health data', async () => {
  const rejected = await saveBodyAgeProfile(
    { birthDate: '1992-02-29', referenceSex: 'female' },
    (async () => new Response(JSON.stringify({ error: 'invalid_body_age_profile' }), { status: 400 })) as typeof fetch,
  );
  assert.deepEqual(rejected, { ok: false, error: 'invalid_body_age_profile' });

  const offline = await saveBodyAgeProfile(
    { birthDate: '1992-02-29', referenceSex: 'female' },
    (async () => { throw new Error('offline'); }) as typeof fetch,
  );
  assert.deepEqual(offline, { ok: false, error: 'network_error' });
});

test('settings renders one editorial flow for sleep and body-age profile without raw wearable fields', () => {
  const html = renderToStaticMarkup(
    React.createElement(SettingsPanel, {
      initialGoalMinutes: 480,
      hasTimeZone: true,
      initialBodyAgeProfile: { birthDate: '1992-02-29', referenceSex: 'female' },
    }),
  );

  assert.match(html, /<h1>健康设置<\/h1>/);
  assert.match(html, /基础睡眠目标/);
  assert.match(html, /身体年龄资料/);
  assert.match(html, /生理参考性别（用于中国成人同龄参考）/);
  assert.match(html, /value="1992-02-29"/);
  assert.match(html, /日 VO₂ 为首选输入/);
  assert.match(html, /静息心率与历史观察峰值/);
  assert.match(html, /中国社区成人参考/);
  assert.match(html, /非医疗估算/);
  assert.match(html, /生日仅在服务器端用于同龄比较/);
  assert.match(html, /原始可穿戴记录不会发送到浏览器/);
  assert.match(html, /下一次数据同步后更新/);
  assert.match(html, /appShell__/);
  assert.doesNotMatch(html, /avgBpm|vo2Max|observedHrPeakBpm|sampleCount|refresh-token|GOCSPX/);
  assert.doesNotMatch(html, /设备型号验证|选择设备/);
});

test('body-age form in a demo cannot save an account profile', () => {
  const html = renderToStaticMarkup(
    React.createElement(BodyAgeProfileSettings, {
      initialProfile: { birthDate: null, referenceSex: null },
      editable: false,
    }),
  );

  assert.match(html, /演示模式不保存身体年龄资料/);
  assert.match(html, /<button[^>]*disabled/);
  assert.doesNotMatch(html, /avgBpm|vo2Max|observedHrPeakBpm|sampleCount/);
});
