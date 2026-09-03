import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { BodyAgeMetricView } from '../../src/server/dashboard/build-today';
import { BodyAgeCard, bodyAgeCardContent } from '../../src/ui/dashboard/body-age-card';
import {
  BodyAgeInfoSheet,
  bodyAgeInfoContext,
  isBodyAgeInfoSheetBackdropClick,
  nextBodyAgeInfoSheetFocusIndex,
} from '../../src/ui/dashboard/body-age-info-sheet';

const baseMetric: BodyAgeMetricView = {
  label: '身体年龄',
  age: 34,
  edge: null,
  status: 'daily_vo2_provisional',
  route: 'daily_vo2',
  coverageDays: 8,
  latestInputCivilDate: '2026-09-03',
  lastCalculatedCivilDate: '2026-09-03',
  referenceVersion: 'chinese-community-cycle-vo2peak-p50-v1',
  chronologicalAgeDeltaYears: -3,
  dataGaps: { dailyVo2DaysNeeded: 0, rhrDaysNeeded: 0, observedHrPeakRequired: false },
  disclaimer: 'non_medical_non_calibrated_estimate',
};

function metric(patch: Partial<BodyAgeMetricView>): BodyAgeMetricView {
  return { ...baseMetric, ...patch, dataGaps: { ...baseMetric.dataGaps, ...patch.dataGaps } };
}

function renderCard(input: BodyAgeMetricView): string {
  return renderToStaticMarkup(React.createElement(BodyAgeCard, { metric: input }));
}

function assertNoRawHealthData(html: string): void {
  for (const forbidden of [
    'birthDate', '1988-04-20', 'vo2Max', 'valueBpm', 'observedHrPeakBpm', 'sampleCount',
    'receivedAt', 'sourceFamily', 'accessToken', 'refreshToken', 'GOCSPX', 'googleRecord',
  ]) {
    assert.equal(html.includes(forbidden), false, forbidden);
  }
}

test('body-age card shows a numeric daily Air estimate with its safe status and coverage', () => {
  const html = renderCard(baseMetric);

  assert.match(html, /身体年龄/);
  assert.match(html, /34 岁/);
  assert.match(html, /估算/);
  assert.match(html, /Air 每日心肺估算/);
  assert.match(html, /初步/);
  assert.match(html, /8\/28 天/);
  assert.match(html, /最新 Air 输入：2026-09-03/);
  assert.match(html, /较实际年龄低 3 岁/);
  assert.match(html, /aria-label="了解身体年龄估算"/);
  assertNoRawHealthData(html);
});

test('body-age card labels a stable daily estimate and an observed-peak proxy without treating it as HRmax', () => {
  const stable = renderCard(metric({ coverageDays: 23, status: 'daily_vo2_stable' }));
  const observed = renderCard(metric({
    route: 'observed_peak_ratio', status: 'observed_peak_ratio_provisional', coverageDays: 7,
  }));

  assert.match(stable, /稳定/);
  assert.match(stable, /23\/28 天/);
  assert.match(observed, /Air 观察峰值心率比估算/);
  assert.match(observed, /初步/);
  assert.doesNotMatch(observed, /最大心率/);
  assertNoRawHealthData(observed);
});

test('body-age card renders reference boundaries without a chronological-age delta', () => {
  const lower = renderCard(metric({ age: null, edge: 'below_reference_min', chronologicalAgeDeltaYears: null }));
  const upper = renderCard(metric({ age: null, edge: 'above_reference_max', chronologicalAgeDeltaYears: null }));

  assert.match(lower, /≤25 岁/);
  assert.match(upper, /≥75 岁/);
  assert.doesNotMatch(lower, /较实际年龄/);
  assert.doesNotMatch(upper, /较实际年龄/);
});

test('body-age card gives a profile CTA and does not invent an age when profile fields are missing', () => {
  const html = renderCard(metric({
    age: null, edge: null, status: 'profile_missing', route: null, coverageDays: 0,
    latestInputCivilDate: null, lastCalculatedCivilDate: null, chronologicalAgeDeltaYears: null,
  }));

  assert.match(html, /完成资料后开始估算/);
  assert.match(html, /href="\/rhythm\/settings"/);
  assert.doesNotMatch(html, /34 岁/);
  assert.doesNotMatch(html, /数据质量|偏低/);
});

