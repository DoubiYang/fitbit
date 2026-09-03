'use client';

import { CircleHelp, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';

import type { BodyAgeMetricView } from '../../server/dashboard/build-today';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function routeLabel(route: BodyAgeMetricView['route']): string {
  if (route === 'daily_vo2') return 'Air 每日心肺估算';
  if (route === 'observed_peak_ratio') return 'Air 观察峰值心率比估算';
  return '待确定';
}

function statusLabel(status: BodyAgeMetricView['status']): string {
  const labels: Record<BodyAgeMetricView['status'], string> = {
    profile_missing: '资料待补充',
    data_accumulating: '数据待积累',
    data_updating: '数据更新中',
    daily_vo2_provisional: '初步',
    daily_vo2_stable: '稳定',
    observed_peak_ratio_provisional: '初步',
    stale: '数据已过期',
  };
  return labels[status];
}

/** A copy-only summary of the dashboard allowlist, with no raw health values. */
export function bodyAgeInfoContext(metric: BodyAgeMetricView): string {
  if (metric.status === 'profile_missing') return '资料尚未补充，因此还没有估算结果。';
  if (metric.status === 'data_accumulating') {
    const gaps: string[] = [];
    if (metric.dataGaps.dailyVo2DaysNeeded > 0) gaps.push(`还差 ${metric.dataGaps.dailyVo2DaysNeeded} 天 Air 心肺数据`);
    if (metric.dataGaps.rhrDaysNeeded > 0) gaps.push(`静息心率还差 ${metric.dataGaps.rhrDaysNeeded} 天`);
    if (metric.dataGaps.observedHrPeakRequired) gaps.push('仍需要历史观察峰值');
    return gaps.length > 0 ? `数据正在积累：${gaps.join('；')}。` : 'Air 数据正在积累。';
  }
  if (metric.status === 'data_updating') return '资料或 Air 数据刚更新，正在生成新的估算。';
  if (metric.status === 'stale') {
    const latest = metric.latestInputCivilDate ? `最新 Air 输入：${metric.latestInputCivilDate}` : '最新 Air 输入日期暂不可用';
    const lastCalculated = metric.lastCalculatedCivilDate
      ? `上次计算于 ${metric.lastCalculatedCivilDate}`
      : '上次计算日期暂不可用';
    return `${routeLabel(metric.route)}；有效数据 ${metric.coverageDays}/28 天；${latest}；Air 输入尚未更新，${lastCalculated}。`;
  }
  const latest = metric.latestInputCivilDate ? `最新 Air 输入：${metric.latestInputCivilDate}` : '最新 Air 输入日期暂不可用';
  return `本次使用${routeLabel(metric.route)}；状态：${statusLabel(metric.status)}；有效数据 ${metric.coverageDays}/28 天；${latest}。`;
}

export function nextBodyAgeInfoSheetFocusIndex(input: {
  currentIndex: number;
  focusableCount: number;
  shiftKey: boolean;
}): number {
  if (input.focusableCount <= 0) return -1;
  if (input.currentIndex < 0) return input.shiftKey ? input.focusableCount - 1 : 0;
  if (input.shiftKey && input.currentIndex === 0) return input.focusableCount - 1;
  if (!input.shiftKey && input.currentIndex === input.focusableCount - 1) return 0;
  return input.currentIndex;
}

export function isBodyAgeInfoSheetBackdropClick(event: Pick<MouseEvent<HTMLDialogElement>, 'target' | 'currentTarget'>): boolean {
  return event.target === event.currentTarget;
}

function trapTabWithinBodyAgeInfoSheet(event: KeyboardEvent<HTMLDialogElement>): void {
  if (event.key !== 'Tab') return;
  const dialog = event.currentTarget;
  const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => !element.hasAttribute('hidden'));
  const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
  const nextIndex = nextBodyAgeInfoSheetFocusIndex({
    currentIndex, focusableCount: focusable.length, shiftKey: event.shiftKey,
  });
  if (nextIndex >= 0 && nextIndex !== currentIndex) {
    event.preventDefault();
    focusable[nextIndex]?.focus();
  }
}

