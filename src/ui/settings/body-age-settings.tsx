'use client';

import { useRef, useState, type FormEvent } from 'react';

export const BODY_AGE_PROFILE_ENDPOINT = '/rhythm/api/settings/body-age-profile';

export type BodyAgeReferenceSex = 'male' | 'female';

export type BodyAgeProfileValues = {
  birthDate: string | null;
  referenceSex: BodyAgeReferenceSex | null;
};

export type CompleteBodyAgeProfile = {
  birthDate: string;
  referenceSex: BodyAgeReferenceSex;
};

export type BodyAgeProfileEditorState = {
  birthDate: string;
  referenceSex: BodyAgeReferenceSex | '';
  hasSavedProfile: boolean;
  message: string | null;
  busy: boolean;
};

export function createBodyAgeProfileEditorState(profile: BodyAgeProfileValues): BodyAgeProfileEditorState {
  return {
    birthDate: profile.birthDate ?? '',
    referenceSex: profile.referenceSex ?? '',
    hasSavedProfile: profile.birthDate !== null && profile.referenceSex !== null,
    message: null,
    busy: false,
  };
}

export function editBodyAgeProfileState(
  state: BodyAgeProfileEditorState,
  patch: Pick<BodyAgeProfileEditorState, 'birthDate'> | Pick<BodyAgeProfileEditorState, 'referenceSex'>,
): BodyAgeProfileEditorState {
  return { ...state, ...patch, message: null };
}

export class BodyAgeProfileSaveGuard {
  #busy = false;

  get isBusy(): boolean {
    return this.#busy;
  }

  tryEnter(): boolean {
    if (this.#busy) return false;
    this.#busy = true;
    return true;
  }

  leave(): void {
    this.#busy = false;
  }
}

function isCivilDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function utcBodyAgeProfileCivilDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function parseBodyAgeProfileInput(
  value: { birthDate: string; referenceSex: string },
  today = utcBodyAgeProfileCivilDate(),
): CompleteBodyAgeProfile | undefined {
  if (!isCivilDate(value.birthDate) || value.birthDate > today) return undefined;
  if (value.referenceSex !== 'male' && value.referenceSex !== 'female') return undefined;
  return { birthDate: value.birthDate, referenceSex: value.referenceSex };
}

export function canSubmitBodyAgeProfile(input: {
  busy: boolean;
  editable: boolean;
  profile: CompleteBodyAgeProfile | undefined;
}): boolean {
  return !input.busy && input.editable && input.profile !== undefined;
}

function isReturnedProfile(value: unknown): value is BodyAgeProfileValues & { recomputePending?: unknown } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  if (profile.birthDate === null && profile.referenceSex === null) return true;
  return typeof profile.birthDate === 'string'
    && isCivilDate(profile.birthDate)
    && (profile.referenceSex === 'male' || profile.referenceSex === 'female');
}