test('body-age card exposes exact accumulating data gaps without a low conclusion', () => {
  const html = renderCard(metric({
    age: null, edge: null, status: 'data_accumulating', route: null, coverageDays: 0,
    latestInputCivilDate: null, lastCalculatedCivilDate: null, chronologicalAgeDeltaYears: null,
    dataGaps: { dailyVo2DaysNeeded: 3, rhrDaysNeeded: 2, observedHrPeakRequired: true },
  }));

  assert.match(html, /还差 3 天 Air 心肺数据/);
  assert.match(html, /静息心率还差 2 天/);
  assert.match(html, /还需要历史观察峰值/);
  assert.doesNotMatch(html, /偏低|低于同龄|34 岁/);
});

test('body-age card never displays an old result while data is updating or stale', () => {
  const updating = renderCard(metric({
    age: null, edge: null, status: 'data_updating', route: null, coverageDays: 0,
    latestInputCivilDate: null, lastCalculatedCivilDate: null, chronologicalAgeDeltaYears: null,
  }));
  const stale = renderCard(metric({
    age: null, edge: null, status: 'stale', route: 'daily_vo2', coverageDays: 7,
    latestInputCivilDate: '2026-08-20', lastCalculatedCivilDate: '2026-08-20', chronologicalAgeDeltaYears: null,
  }));

  assert.match(updating, /数据更新中/);
  assert.doesNotMatch(updating, /34 岁|8\/28 天|最新 Air 输入/);
  assert.match(stale, /数据已过期/);
  assert.match(stale, /上次计算于 2026-08-20/);
  assert.match(stale, /Air 心肺数据尚未更新/);
  assert.doesNotMatch(stale, /34 岁|较实际年龄/);
});

test('body-age explainer keeps stale route coverage and latest-input context without restoring an old age', () => {
  const staleMetric = metric({
    age: null, edge: null, status: 'stale', route: 'daily_vo2', coverageDays: 7,
    latestInputCivilDate: '2026-08-20', lastCalculatedCivilDate: '2026-08-20', chronologicalAgeDeltaYears: null,
  });
  const context = bodyAgeInfoContext(staleMetric);

  assert.match(context, /Air 每日心肺估算/);
  assert.match(context, /7\/28 天/);
  assert.match(context, /最新 Air 输入：2026-08-20/);
  assert.match(context, /上次计算于 2026-08-20/);
  assert.doesNotMatch(context, /34 岁|较实际年龄|vo2Max|valueBpm|observedHrPeakBpm/);
});

test('body-age explainer discloses the nonmedical boundary, safe context, references, and accessible dialog structure', () => {
  const observedMetric = metric({
    route: 'observed_peak_ratio', status: 'observed_peak_ratio_provisional', coverageDays: 7,
  });
  const context = bodyAgeInfoContext(observedMetric);
  const html = renderToStaticMarkup(React.createElement(BodyAgeInfoSheet, {
    metric: observedMetric,
    initiallyOpen: true,
  }));

  assert.match(context, /观察峰值心率比/);
  assert.match(context, /7\/28 天/);
  assert.match(context, /2026-09-03/);
  assert.match(html, /这是依据 Fitbit Air 数据与中国成人心肺适能常模得到的估算心肺年龄，不是完整生物学年龄、医疗检测、疾病风险、寿命预测或运动处方。/);
  assert.match(html, /body-age-air-cn-v1/);
  assert.match(html, /chinese-community-cycle-vo2peak-p50-v1/);
  assert.match(html, /Wang et al\., 2022/);
  assert.match(html, /INTERLIVE/);
  assert.match(html, /Uth et al\., 2004/);
  assert.match(html, /日常观察峰值不是运动测试 HRmax/);
  assert.match(html, /<dialog[^>]*aria-modal="true"[^>]*aria-labelledby="body-age-info-sheet-title"[^>]*aria-describedby="body-age-info-sheet-description"/);
  assert.match(html, /<button[^>]*aria-label="关闭身体年龄说明"/);
  assertNoRawHealthData(html);
});

