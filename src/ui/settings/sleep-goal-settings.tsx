'use client';

import { useEffect, useState, type FormEvent } from 'react';

import { AppShell } from '../shell/app-shell';
import { BodyAgeProfileSettings, type BodyAgeProfileValues } from './body-age-settings';
import { TIME_ZONE_READY_EVENT, TimeZoneBootstrap } from './time-zone-bootstrap';

export const SLEEP_GOAL_ENDPOINT = '/rhythm/api/settings/sleep-goal';

export function parseSleepGoalMinutes(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const goalMinutes = Number(trimmed);
  if (!Number.isInteger(goalMinutes) || goalMinutes < 300 || goalMinutes > 900) {
    return undefined;
  }
  return goalMinutes;
}

export async function saveSleepGoal(
  goalMinutes: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; goalMinutes: number; effectiveCivilDate: string } | { ok: false; error: string }> {
  try {
    const response = await fetchImpl(SLEEP_GOAL_ENDPOINT, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goalMinutes }),
      credentials: 'same-origin',
    });
    const body = (await response.json().catch(() => ({}))) as {
      goalMinutes?: unknown;
      effectiveCivilDate?: unknown;
      error?: unknown;
    };
    if (!response.ok) {
      return { ok: false, error: typeof body.error === 'string' ? body.error : 'save_failed' };
    }
    return {
      ok: true,
      goalMinutes: typeof body.goalMinutes === 'number' ? body.goalMinutes : goalMinutes,
      effectiveCivilDate: typeof body.effectiveCivilDate === 'string' ? body.effectiveCivilDate : '',
    };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

export function SleepGoalSettings({
  initialGoalMinutes,
  hasTimeZone,
}: {
  initialGoalMinutes: number | null;
  hasTimeZone: boolean;
}) {
  const [minutes, setMinutes] = useState(initialGoalMinutes !== null ? String(initialGoalMinutes) : '');
  const [zoneReady, setZoneReady] = useState(hasTimeZone);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = parseSleepGoalMinutes(minutes);
  const canSave = zoneReady && parsed !== undefined && !busy;

  useEffect(() => {
    const onReady = () => setZoneReady(true);
    window.addEventListener(TIME_ZONE_READY_EVENT, onReady);
    return () => window.removeEventListener(TIME_ZONE_READY_EVENT, onReady);
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (parsed === undefined || !zoneReady) {
      return;
    }
    setBusy(true);
    const result = await saveSleepGoal(parsed);
    setBusy(false);
    if (result.ok) {
      setMessage(result.effectiveCivilDate ? `已保存，将从 ${result.effectiveCivilDate} 起生效。` : '已保存睡眠目标。');
      return;
    }
    if (result.error === 'SleepGoalConflictError') {
      setMessage('同一生效日已有睡眠目标，历史不会被改写。');
      return;
    }
    if (result.error === 'time_zone_required') {
      setZoneReady(false);
      setMessage('请先确认设备时区后再保存。');
      return;
    }
    setMessage('保存未完成，请稍后重试。');
  }

  return (
    <section className="action-card">
      <h2>基础睡眠目标</h2>
      <p className="action-card__text">用于计算睡眠表现的完成度。这是你的偏好，不是医学处方。设置后从次日开始生效。</p>
      {!zoneReady ? <p className="lede">请先确认设备时区后再保存睡眠目标。</p> : null}
      <form className="settings-form" onSubmit={onSubmit}>
        <label>
          <span>目标分钟（300–900）</span>
          <input
            type="number"
            name="goalMinutes"
            min={300}
            max={900}
            step={1}
            inputMode="numeric"
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
          />
        </label>
        <button type="submit" disabled={!canSave}>
          保存睡眠目标
        </button>
      </form>
      {message ? <p className="lede">{message}</p> : null}
    </section>
  );
}

export function SettingsPanel({
  initialGoalMinutes,
  hasTimeZone,
  initialBodyAgeProfile = { birthDate: null, referenceSex: null },
  bodyAgeEditable = true,
  includeTimeZoneBootstrap = true,
}: {
  initialGoalMinutes: number | null;
  hasTimeZone: boolean;
  initialBodyAgeProfile?: BodyAgeProfileValues;
  bodyAgeEditable?: boolean;
  includeTimeZoneBootstrap?: boolean;
}) {
  return (
    <AppShell active="account">
      <main className="dashboard">
        <header className="dashboard-header">
          <p className="eyebrow">节律 · 设置</p>
          <div className="dashboard-header__title-row">
            <h1>健康设置</h1>
          </div>
          <p className="lede">在这里管理睡眠目标与身体年龄资料；两项都只用于各自的非医疗健康估算。</p>
        </header>
        {includeTimeZoneBootstrap ? <TimeZoneBootstrap /> : null}
        <div className="settings-stack">
          <SleepGoalSettings initialGoalMinutes={initialGoalMinutes} hasTimeZone={hasTimeZone} />
          <BodyAgeProfileSettings initialProfile={initialBodyAgeProfile} editable={bodyAgeEditable} />
        </div>
        <p>
          <a href="/rhythm">返回今日</a>
        </p>
      </main>
    </AppShell>
  );
}

export function SleepGoalSettingsPanel(props: {
  initialGoalMinutes: number | null;
  hasTimeZone: boolean;
  includeTimeZoneBootstrap?: boolean;
}) {
  return <SettingsPanel {...props} />;
}
