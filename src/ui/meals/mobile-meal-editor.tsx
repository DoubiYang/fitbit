'use client';

import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { Camera, LockKeyhole } from 'lucide-react';

import {
  editableMealDraftSchema,
  editableMealSavedSchema,
  fromInternalNutrientAmount,
  toInternalNutrientAmount,
  type EditableDish,
  type EditableMealDraft,
  type EditableMealSaved,
  type NutritionUnit,
  type MealPatch,
} from '../../domain/meal-editor';
import {
  mealAiSuggestionResponseSchema,
  type MealAiSuggestionResponse,
} from '../../domain/meal-ai-suggestions';
import {
  editableNutrientUnits,
  groupMealNutrients,
  mealAiApplyAllState,
  type PresentedMealNutrient,
} from './nutrient-presentation';

/**
 * Keep the client component directly renderable in the project's node:test
 * harness. The CSS module is loaded by the route entrypoints, while these
 * prefixed classes remain stable semantic hooks for both CSS and tests.
 */
function ui(name: string): string {
  return `mealEditor__${name}`;
}

type MealType = 'BREAKFAST' | 'LUNCH' | 'DINNER' | 'SNACK';
type SyncState = 'unsynced' | 'syncing' | 'synced' | 'recovery';
type EditorSession =
  | { kind: 'draft'; editor: EditableMealDraft }
  | { kind: 'saved'; editor: EditableMealSaved; syncState: SyncState; canSync: boolean; syncReason?: string };

type EditorEndpoint =
  | { kind: 'photo' }
  | { kind: 'draft'; draftId: string }
  | { kind: 'draft_ai'; draftId: string }
  | { kind: 'save_draft'; draftId: string }
  | { kind: 'meal'; mealId: string }
  | { kind: 'meal_ai'; mealId: string }
  | { kind: 'sync'; mealId: string };

type Message = {
  id: number;
  role: 'user' | 'assistant' | 'error';
  text: string;
  suggestions?: MealAiSuggestionResponse[];
};

export type PendingSuggestionState = {
  suggestions: MealAiSuggestionResponse[];
  resolvedIds: ReadonlySet<string>;
};

export type MealPatchOrigin =
  | { kind: 'manual' }
  | { kind: 'ai_suggestion'; suggestionId: string };

export function startPendingSuggestionState(suggestions: readonly MealAiSuggestionResponse[]): PendingSuggestionState {
  return { suggestions: [...suggestions], resolvedIds: new Set() };
}

export function actionableMealAiSuggestions(state: PendingSuggestionState): MealAiSuggestionResponse[] {
  return state.suggestions.filter((suggestion) => !state.resolvedIds.has(suggestion.id));
}

/**
 * Only manual edits change the meal outside the response the assistant saw,
 * so they invalidate every pending action. Applying one current response-local
 * suggestion instead resolves exactly that id and preserves compatible peers.
 */
export function nextPendingSuggestionState(
  current: PendingSuggestionState,
  origin: MealPatchOrigin,
): PendingSuggestionState {
  if (origin.kind === 'manual') return startPendingSuggestionState([]);
  if (!current.suggestions.some((suggestion) => suggestion.id === origin.suggestionId)) return current;
  return {
    suggestions: current.suggestions,
    resolvedIds: new Set([...current.resolvedIds, origin.suggestionId]),
  };
}

type IngredientInput = { key: number; nameZh: string; grams: string };
type DishEditorState = { id: string; nameZh: string; ingredients: IngredientInput[] };
type NutrientEditorState = { nutrient: PresentedMealNutrient; value: string; unit: NutritionUnit };

export type MobileMealEditorProps = {
  /** Used by the new-meal page after an in-page upload. */
  initialDraft?: EditableMealDraft;
  /** Used by tests and future server-rendered callers that already hold a saved response. */
  initialMeal?: EditableMealSaved;
  initialSyncState?: SyncState;
  /** Server-computed saved-meal sync preflight. A saved meal is safe-disabled unless explicitly ready. */
  initialCanSync?: boolean;
  initialSyncReason?: string;
  /** A direct saved-meal visit loads its latest value with an empty browser-only chat. */
  initialMealId?: string;
};

const MEAL_TYPES: Array<{ value: MealType; label: string }> = [
  { value: 'BREAKFAST', label: '早餐' },
  { value: 'LUNCH', label: '午餐' },
  { value: 'DINNER', label: '晚餐' },
  { value: 'SNACK', label: '加餐' },
];

const SYNC_LABELS: Record<SyncState, string> = {
  unsynced: '已保存 · 未同步',
  syncing: '同步中',
  synced: '已同步',
  recovery: '同步恢复中',
};

const SYNC_REASON_MESSAGES: Record<string, string> = {
  no_unsynced_changes: '这餐已是最新同步状态，没有新的本地修改。',
  sync_in_progress: '这餐正在同步中，请稍后刷新确认结果。',
  nutrition_writeback_disabled: '账户尚未开启 Google 营养数据写回。',
  connection_unavailable: 'Google Health 连接当前不可用，请重新连接账户。',
  nutrition_write_scope_missing: 'Google Health 授权缺少营养写入权限，请重新授权。',
  no_google_writable_nutrients: '当前餐食没有可写回 Google Health 的营养字段。',
  sync_generation_unavailable: '同步任务暂时无法恢复，请稍后再试。',
  sync_feature_unavailable: '同步服务暂不可用，请稍后再试。',
};