export async function saveBodyAgeProfile(
  profile: BodyAgeProfileValues,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; profile: BodyAgeProfileValues; recomputePending: boolean } | { ok: false; error: string }> {
  try {
    const response = await fetchImpl(BODY_AGE_PROFILE_ENDPOINT, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(profile),
      credentials: 'same-origin',
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      return { ok: false, error: typeof body.error === 'string' ? body.error : 'save_failed' };
    }
    if (!isReturnedProfile(body)) return { ok: false, error: 'invalid_response' };
    return {
      ok: true,
      profile: { birthDate: body.birthDate, referenceSex: body.referenceSex },
      recomputePending: body.recomputePending === true,
    };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

export function BodyAgeProfileSettings({
  initialProfile,
  editable = true,
}: {
  initialProfile: BodyAgeProfileValues;
  editable?: boolean;
}) {
  const [state, setState] = useState(() => createBodyAgeProfileEditorState(initialProfile));
  const busyRef = useRef<BodyAgeProfileSaveGuard | null>(null);
  if (!busyRef.current) busyRef.current = new BodyAgeProfileSaveGuard();
  const profile = parseBodyAgeProfileInput({ birthDate: state.birthDate, referenceSex: state.referenceSex });
  const canSave = canSubmitBodyAgeProfile({ busy: state.busy, editable, profile });
  const canClear = editable && state.hasSavedProfile && !state.busy;

  async function persist(nextProfile: BodyAgeProfileValues, successMessage: string) {
    if (!busyRef.current?.tryEnter()) return;
    setState((current) => ({ ...current, busy: true }));
    try {
      const result = await saveBodyAgeProfile(nextProfile);
      if (result.ok) {
        setState((current) => ({
          ...current,
          birthDate: result.profile.birthDate ?? '',
          referenceSex: result.profile.referenceSex ?? '',
          hasSavedProfile: result.profile.birthDate !== null && result.profile.referenceSex !== null,
          message: result.recomputePending ? `${successMessage}估算将在下一次数据同步后更新。` : successMessage,
        }));
        return;
      }
      if (result.error === 'invalid_body_age_profile') {
        setState((current) => ({ ...current, message: '请检查出生日期和生理参考性别后再保存。' }));
        return;
      }
      setState((current) => ({ ...current, message: '保存未完成，请稍后重试。' }));
    } finally {
      busyRef.current?.leave();
      setState((current) => ({ ...current, busy: false }));
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.busy || busyRef.current?.isBusy) return;
    if (!canSubmitBodyAgeProfile({ busy: state.busy, editable, profile }) || !profile) return;
    await persist(profile, '身体年龄资料已保存。');
  }

  async function clearProfile() {
    if (state.busy || busyRef.current?.isBusy) return;
    if (!editable || !state.hasSavedProfile || !window.confirm('清除出生日期与生理参考性别后，身体年龄将不再计算。确定继续吗？')) return;
    await persist({ birthDate: null, referenceSex: null }, '身体年龄资料已清除。');
  }

  function editBirthDate(value: string) {
    setState((current) => editBodyAgeProfileState(current, { birthDate: value }));
  }

  function editReferenceSex(value: BodyAgeReferenceSex) {
    setState((current) => editBodyAgeProfileState(current, { referenceSex: value }));
  }

  return (
    <section className="action-card body-age-settings">
      <div className="settings-section-heading">
        <div>
          <p className="section-kicker">身体年龄</p>
          <h2>身体年龄资料</h2>
        </div>
        <p className="settings-section-heading__note">非医疗估算</p>
      </div>
      <p className="action-card__text">
        按照你声明的 Air-only 使用方式，估算只使用已连接 Google Health 中的可穿戴数据。
      </p>
      <p className="lede">
        日 VO₂ 为首选输入；数据不足时，才使用静息心率与历史观察峰值组成代理估算。参考中国社区成人参考，不是医疗结论。
      </p>
      <form className="settings-form" onSubmit={(event) => { void onSubmit(event); }}>
        <label>
          <span>出生日期（用于计算同龄差）</span>
          <input
            type="date"
            name="birthDate"
            max={utcBodyAgeProfileCivilDate()}
            value={state.birthDate}
            onChange={(event) => editBirthDate(event.target.value)}
            disabled={!editable || state.busy}
            required
          />
        </label>
        <fieldset className="settings-fieldset" disabled={!editable || state.busy}>
          <legend>生理参考性别（用于中国成人同龄参考）</legend>
          <p>仅用于选择研究参考表，不代表性别身份。</p>
          <div className="settings-radio-group">
            <label>
              <input
                type="radio"
                name="referenceSex"
                value="male"
                checked={state.referenceSex === 'male'}
                onChange={() => editReferenceSex('male')}
              />
              男
            </label>
            <label>
              <input
                type="radio"
                name="referenceSex"
                value="female"
                checked={state.referenceSex === 'female'}
                onChange={() => editReferenceSex('female')}
              />
              女
            </label>
          </div>
        </fieldset>
        {editable ? <p className="settings-form__hint">填写出生日期和生理参考性别后即可保存；估算会在下一次数据同步后更新。</p> : null}
        <div className="account-actions">
          <button type="submit" disabled={!canSave}>{state.busy ? '正在保存…' : '保存身体年龄资料'}</button>
          {canClear ? <button type="button" className="button-secondary" onClick={() => { void clearProfile(); }} disabled={state.busy}>清除资料</button> : null}
        </div>
      </form>
      {!editable ? <p className="lede">演示模式不保存身体年龄资料。</p> : null}
      <p className="lede">生日仅在服务器端用于同龄比较，不会显示在仪表盘或公共页面；原始可穿戴记录不会发送到浏览器。</p>
      {state.message ? <p className="lede" aria-live="polite">{state.message}</p> : null}
    </section>
  );
}