test('body-age info sheet focus helper wraps both tab directions inside the dialog', () => {
  assert.equal(nextBodyAgeInfoSheetFocusIndex({ currentIndex: 2, focusableCount: 3, shiftKey: false }), 0);
  assert.equal(nextBodyAgeInfoSheetFocusIndex({ currentIndex: 0, focusableCount: 3, shiftKey: true }), 2);
  assert.equal(nextBodyAgeInfoSheetFocusIndex({ currentIndex: 1, focusableCount: 3, shiftKey: false }), 1);
  assert.equal(nextBodyAgeInfoSheetFocusIndex({ currentIndex: -1, focusableCount: 0, shiftKey: false }), -1);
});

test('body-age info sheet only treats its backdrop as a close target', () => {
  const dialog = {} as HTMLDialogElement;
  assert.equal(isBodyAgeInfoSheetBackdropClick({ target: dialog, currentTarget: dialog }), true);
  assert.equal(isBodyAgeInfoSheetBackdropClick({ target: {} as EventTarget, currentTarget: dialog }), false);
});

test('body-age info sheet runs the native dialog lifecycle and returns focus for Escape and backdrop close', { concurrency: false }, async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://rhythm.local/' });
  const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
  const browserGlobals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLDialogElement: dom.window.HTMLDialogElement,
    Event: dom.window.Event,
    EventTarget: dom.window.EventTarget,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle,
  };
  for (const [name, value] of Object.entries(browserGlobals)) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  const originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  let showModalCalls = 0;
  let closeCalls = 0;
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      showModalCalls += 1;
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      closeCalls += 1;
      this.removeAttribute('open');
    },
  });

  try {
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const container = dom.window.document.querySelector('#root');
    assert.ok(container);
    const root = createRoot(container);
    await act(async () => { root.render(React.createElement(BodyAgeInfoSheet, { metric: baseMetric })); });

    const trigger = dom.window.document.querySelector<HTMLButtonElement>('[aria-label="了解身体年龄估算"]');
    assert.ok(trigger);
    await act(async () => { trigger.click(); });

    const openedDialog = dom.window.document.querySelector<HTMLDialogElement>('dialog.body-age-info-sheet');
    let closeButton = dom.window.document.querySelector<HTMLButtonElement>('[aria-label="关闭身体年龄说明"]');
    assert.ok(openedDialog);
    assert.ok(closeButton);
    assert.equal(showModalCalls, 1);
    assert.equal(openedDialog.hasAttribute('open'), true);
    assert.equal(dom.window.document.activeElement, closeButton);

    const lastLink = [...openedDialog.querySelectorAll<HTMLAnchorElement>('a[href]')].at(-1);
    assert.ok(lastLink);
    lastLink.focus();
    await act(async () => {
      lastLink.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    assert.equal(dom.window.document.activeElement, closeButton);

    await act(async () => {
      openedDialog.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    assert.equal(closeCalls, 1);
    assert.equal(dom.window.document.querySelector('dialog.body-age-info-sheet'), null);
    assert.equal(dom.window.document.activeElement, trigger);

    await act(async () => { trigger.click(); });
    const backdropDialog = dom.window.document.querySelector<HTMLDialogElement>('dialog.body-age-info-sheet');
    assert.ok(backdropDialog);
    assert.equal(showModalCalls, 2);
    await act(async () => {
      backdropDialog.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    assert.equal(closeCalls, 2);
    assert.equal(dom.window.document.querySelector('dialog.body-age-info-sheet'), null);
    assert.equal(dom.window.document.activeElement, trigger);

    await act(async () => { root.unmount(); });
  } finally {
    if (originalActEnvironment === undefined) {
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    } else {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
    }
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
    dom.window.close();
  }
});

test('body-age content helper reserves the empty display for all non-result states', () => {
  for (const status of ['profile_missing', 'data_accumulating', 'data_updating', 'stale'] as const) {
    assert.equal(bodyAgeCardContent(metric({
      age: null, edge: null, status, route: status === 'stale' ? 'daily_vo2' : null,
      coverageDays: 0, latestInputCivilDate: null, chronologicalAgeDeltaYears: null,
    })).value, '—');
  }
});