export function mealEditorEndpoint(endpoint: EditorEndpoint): string {
  switch (endpoint.kind) {
    case 'photo': return '/rhythm/api/meals/photo';
    case 'draft': return `/rhythm/api/meals/drafts/${encodeURIComponent(endpoint.draftId)}`;
    case 'draft_ai': return `/rhythm/api/meals/drafts/${encodeURIComponent(endpoint.draftId)}/ai-suggestions`;
    case 'save_draft': return `/rhythm/api/meals/drafts/${encodeURIComponent(endpoint.draftId)}/save`;
    case 'meal': return `/rhythm/api/meals/${encodeURIComponent(endpoint.mealId)}`;
    case 'meal_ai': return `/rhythm/api/meals/${encodeURIComponent(endpoint.mealId)}/ai-suggestions`;
    case 'sync': return `/rhythm/api/meals/${encodeURIComponent(endpoint.mealId)}/sync`;
  }
}

export function savedMealUrl(mealId: string): string {
  return `/rhythm/meals/${encodeURIComponent(mealId)}`;
}

export function parseEditableNutrientValue(rawValue: string): number | undefined {
  const normalized = rawValue.trim();
  if (!normalized) return undefined;
  const value = Number(normalized);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function convertEditableNutrientUnitValue(
  rawValue: string,
  nutrientCode: string,
  fromUnit: NutritionUnit,
  toUnit: NutritionUnit,
): string {
  const value = parseEditableNutrientValue(rawValue);
  if (value === undefined) return rawValue;
  try {
    const internal = toInternalNutrientAmount(nutrientCode, value, fromUnit);
    return String(fromInternalNutrientAmount(nutrientCode, internal.value, toUnit).value);
  } catch {
    return rawValue;
  }
}

function initialSession(props: MobileMealEditorProps): EditorSession | undefined {
  if (props.initialMeal) {
    return {
      kind: 'saved',
      editor: props.initialMeal,
      syncState: props.initialSyncState ?? 'unsynced',
      canSync: props.initialCanSync ?? false,
      syncReason: props.initialSyncReason,
    };
  }
  return props.initialDraft ? { kind: 'draft', editor: props.initialDraft } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSyncState(value: unknown): value is SyncState {
  return value === 'unsynced' || value === 'syncing' || value === 'synced' || value === 'recovery';
}

function parseDraftResponse(value: unknown): EditableMealDraft | undefined {
  if (!isRecord(value)) return undefined;
  const parsed = editableMealDraftSchema.safeParse(value.draft);
  return parsed.success ? parsed.data : undefined;
}

function parseSavedResponse(value: unknown): { meal: EditableMealSaved; syncState: SyncState; canSync: boolean; syncReason?: string } | undefined {
  if (!isRecord(value) || !isSyncState(value.syncState) || typeof value.canSync !== 'boolean') return undefined;
  if (value.syncReason !== undefined && typeof value.syncReason !== 'string') return undefined;
  const parsed = editableMealSavedSchema.safeParse(value.meal);
  return parsed.success
    ? { meal: parsed.data, syncState: value.syncState, canSync: value.canSync, syncReason: value.syncReason }
    : undefined;
}

function parseError(value: unknown): string {
  if (!isRecord(value)) return '请求未完成，请稍后再试。';
  if (typeof value.reason === 'string') return SYNC_REASON_MESSAGES[value.reason] ?? '当前无法同步这一餐，请稍后再试。';
  if (typeof value.error !== 'string') return '请求未完成，请稍后再试。';
  const messages: Record<string, string> = {
    unauthorized: '登录已失效，请重新登录。',
    not_found: '这餐不存在或你没有访问权限。',
    meal_locked_for_sync: '同步期间不能编辑这餐。',
    invalid_meal_patch: '输入内容不符合要求，请检查后再试。',
    invalid_ai_request: '请输入你想让 AI 帮忙修改的内容。',
    ai_model_unavailable: 'AI 服务暂不可用，请稍后再试。',
    vision_unavailable: '照片识别服务暂不可用，请稍后再试。',
    photo_consent_required: '请先同意将照片发送给 AI 识别。',
    invalid_photo: '这不是可识别的餐食照片，请换一张试试。',
  };
  return messages[value.error] ?? '请求未完成，请稍后再试。';
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function localDateTimeValue(date: Date): string {
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return offsetDate.toISOString().slice(0, 16);
}

function mealTypeLabel(mealType: string): string {
  return MEAL_TYPES.find((type) => type.value === mealType)?.label ?? mealType;
}

export function mealSuggestionPatch(suggestion: MealAiSuggestionResponse): MealPatch {
  if (suggestion.kind === 'replace_ingredients') {
    return {
      kind: 'replace_ingredients',
      dishId: suggestion.dishId,
      nameZh: suggestion.nameZh,
      ingredients: suggestion.ingredients,
    };
  }
  return {
    kind: 'set_nutrient',
    dishId: suggestion.dishId,
    nutrientCode: suggestion.nutrientCode,
    value: suggestion.value,
    unit: suggestion.unit,
  };
}

function dishForEdit(dish: EditableDish, keyStart: number): DishEditorState {
  return {
    id: dish.id,
    nameZh: dish.nameZh,
    ingredients: dish.ingredients.map((ingredient, index) => ({
      key: keyStart + index,
      nameZh: ingredient.nameZh,
      grams: String(ingredient.grams),
    })),
  };
}

export function MobileMealEditor(props: MobileMealEditorProps) {
  const [session, setSession] = useState<EditorSession | undefined>(() => initialSession(props));
  const [file, setFile] = useState<File | undefined>();
  const [previewUrl, setPreviewUrl] = useState<string | undefined>();
  const [mealType, setMealType] = useState<MealType>('LUNCH');
  const [eatenAt, setEatenAt] = useState('');
  const [photoConsent, setPhotoConsent] = useState(false);
  const [loadingSavedMeal, setLoadingSavedMeal] = useState(Boolean(props.initialMealId && !session));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [editingDish, setEditingDish] = useState<DishEditorState | undefined>();
  const [nutrientEditor, setNutrientEditor] = useState<NutrientEditorState | undefined>();
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set(['energy_and_macros']));
  const [aiOpen, setAiOpen] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [suggestionState, setSuggestionState] = useState<PendingSuggestionState>(() => startPendingSuggestionState([]));
  const ingredientKeys = useRef(100);
  const messageIds = useRef(1);
  const dialogTrigger = useRef<HTMLElement | undefined>(undefined);

  useEffect(() => {
    if (eatenAt) return;
    setEatenAt(localDateTimeValue(new Date()));
  }, [eatenAt]);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(undefined);
      return undefined;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (!props.initialMealId || session) return undefined;
    let cancelled = false;
    async function loadMeal() {
      setLoadingSavedMeal(true);
      setError(undefined);
      try {
        const result = await fetch(mealEditorEndpoint({ kind: 'meal', mealId: props.initialMealId! }), { cache: 'no-store' });
        const body = await responseBody(result);
        if (!result.ok) throw new Error(parseError(body));
        const saved = parseSavedResponse(body);
        if (!saved) throw new Error('服务器返回的餐食数据无效。');
        if (!cancelled) setSession({ kind: 'saved', editor: saved.meal, syncState: saved.syncState, canSync: saved.canSync, syncReason: saved.syncReason });
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : '无法加载这餐。');
      } finally {
        if (!cancelled) setLoadingSavedMeal(false);
      }
    }
    void loadMeal();
    return () => { cancelled = true; };
  }, [props.initialMealId, session]);

  const editingLocked = session?.kind === 'saved' && (session.syncState === 'syncing' || session.syncState === 'recovery');
  const groups = useMemo(() => session ? groupMealNutrients(session.editor.nutrients) : [], [session]);
  const pendingSuggestions = suggestionState.suggestions;
  const resolvedSuggestions = suggestionState.resolvedIds;
  const actionableSuggestions = useMemo(() => actionableMealAiSuggestions(suggestionState), [suggestionState]);
  const applyAllState = useMemo(() => mealAiApplyAllState(actionableSuggestions), [actionableSuggestions]);

  function showError(message: string) {
    setNotice(undefined);
    setError(message);
  }

  function clearFeedback() {
    setError(undefined);
    setNotice(undefined);
  }

  function replaceFromPatchResponse(body: unknown): boolean {
    const draft = parseDraftResponse(body);
    if (draft) {
      setSession({ kind: 'draft', editor: draft });
      return true;
    }
    const saved = parseSavedResponse(body);
    if (saved) {
      setSession({ kind: 'saved', editor: saved.meal, syncState: saved.syncState, canSync: saved.canSync, syncReason: saved.syncReason });
      return true;
    }
    showError('服务器返回的餐食数据无效。');
    return false;
  }

  function invalidatePendingSuggestions() {
    setSuggestionState(startPendingSuggestionState([]));
    setSuggestionsOpen(false);
  }

  async function applyPatch(patch: MealPatch, origin: MealPatchOrigin = { kind: 'manual' }): Promise<boolean> {
    if (!session || editingLocked) {
      showError('同步期间不能编辑这餐。');
      return false;
    }
    clearFeedback();
    setBusy(true);
    try {
      const endpoint = session.kind === 'draft'
        ? mealEditorEndpoint({ kind: 'draft', draftId: session.editor.mealId })
        : mealEditorEndpoint({ kind: 'meal', mealId: session.editor.mealId });
      const result = await fetch(endpoint, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = await responseBody(result);
      if (!result.ok) {
        showError(parseError(body));
        return false;
      }
      if (!replaceFromPatchResponse(body)) return false;
      if (origin.kind === 'manual') {
        // A manual change is outside the AI response's input, so all pending
        // actions are stale. An AI action resolves only its response-local id.
        invalidatePendingSuggestions();
      } else {
        setSuggestionState((current) => nextPendingSuggestionState(current, origin));
      }
      setNotice(patch.kind === 'replace_ingredients' ? '这道菜已按食材克数重新计算。' : '该营养项已更新。');
      return true;
    } catch {
      showError('网络连接失败，请稍后重试。');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitPhoto(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !photoConsent || !eatenAt) return;
    clearFeedback();
    setBusy(true);
    try {
      const form = new FormData();
      form.set('photo', file);
      form.set('aiPhotoConsent', 'true');
      form.set('mealType', mealType);
      form.set('eatenAt', new Date(eatenAt).toISOString());
      const result = await fetch(mealEditorEndpoint({ kind: 'photo' }), { method: 'POST', body: form });
      const body = await responseBody(result);
      if (!result.ok) throw new Error(parseError(body));
      const draft = parseDraftResponse(body);
      if (!draft) throw new Error('服务器返回的餐食数据无效。');
      setSession({ kind: 'draft', editor: draft });
      setNotice('识别完成。请先审阅和修改，再保存到本地。');
    } catch (uploadError) {
      showError(uploadError instanceof Error ? uploadError.message : '照片识别未完成，请稍后重试。');
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    if (!session || session.kind !== 'draft') return;
    clearFeedback();
    setBusy(true);
    try {
      const result = await fetch(mealEditorEndpoint({ kind: 'save_draft', draftId: session.editor.mealId }), { method: 'POST' });
      const body = await responseBody(result);
      if (!result.ok) throw new Error(parseError(body));
      const saved = parseSavedResponse(body);
      if (!saved) throw new Error('服务器返回的餐食数据无效。');
      setSession({ kind: 'saved', editor: saved.meal, syncState: saved.syncState, canSync: saved.canSync, syncReason: saved.syncReason });
      setFile(undefined);
      if (typeof window !== 'undefined') window.history.replaceState({}, '', savedMealUrl(saved.meal.mealId));
      setNotice('已保存到本地；只有点击“同步这一餐”才会写入 Google Health。');
    } catch (saveError) {
      showError(saveError instanceof Error ? saveError.message : '保存未完成，请稍后重试。');
    } finally {
      setBusy(false);
    }
  }

  function beginDishEdit(dish: EditableDish, trigger: HTMLElement) {
    if (editingLocked) return;
    dialogTrigger.current = trigger;
    const start = ingredientKeys.current;
    ingredientKeys.current += dish.ingredients.length + 1;
    setEditingDish(dishForEdit(dish, start));
    clearFeedback();
  }

  async function saveDishEdit() {
    if (!editingDish) return;
    const ingredients = editingDish.ingredients.map((ingredient) => ({ nameZh: ingredient.nameZh.trim(), grams: Number(ingredient.grams) }));
    if (!editingDish.nameZh.trim() || ingredients.length === 0 || ingredients.some((ingredient) => !ingredient.nameZh || !Number.isFinite(ingredient.grams) || ingredient.grams <= 0)) {
      showError('每项食材都需要名称和大于 0 的克数。');
      return;
    }
    const applied = await applyPatch({
      kind: 'replace_ingredients',
      dishId: editingDish.id,
      nameZh: editingDish.nameZh.trim(),
      ingredients,
    });
    if (applied) setEditingDish(undefined);
  }

  function beginNutrientEdit(nutrient: PresentedMealNutrient, trigger: HTMLElement) {
    if (editingLocked) return;
    dialogTrigger.current = trigger;
    setNutrientEditor({ nutrient, value: nutrient.displayValue === undefined ? '' : String(nutrient.displayValue), unit: nutrient.displayUnit });
    clearFeedback();
  }

  function changeNutrientUnit(unit: NutritionUnit) {
    if (!nutrientEditor) return;
    const current = nutrientEditor;
    const value = convertEditableNutrientUnitValue(
      current.value,
      current.nutrient.nutrientCode,
      current.unit,
      unit,
    );
    setNutrientEditor({ ...current, unit, value });
  }

  async function saveNutrientEdit() {
    if (!nutrientEditor) return;
    const value = parseEditableNutrientValue(nutrientEditor.value);
    if (value === undefined) {
      showError('请输入有限且不小于 0 的数值。');
      return;
    }
    const applied = await applyPatch({
      kind: 'set_nutrient',
      dishId: nutrientEditor.nutrient.dishId,
      nutrientCode: nutrientEditor.nutrient.nutrientCode,
      value,
      unit: nutrientEditor.unit,
    });
    if (applied) setNutrientEditor(undefined);
  }

  async function submitAiQuestion(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !question.trim()) return;
    clearFeedback();
    const userMessage: Message = { id: messageIds.current++, role: 'user', text: question.trim() };
    setMessages((current) => [...current, userMessage]);
    setQuestion('');
    setBusy(true);
    try {
      const endpoint = session.kind === 'draft'
        ? mealEditorEndpoint({ kind: 'draft_ai', draftId: session.editor.mealId })
        : mealEditorEndpoint({ kind: 'meal_ai', mealId: session.editor.mealId });
      const result = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: userMessage.text }),
      });
      const body = await responseBody(result);
      if (!result.ok) throw new Error(parseError(body));
      const rawSuggestions = isRecord(body) ? body.suggestions : undefined;
      const parsed = mealAiSuggestionResponseSchema.safeParse({ suggestions: rawSuggestions });
      if (!parsed.success) throw new Error('AI 返回的建议无法安全应用，请换一种说法再问。');
      const suggestions = parsed.data.suggestions;
      setSuggestionState(startPendingSuggestionState(suggestions));
      setMessages((current) => [...current, {
        id: messageIds.current++,
        role: 'assistant',
        text: suggestions.length === 0 ? '我没有找到可安全应用的修改建议。' : `我准备了 ${suggestions.length} 条待处理建议。`,
        suggestions,
      }]);
      if (suggestions.length > 0) setSuggestionsOpen(true);
    } catch (aiError) {
      const message = aiError instanceof Error ? aiError.message : 'AI 请求未完成，请稍后重试。';
      setMessages((current) => [...current, { id: messageIds.current++, role: 'error', text: message }]);
    } finally {
      setBusy(false);
    }
  }

  async function applySuggestion(suggestion: MealAiSuggestionResponse) {
    if (resolvedSuggestions.has(suggestion.id)) return;
    await applyPatch(mealSuggestionPatch(suggestion), { kind: 'ai_suggestion', suggestionId: suggestion.id });
  }

  async function applyAllSuggestions() {
    if (applyAllState.disabled) return;
    // Take a response-local snapshot so an explicit Apply all completes this
    // one non-conflicting response in its original order.
    const suggestions = actionableSuggestions;
    for (const suggestion of suggestions) {
      const applied = await applyPatch(mealSuggestionPatch(suggestion), { kind: 'ai_suggestion', suggestionId: suggestion.id });
      if (!applied) return;
    }
  }

  function ignoreSuggestion(id: string) {
    setSuggestionState((current) => nextPendingSuggestionState(current, { kind: 'ai_suggestion', suggestionId: id }));
  }

  async function syncMeal() {
    if (!session || session.kind !== 'saved' || !session.canSync) return;
    clearFeedback();
    setBusy(true);
    try {
      const result = await fetch(mealEditorEndpoint({ kind: 'sync', mealId: session.editor.mealId }), { method: 'POST' });
      const body = await responseBody(result);
      if (!result.ok) throw new Error(parseError(body));
      if (!isRecord(body) || !isSyncState(body.syncState)) throw new Error('服务器返回的同步状态无效。');
      setSession({
        ...session,
        syncState: body.syncState,
        canSync: body.syncState === 'recovery',
        syncReason: body.syncState === 'recovery' ? undefined : 'sync_in_progress',
      });
      setNotice(body.syncState === 'recovery'
        ? '已请求恢复同步状态；系统只会核对已有的远端记录。'
        : '已创建这一餐的同步任务。同步完成后请刷新确认状态。');
    } catch (syncError) {
      showError(syncError instanceof Error ? syncError.message : '无法同步这一餐。');
    } finally {
      setBusy(false);
    }
  }

  if (loadingSavedMeal) {
    return <main className={ui('shell')}><p className={ui('statusText')}>正在加载这餐…</p></main>;
  }

  if (!session) {
    return (
      <main className={`${ui('shell')} ${ui('captureShell')}`}>
        <header className={`${ui('header')} ${ui('captureHeader')}`}>
          <a href="/rhythm" className={ui('backLink')}>返回节律</a>
          <p className={ui('eyebrow')}>节律</p>
          <h1>餐食记录</h1>
          <p className={ui('lede')}>拍照，读懂这一餐</p>
        </header>
        <form id="meal-upload-form" className={`${ui('uploadCard')} ${ui('captureCard')}`} onSubmit={submitPhoto}>
          <label className={`${ui('fileLabel')} ${ui('captureSurface')}`}>
            <Camera aria-hidden="true" focusable="false" size={28} strokeWidth={1.8} />
            <span className={ui('captureSurfaceTitle')}>拍照或上传照片</span>
            <span className={ui('captureSurfaceHint')}>支持 JPG、PNG、WebP</span>
            <input
              aria-label="选择或拍摄餐食照片"
              className={ui('visuallyHidden')}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => setFile(event.target.files?.[0])}
              disabled={busy}
            />
          </label>
          {previewUrl ? (
            <div className={ui('photoPreview')}>
              <img src={previewUrl} alt="待识别的餐食照片预览" />
              <p className={ui('photoOverlay')}>已选择照片</p>
            </div>
          ) : null}
          <div className={ui('fieldGrid')}>
            <label>
              <span>餐次</span>
              <select value={mealType} onChange={(event) => setMealType(event.target.value as MealType)} disabled={busy}>
                {MEAL_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
              </select>
            </label>
            <label>
              <span>进食时间</span>
              <input type="datetime-local" value={eatenAt} onChange={(event) => setEatenAt(event.target.value)} disabled={busy} required />
            </label>
          </div>
          <label className={ui('consent')}>
            <input type="checkbox" checked={photoConsent} onChange={(event) => setPhotoConsent(event.target.checked)} disabled={busy} />
            <span>我同意将这张照片发送给 AI 识别</span>
          </label>
          <p className={ui('photoPrivacy')}>
            <LockKeyhole aria-hidden="true" focusable="false" size={18} strokeWidth={1.8} />
            <span>照片仅用于本次 AI 识别。</span>
          </p>
          <Feedback notice={notice} error={error} />
        </form>
        <div className={`${ui('actionBar')} ${ui('uploadActionBar')}`}>
          <button type="submit" form="meal-upload-form" disabled={!file || !photoConsent || !eatenAt || busy}>{busy ? '正在识别…' : '开始识别'}</button>
        </div>
      </main>
    );
  }

  const editor = session.editor;
  const isDraft = session.kind === 'draft';
  const syncState = session.kind === 'saved' ? session.syncState : undefined;
  const canSync = session.kind === 'saved' && session.canSync;
  const syncReason = session.kind === 'saved' ? session.syncReason : undefined;

  return (
    <main className={ui('shell')}>
      <header className={ui('header')}>
        <a href="/rhythm" className={ui('backLink')}>返回今日</a>
        <div className={ui('titleRow')}>
          <div>
            <p className={ui('eyebrow')}>{isDraft ? '餐食草稿' : '已保存餐食'}</p>
            <h1>{mealTypeLabel(editor.mealType)} · {new Date(editor.eatenAt).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })}</h1>
          </div>
          <p className={ui('syncBadge')} data-state={syncState ?? 'draft'}>{syncState ? SYNC_LABELS[syncState] : '草稿'}</p>
        </div>
        {editingLocked ? <p className={ui('lockNotice')}>编辑已暂停，等待当前同步任务安全结束。</p> : null}
        {isDraft && previewUrl ? <img className={ui('reviewPreview')} src={previewUrl} alt="本次餐食照片预览" /> : null}
      </header>

      <div className={ui('contentGrid')}>
        <section className={ui('mainColumn')}>
          <section className={ui('card')} aria-labelledby="dish-heading">
            <div className={ui('sectionHeading')}>
              <div><p className={ui('eyebrow')}>菜品</p><h2 id="dish-heading">菜品与食材</h2></div>
              <p>{editingLocked ? '同步期间不可编辑' : '改食材会重算整道菜'}</p>
            </div>
            <div className={ui('dishList')}>
              {editor.dishes.map((dish) => (
                <article key={dish.id} className={ui('dishCard')}>
                  <div>
                    <h3>{dish.nameZh}</h3>
                    <p>{dish.ingredients.map((ingredient) => `${ingredient.nameZh} ${ingredient.grams}g`).join(' · ')}</p>
                  </div>
                  <button type="button" className={ui('secondaryButton')} onClick={(event) => beginDishEdit(dish, event.currentTarget)} disabled={busy || editingLocked}>编辑此菜</button>
                </article>
              ))}
            </div>
          </section>

          <section className={ui('card')} aria-labelledby="nutrient-heading">
            <div className={ui('sectionHeading')}>
              <div><p className={ui('eyebrow')}>完整营养</p><h2 id="nutrient-heading">完整营养</h2></div>
              <p>点任一项直接修改</p>
            </div>
            <div className={ui('nutrientGroups')}>
              {groups.map((group) => {
                const expanded = openGroups.has(group.id);
                return (
                  <section key={group.id} className={ui('nutrientGroup')}>
                    <button
                      type="button"
                      className={ui('groupToggle')}
                      aria-expanded={expanded}
                      onClick={() => setOpenGroups((current) => {
                        const next = new Set(current);
                        if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
                        return next;
                      })}
                    >
                      <span>{group.label}</span><span>{group.nutrients.length} 项 {expanded ? '收起' : '展开'}</span>
                    </button>
                    {expanded ? (
                      <ul className={ui('nutrientList')}>
                        {group.nutrients.map((nutrient) => (
                          <li key={`${nutrient.dishId}:${nutrient.nutrientCode}`}>
                            <button
                              type="button"
                              className={ui('nutrientRow')}
                              aria-label={`编辑营养 ${nutrient.label}`}
                              onClick={(event) => beginNutrientEdit(nutrient, event.currentTarget)}
                              disabled={busy || editingLocked}
                            >
                              <span><strong>{nutrient.label}</strong><small>{nutrient.sourceLabel}</small></span>
                              <span>{nutrient.formattedValue}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </section>
                );
              })}
            </div>
          </section>
          <Feedback notice={notice} error={error} />
        </section>

        <aside className={ui('aiColumn')}>
          <section className={ui('aiCard')}>
            <p className={ui('eyebrow')}>AI 助手</p>
            <h2>问 AI 修改这餐</h2>
            <p>AI 只看到这餐当前的结构化数据。建议必须由你查看并应用。</p>
            <button type="button" onClick={(event) => { dialogTrigger.current = event.currentTarget; setAiOpen(true); }} disabled={busy || editingLocked}>问 AI 修改这餐</button>
            {actionableSuggestions.length > 0 ? (
              <button type="button" className={ui('secondaryButton')} onClick={(event) => { dialogTrigger.current = event.currentTarget; setAiOpen(true); setSuggestionsOpen(true); }}>
                查看并应用（{actionableSuggestions.length}）
              </button>
            ) : null}
          </section>
        </aside>
      </div>

      {!isDraft && !canSync && syncReason ? (
        <p className={`${ui('syncNotice')} ${ui('warning')}`} role="status">
          {SYNC_REASON_MESSAGES[syncReason] ?? '当前无法同步这一餐，请稍后再试。'}
        </p>
      ) : null}

      <footer className={ui('actionBar')}>
        {isDraft ? (
          <button type="button" onClick={() => void saveDraft()} disabled={busy}>保存修改</button>
        ) : (
          <p className={ui('localSaveState')}>本地已保存</p>
        )}
        {!isDraft ? (
          <div className={ui('syncAction')}>
            <button
              type="button"
              onClick={() => void syncMeal()}
              disabled={busy || !canSync}
              title={!canSync ? (SYNC_REASON_MESSAGES[syncReason ?? ''] ?? '当前无法同步这一餐') : undefined}
            >
              {syncState === 'recovery' ? '重试这一餐' : '同步这一餐'}
            </button>
          </div>
        ) : null}
      </footer>

      {editingDish ? (
        <AccessibleDialog className={ui('fullScreenDialog')} labelledBy="dish-editor-title" initialFocusSelector={'input[aria-label="食材名称"]'} onRequestClose={() => setEditingDish(undefined)} returnFocusRef={dialogTrigger}>
          <div className={ui('dialogHeader')}><h2 id="dish-editor-title">编辑菜品与食材</h2><button type="button" className={ui('textButton')} onClick={() => setEditingDish(undefined)} disabled={busy}>关闭</button></div>
          <label className={ui('inputLabel')}>菜名<input value={editingDish.nameZh} onChange={(event) => setEditingDish({ ...editingDish, nameZh: event.target.value })} disabled={busy} /></label>
          <div className={ui('ingredientEditor')}>
            <h3>食材与克数</h3>
            {editingDish.ingredients.map((ingredient) => (
              <div key={ingredient.key} className={ui('ingredientRow')}>
                <input aria-label="食材名称" value={ingredient.nameZh} onChange={(event) => setEditingDish({ ...editingDish, ingredients: editingDish.ingredients.map((row) => row.key === ingredient.key ? { ...row, nameZh: event.target.value } : row) })} disabled={busy} />
                <label><input aria-label="食材克数" type="number" min="0" step="any" inputMode="decimal" value={ingredient.grams} onChange={(event) => setEditingDish({ ...editingDish, ingredients: editingDish.ingredients.map((row) => row.key === ingredient.key ? { ...row, grams: event.target.value } : row) })} disabled={busy} /><span>g</span></label>
                <button type="button" className={ui('textButton')} onClick={() => setEditingDish({ ...editingDish, ingredients: editingDish.ingredients.filter((row) => row.key !== ingredient.key) })} disabled={busy || editingDish.ingredients.length === 1}>删除</button>
              </div>
            ))}
          </div>
          <button type="button" className={ui('secondaryButton')} onClick={() => setEditingDish({ ...editingDish, ingredients: [...editingDish.ingredients, { key: ingredientKeys.current++, nameZh: '', grams: '' }] })} disabled={busy}>添加食材</button>
          <p className={ui('dialogHint')}>保存后会重新计算这道菜的全部营养，原来的单项营养修改会被替换。</p>
          <div className={ui('dialogActions')}><button type="button" className={ui('secondaryButton')} onClick={() => setEditingDish(undefined)} disabled={busy}>取消</button><button type="button" onClick={() => void saveDishEdit()} disabled={busy}>重新计算这道菜</button></div>
        </AccessibleDialog>
      ) : null}

      {nutrientEditor ? (
        <AccessibleDialog className={ui('bottomSheet')} labelledBy="nutrient-editor-title" initialFocusSelector={'input[type="number"]'} onRequestClose={() => setNutrientEditor(undefined)} returnFocusRef={dialogTrigger}>
          <div className={ui('dialogHeader')}><h2 id="nutrient-editor-title">编辑营养</h2><button type="button" className={ui('textButton')} onClick={() => setNutrientEditor(undefined)} disabled={busy}>关闭</button></div>
          <p className={ui('nutrientEditName')}>{nutrientEditor.nutrient.label}</p>
          <div className={ui('nutrientEditControls')}>
            <label className={ui('inputLabel')}>数值<input type="number" min="0" step="any" inputMode="decimal" value={nutrientEditor.value} onChange={(event) => setNutrientEditor({ ...nutrientEditor, value: event.target.value })} disabled={busy} /></label>
            <label className={ui('inputLabel')}>单位<select value={nutrientEditor.unit} onChange={(event) => changeNutrientUnit(event.target.value as NutritionUnit)} disabled={busy}>{editableNutrientUnits(nutrientEditor.nutrient.nutrientCode).map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select></label>
          </div>
          <p className={ui('dialogHint')}>只覆盖这一项，其他营养不会改变。</p>
          <button type="button" onClick={() => void saveNutrientEdit()} disabled={busy}>保存这一项</button>
        </AccessibleDialog>
      ) : null}

      {aiOpen ? (
        <AccessibleDialog className={ui('bottomSheet')} labelledBy="ai-editor-title" initialFocusSelector="textarea" onRequestClose={() => setAiOpen(false)} returnFocusRef={dialogTrigger}>
          <div className={ui('dialogHeader')}><h2 id="ai-editor-title">问 AI 修改这餐</h2><button type="button" className={ui('textButton')} onClick={() => setAiOpen(false)} disabled={busy}>关闭</button></div>
          {!suggestionsOpen ? (
            <>
              <div className={ui('messages')} aria-live="polite">
                {messages.length === 0 ? <p>可以描述你想改的食材、份量或某个营养数值。</p> : messages.map((message) => <p key={message.id} data-role={message.role}><strong>{message.role === 'user' ? '你' : message.role === 'assistant' ? 'AI' : '提示'}：</strong>{message.text}</p>)}
              </div>
              {actionableSuggestions.length > 0 ? <button type="button" className={ui('secondaryButton')} onClick={() => setSuggestionsOpen(true)}>查看并应用（{actionableSuggestions.length}）</button> : null}
              <form className={ui('aiForm')} onSubmit={submitAiQuestion}>
                <label className={ui('inputLabel')}>你的问题<textarea value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={2000} placeholder="例如：把鸡胸肉改成 150g，重新计算这道菜" disabled={busy} /></label>
                <button type="submit" disabled={busy || !question.trim()}>{busy ? '正在请求…' : '发送给 AI'}</button>
              </form>
            </>
          ) : (
            <>
              <div className={ui('dialogHeader')}><h3>待处理建议（{actionableSuggestions.length}）</h3><button type="button" className={ui('textButton')} onClick={() => setSuggestionsOpen(false)} disabled={busy}>继续对话</button></div>
              {applyAllState.disabled ? <p className={ui('warning')}>{applyAllState.message}</p> : <button type="button" className={ui('secondaryButton')} onClick={() => void applyAllSuggestions()} disabled={busy || actionableSuggestions.length === 0}>应用全部</button>}
              <ol className={ui('suggestionList')}>
              {pendingSuggestions.map((suggestion) => {
                  const done = resolvedSuggestions.has(suggestion.id);
                  return <li key={suggestion.id}><p>{suggestion.summary}</p><p className={ui('suggestionImpact')}>{suggestion.kind === 'replace_ingredients' ? '应用后重新计算这道菜全部营养。' : '应用后只修改这一项。'}</p><div><button type="button" onClick={() => void applySuggestion(suggestion)} disabled={busy || done}>{done ? '已处理' : '应用这一条'}</button><button type="button" className={ui('textButton')} onClick={() => ignoreSuggestion(suggestion.id)} disabled={busy || done}>忽略</button></div></li>;
                })}
              </ol>
            </>
          )}
        </AccessibleDialog>
      ) : null}
    </main>
  );
}

function Feedback({ notice, error }: { notice?: string; error?: string }) {
  if (!notice && !error) return null;
  return <p className={error ? ui('error') : ui('notice')} role={error ? 'alert' : 'status'}>{error ?? notice}</p>;
}

/**
 * Opens a real native modal and returns its one-time teardown. Keeping the
 * lifecycle here makes the keyboard/focus contract unit-testable without
 * introducing a browser-only test dependency into this project.
 */
export function openAccessibleDialog(
  dialog: HTMLDialogElement,
  initialFocusSelector: string,
  onRequestClose: () => void,
  returnFocus?: Pick<HTMLElement, 'focus'>,
): () => void {
  const onCancel = (event: Event) => {
    event.preventDefault();
    onRequestClose();
  };
  dialog.addEventListener('cancel', onCancel);
  if (!dialog.open) dialog.showModal();
  const target = dialog.querySelector<HTMLElement>(initialFocusSelector);
  (target ?? dialog).focus();
  return () => {
    dialog.removeEventListener('cancel', onCancel);
    if (dialog.open) dialog.close();
    returnFocus?.focus();
  };
}

function AccessibleDialog({
  children,
  className,
  labelledBy,
  initialFocusSelector,
  onRequestClose,
  returnFocusRef,
}: {
  children: ReactNode;
  className: string;
  labelledBy: string;
  initialFocusSelector: string;
  onRequestClose: () => void;
  returnFocusRef: MutableRefObject<HTMLElement | undefined>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const onRequestCloseRef = useRef(onRequestClose);
  onRequestCloseRef.current = onRequestClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const returnFocus = returnFocusRef.current;
    return openAccessibleDialog(dialog, initialFocusSelector, () => onRequestCloseRef.current(), returnFocus);
  }, [initialFocusSelector, returnFocusRef]);

  return <dialog ref={dialogRef} className={className} aria-modal="true" aria-labelledby={labelledBy}>{children}</dialog>;
}