function Sources({ route }: { route: BodyAgeMetricView['route'] }) {
  return (
    <ul className="body-age-info-sheet__sources">
      <li>
        <a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC9409785/" target="_blank" rel="noreferrer">Wang et al., 2022</a>
        {' '}：中国社区成人功率车 CPET 参考。
      </li>
      <li>
        <a href="https://pubmed.ncbi.nlm.nih.gov/35072942/" target="_blank" rel="noreferrer">INTERLIVE</a>
        {' '}：可穿戴心肺适能估算的系统综述与个体误差限制。
      </li>
      {route === 'observed_peak_ratio' ? (
        <li>
          <a href="https://pubmed.ncbi.nlm.nih.gov/14624296/" target="_blank" rel="noreferrer">Uth et al., 2004</a>
          {' '}：心率比方程的研究基础；日常观察峰值不是运动测试 HRmax。
        </li>
      ) : null}
    </ul>
  );
}

export function BodyAgeInfoSheet({
  metric,
  initiallyOpen = false,
}: {
  metric: BodyAgeMetricView;
  /** Test-only friendly initial state; the dashboard leaves this false. */
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const trigger = triggerRef.current;
    const onCancel = (event: Event) => {
      event.preventDefault();
      setOpen(false);
    };
    dialog.addEventListener('cancel', onCancel);
    if (!dialog.open) dialog.showModal();
    closeRef.current?.focus();
    return () => {
      dialog.removeEventListener('cancel', onCancel);
      if (dialog.open) dialog.close();
      trigger?.focus();
    };
  }, [open]);

  function close(): void {
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    trapTabWithinBodyAgeInfoSheet(event);
  }

  return (
    <>
      <button
        ref={triggerRef}
        className="body-age-info-trigger"
        type="button"
        aria-label="了解身体年龄估算"
        onClick={() => setOpen(true)}
      >
        <CircleHelp aria-hidden="true" size={19} strokeWidth={1.8} />
      </button>
      {open ? (
        <dialog
          ref={dialogRef}
          className="body-age-info-sheet"
          aria-modal="true"
          aria-labelledby="body-age-info-sheet-title"
          aria-describedby="body-age-info-sheet-description"
          onClick={(event) => { if (isBodyAgeInfoSheetBackdropClick(event)) close(); }}
          onKeyDown={onKeyDown}
        >
          <div className="body-age-info-sheet__header">
            <div>
              <p className="section-kicker">身体年龄</p>
              <h2 id="body-age-info-sheet-title">这个估算从哪里来？</h2>
            </div>
            <button ref={closeRef} className="body-age-info-sheet__close" type="button" aria-label="关闭身体年龄说明" onClick={close}>
              <X aria-hidden="true" size={20} strokeWidth={1.8} />
            </button>
          </div>
          <p id="body-age-info-sheet-description" className="body-age-info-sheet__definition">
            这是依据 Fitbit Air 数据与中国成人心肺适能常模得到的估算心肺年龄，不是完整生物学年龄、医疗检测、疾病风险、寿命预测或运动处方。
          </p>
          <section className="body-age-info-sheet__section" aria-labelledby="body-age-info-context-heading">
            <h3 id="body-age-info-context-heading">本次状态</h3>
            <p>{bodyAgeInfoContext(metric)}</p>
          </section>
          <section className="body-age-info-sheet__section" aria-labelledby="body-age-info-method-heading">
            <h3 id="body-age-info-method-heading">计算方法</h3>
            <p>
              优先把最近 28 天 Air 日心肺估算的中位水平，与中国成人功率车 CPET P50 常模逐段匹配；数据不足时，才以观察峰值与静息心率的比例形成代理估算。两条路线不会混用。
            </p>
            <p>算法版本：body-age-air-cn-v1。参考表：{metric.referenceVersion}。</p>
          </section>
          <section className="body-age-info-sheet__section" aria-labelledby="body-age-info-sources-heading">
            <h3 id="body-age-info-sources-heading">研究与限制</h3>
            <Sources route={metric.route} />
            <p>这是一项非医疗、非设备校准的估算；不会验证或推断硬件型号。</p>
          </section>
        </dialog>
      ) : null}
    </>
  );
}
