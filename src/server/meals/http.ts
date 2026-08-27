import { randomUUID } from 'node:crypto';

import { ZodError } from 'zod';

import { checkPostOrigin } from '../auth/http';
import { readCookie, SESSION_COOKIE } from '../auth/cookies';
import { readSessionUserId } from '../auth/oauth-service';
import { canWriteNutrition } from '../auth/scopes';
import type { AuthStore } from '../auth/types';
import type { OAuthConfig } from '../config/env';

import { recognizeMealPhoto, type VisionClient } from './deepseek-vision';
import { ingestMealPhoto } from './photo-ingest';
import { draftFromVision, googlePayloadProjection, replaceDishIngredients, setDishNutrient } from './current-meal';
import { MealAssistantError, suggestMealEdits, type MealAssistantClient } from './meal-assistant';
import { CurrentMealEditLockedError, type CurrentMealSnapshot, type MealType } from './types';
import type { TwFdaFoodCatalog } from '../nutrition/tw-fda';
import { mealPatchSchema, type EditableMealDraft, type EditableMealSaved, type MealPatch } from '../../domain/meal-editor';

const MAX_MULTIPART_BYTES = 4 * 1024 * 1024 + 64 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const MEAL_TYPES = new Set<MealType>(['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK']);

export type MealHttpDeps = {
  config: OAuthConfig;
  store: AuthStore;
  vision?: VisionClient;
  assistant?: MealAssistantClient;
  now?: () => Date;
  catalogForUser?: (userId: string) => Promise<ConfirmCatalog>;
};

type ConfirmCatalog = {
  catalog: TwFdaFoodCatalog;
  canWriteNutrition: boolean;
  connectionSyncable: boolean;
};

function response(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function serviceUnavailable(): Response {
  return response({ error: 'service_unavailable' }, 503);
}

function methodNotAllowed(allow: string): Response {
  return new Response(null, { status: 405, headers: { Allow: allow, 'Cache-Control': 'no-store' } });
}

async function sessionUserId(request: Request, deps: MealHttpDeps): Promise<string | undefined> {
  return readSessionUserId(deps.store, readCookie(request.headers.get('Cookie'), SESSION_COOKIE), deps.now?.());
}

function syncable(status: string): boolean {
  return status === 'active' || status === 'partial';
}

async function defaultCatalogForUser(userId: string, deps: MealHttpDeps): Promise<ConfirmCatalog> {
  const connection = await deps.store.connections.findByUserId(userId);
  return {
    catalog: { findExact: (nameZh) => deps.store.foodComposition.findExactFood(nameZh) },
    canWriteNutrition: Boolean(connection && syncable(connection.status) && canWriteNutrition(connection.grantedScopes)),
    connectionSyncable: Boolean(connection && syncable(connection.status)),
  };
}

async function catalogForUser(userId: string, deps: MealHttpDeps): Promise<ConfirmCatalog> {
  return deps.catalogForUser?.(userId) ?? defaultCatalogForUser(userId, deps);
}

function nowFor(deps: MealHttpDeps): Date {
  return deps.now?.() ?? new Date();
}

function draftResponse(draft: EditableMealDraft, status = 200): Response {
  return response({ draft }, status);
}

function savedEditor(snapshot: CurrentMealSnapshot): EditableMealSaved {
  return {
    view: 'saved',
    mealId: snapshot.id,
    mealType: snapshot.mealType,
    eatenAt: snapshot.eatenAt.toISOString(),
    savedAt: snapshot.updatedAt.toISOString(),
    dishes: structuredClone(snapshot.dishes),
    nutrients: structuredClone(snapshot.nutrients),
  };
}

function draftEditor(snapshot: CurrentMealSnapshot): EditableMealDraft {
  return {
    view: 'draft',
    mealId: snapshot.id,
    mealType: snapshot.mealType,
    eatenAt: snapshot.eatenAt.toISOString(),
    dishes: structuredClone(snapshot.dishes),
    nutrients: structuredClone(snapshot.nutrients),
  };
}

type CurrentMealSyncReadiness =
  | { canSync: true }
  | { canSync: false; syncReason: string };

async function writebackReadiness(userId: string, snapshot: CurrentMealSnapshot, deps: MealHttpDeps): Promise<CurrentMealSyncReadiness> {
  if (!await deps.store.users.nutritionWritebackEnabled(userId)) {
    return { canSync: false, syncReason: 'nutrition_writeback_disabled' };
  }
  const connection = await deps.store.connections.findByUserId(userId);
  if (!connection || !syncable(connection.status)) {
    return { canSync: false, syncReason: 'connection_unavailable' };
  }
  if (!canWriteNutrition(connection.grantedScopes)) {
    return { canSync: false, syncReason: 'nutrition_write_scope_missing' };
  }
  if (googlePayloadProjection(draftEditor(snapshot)).nutrients.length === 0) {
    return { canSync: false, syncReason: 'no_google_writable_nutrients' };
  }
  return { canSync: true };
}

/**
 * This read-only preflight mirrors the sync handler's state gates. It never
 * starts a generation, so the UI can disable an impossible action without
 * creating a hidden write path.
 */
async function currentMealSyncReadiness(
  userId: string,
  snapshot: CurrentMealSnapshot,
  deps: MealHttpDeps,
): Promise<CurrentMealSyncReadiness> {
  const mealSync = deps.store.mealSync;
  if (!mealSync) return { canSync: false, syncReason: 'sync_feature_unavailable' };
  if (snapshot.syncState === 'synced') return { canSync: false, syncReason: 'no_unsynced_changes' };
  if (snapshot.syncState === 'syncing') return { canSync: false, syncReason: 'sync_in_progress' };
  if (snapshot.syncState === 'recovery') {
    const state = await mealSync.readGenerationState({ mealId: snapshot.id, userId });
    if (!state) return { canSync: false, syncReason: 'sync_generation_unavailable' };
    // Exact-name recovery is safe even if normal writeback prerequisites are
    // currently unavailable: it does not send a fresh create/delete request.
    if (state.hasUnknownPoint) return { canSync: true };
  }
  return writebackReadiness(userId, snapshot, deps);
}

async function currentMealResponse(
  snapshot: CurrentMealSnapshot,
  userId: string,
  deps: MealHttpDeps,
  status = 200,
): Promise<Response> {
  const readiness = await currentMealSyncReadiness(userId, snapshot, deps);
  return response({ meal: savedEditor(snapshot), syncState: snapshot.syncState, ...readiness }, status);
}

async function requireSession(request: Request, deps: MealHttpDeps, write = false): Promise<string | Response> {
  if (write) {
    const originError = checkPostOrigin(request, deps.config);
    if (originError) return response({ error: originError }, 403);
  }
  const userId = await sessionUserId(request, deps);
  return userId ?? response({ error: 'unauthorized' }, 401);
}

function isResponse(value: string | Response): value is Response {
  return value instanceof Response;
}

type BoundedJsonResult =
  | { kind: 'ok'; body: unknown }
  | { kind: 'invalid' }
  | { kind: 'too_large' };

async function readBoundedJson(request: Request): Promise<BoundedJsonResult> {
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    return { kind: 'too_large' };
  }
  if (!request.body) return { kind: 'invalid' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_JSON_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The body has already crossed the limit; cancellation failure does
          // not make it safe to continue buffering it.
        }
        return { kind: 'too_large' };
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { kind: 'ok', body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { kind: 'invalid' };
  }
}

async function requestPatch(request: Request): Promise<
  | { kind: 'ok'; patch: MealPatch }
  | { kind: 'invalid' }
  | { kind: 'too_large' }
> {
  const parsedJson = await readBoundedJson(request);
  if (parsedJson.kind !== 'ok') return parsedJson;
  const parsed = mealPatchSchema.safeParse(parsedJson.body);
  return parsed.success ? { kind: 'ok', patch: parsed.data } : { kind: 'invalid' };
}

async function requestQuestion(request: Request): Promise<
  | { kind: 'ok'; question: string }
  | { kind: 'invalid' }
  | { kind: 'too_large' }
> {
  const parsedJson = await readBoundedJson(request);
  if (parsedJson.kind !== 'ok') return parsedJson;
  const body = parsedJson.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'invalid' };
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'question') return { kind: 'invalid' };
  const question = (body as { question?: unknown }).question;
  return typeof question === 'string' && question.trim().length > 0 && question.length <= 2_000
    ? { kind: 'ok', question: question.trim() }
    : { kind: 'invalid' };
}

function isKnownMealPatchError(error: unknown): boolean {
  if (error instanceof ZodError) return true;
  if (!(error instanceof Error)) return false;
  return error.message.startsWith('unknown dish:')
    || error.message.startsWith('unknown nutrient:')
    || error.message === 'ENERGY must use kcal'
    || error.message === 'non-ENERGY nutrients must use a mass unit';
}

function isMissingEditorDraftError(error: unknown): boolean {
  return error instanceof Error && error.message === 'editor draft not found';
}

function parseMealType(value: FormDataEntryValue | null): MealType | undefined {
  if (typeof value !== 'string' || !MEAL_TYPES.has(value as MealType)) {
    return undefined;
  }
  return value as MealType;
}

function parseEatenAt(value: FormDataEntryValue | null): Date | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

async function fileBytes(value: FormDataEntryValue | null): Promise<Buffer | undefined> {
  if (!value || typeof value === 'string' || typeof (value as Blob).arrayBuffer !== 'function') {
    return undefined;
  }
  return Buffer.from(await (value as Blob).arrayBuffer());
}

export async function handleMealPhoto(request: Request, deps: MealHttpDeps): Promise<Response> {
  if (request.method !== 'POST') {
    return methodNotAllowed('POST');
  }
  const session = await requireSession(request, deps, true);
  if (isResponse(session)) return session;
  const userId = session;
  if (!deps.config.deepseekApiKey) {
    return response({ error: 'vision_unavailable' }, 503);
  }
  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BYTES) {
    return response({ error: 'photo_too_large' }, 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return response({ error: 'invalid_photo_request' }, 400);
  }
  if (form.get('aiPhotoConsent') !== 'true') {
    return response({ error: 'photo_consent_required' }, 400);
  }
  const mealType = parseMealType(form.get('mealType'));
  const eatenAt = parseEatenAt(form.get('eatenAt'));
  const bytes = await fileBytes(form.get('photo'));
  if (!mealType || !eatenAt || !bytes) {
    return response({ error: 'invalid_photo_request' }, 400);
  }

  let vision;
  try {
    const photo = await ingestMealPhoto(bytes);
    vision = await recognizeMealPhoto(photo, deps.config.deepseekApiKey, deps.vision);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.startsWith('photo ')) {
      return response({ error: 'invalid_photo' }, 400);
    }
    return response({ error: 'vision_unavailable' }, 502);
  }
  let resolvedCatalog: ConfirmCatalog;
  try {
    resolvedCatalog = await catalogForUser(userId, deps);
  } catch {
    return serviceUnavailable();
  }
  try {
    const draftId = randomUUID();
    const editor = await draftFromVision({
      mealId: draftId,
      mealType,
      eatenAt: eatenAt.toISOString(),
      vision,
    }, resolvedCatalog.catalog);
    const draft = await deps.store.currentMeals.insertEditorDraft({
      id: draftId,
      userId,
      mealType,
      eatenAt,
      vision,
      editor,
      now: nowFor(deps),
    });
    return draftResponse(draft, 201);
  } catch {
    return serviceUnavailable();
  }
}

export async function handleCurrentMealDraft(request: Request, draftId: string, deps: MealHttpDeps): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'PATCH') return methodNotAllowed('GET, PATCH');
  const session = await requireSession(request, deps, request.method === 'PATCH');
  if (isResponse(session)) return session;
  const userId = session;
  if (request.method === 'GET') {
    const draft = await deps.store.currentMeals.findEditorDraft(userId, draftId);
    return draft ? draftResponse(draft) : response({ error: 'not_found' }, 404);
  }

  const parsedPatch = await requestPatch(request);
  if (parsedPatch.kind === 'too_large') return response({ error: 'request_too_large' }, 413);
  if (parsedPatch.kind === 'invalid') return response({ error: 'invalid_meal_patch' }, 400);
  const patch = parsedPatch.patch;
  let resolvedCatalog: ConfirmCatalog | undefined;
  if (patch.kind === 'replace_ingredients') {
    try {
      resolvedCatalog = await catalogForUser(userId, deps);
    } catch {
      return serviceUnavailable();
    }
  }
  try {
    const updated = await deps.store.withTransaction(async (store) => {
      const draft = await store.currentMeals.findEditorDraft(userId, draftId);
      if (!draft) return undefined;
      const editor = patch.kind === 'replace_ingredients'
        ? await replaceDishIngredients(draft, patch, resolvedCatalog!.catalog)
        : setDishNutrient(draft, patch);
      return store.currentMeals.replaceEditorDraft({ userId, id: draftId, editor, now: nowFor(deps) });
    });
    return updated ? draftResponse(updated) : response({ error: 'not_found' }, 404);
  } catch (error) {
    return isKnownMealPatchError(error) ? response({ error: 'invalid_meal_patch' }, 400) : serviceUnavailable();
  }
}

/** Backwards-compatible server handler name for the GET/PATCH draft route. */
export const handleMealDraft = handleCurrentMealDraft;

export async function handleCurrentMealDraftSave(request: Request, draftId: string, deps: MealHttpDeps): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const session = await requireSession(request, deps, true);
  if (isResponse(session)) return session;
  try {
    const saved = await deps.store.withTransaction(async (store) => {
      const draft = await store.currentMeals.findEditorDraft(session, draftId);
      if (!draft) return undefined;
      return store.currentMeals.saveEditorDraft({ userId: session, draftId, now: nowFor(deps) });
    });
    return saved ? await currentMealResponse(saved, session, deps, 201) : response({ error: 'not_found' }, 404);
  } catch (error) {
    return isMissingEditorDraftError(error) ? response({ error: 'not_found' }, 404) : serviceUnavailable();
  }
}

export async function handleCurrentMeal(request: Request, mealId: string, deps: MealHttpDeps): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'PATCH') return methodNotAllowed('GET, PATCH');
  const session = await requireSession(request, deps, request.method === 'PATCH');
  if (isResponse(session)) return session;
  const userId = session;
  if (request.method === 'GET') {
    try {
      const current = await deps.store.currentMeals.findCurrentMeal(userId, mealId);
      return current ? await currentMealResponse(current, userId, deps) : response({ error: 'not_found' }, 404);
    } catch {
      return serviceUnavailable();
    }
  }

  const parsedPatch = await requestPatch(request);
  if (parsedPatch.kind === 'too_large') return response({ error: 'request_too_large' }, 413);
  if (parsedPatch.kind === 'invalid') return response({ error: 'invalid_meal_patch' }, 400);
  const patch = parsedPatch.patch;
  let resolvedCatalog: ConfirmCatalog | undefined;
  if (patch.kind === 'replace_ingredients') {
    try {
      resolvedCatalog = await catalogForUser(userId, deps);
    } catch {
      return serviceUnavailable();
    }
  }
  try {
    const updated = await deps.store.withTransaction(async (store) => {
      const current = await store.currentMeals.lockCurrentMealForEdit(userId, mealId);
      if (!current) return undefined;
      if (current.syncState === 'syncing' || current.syncState === 'recovery') throw new CurrentMealEditLockedError();
      if (patch.kind === 'replace_ingredients') {
        const editor = await replaceDishIngredients(draftEditor(current), patch, resolvedCatalog!.catalog);
        return store.currentMeals.replaceCurrentMealContent({ userId, mealId, editor, now: nowFor(deps) });
      }
      return store.currentMeals.setCurrentMealNutrient({
        userId,
        mealId,
        dishId: patch.dishId,
        nutrientCode: patch.nutrientCode,
        value: patch.value,
        unit: patch.unit,
        now: nowFor(deps),
      });
    });
    return updated ? await currentMealResponse(updated, userId, deps) : response({ error: 'not_found' }, 404);
  } catch (error) {
    if (error instanceof CurrentMealEditLockedError) {
      return response({ error: 'meal_locked_for_sync', reason: 'sync_in_progress' }, 409);
    }
    return isKnownMealPatchError(error) ? response({ error: 'invalid_meal_patch' }, 400) : serviceUnavailable();
  }
}

async function handleAiSuggestions(
  request: Request,
  meal: EditableMealDraft | EditableMealSaved,
  userId: string,
  deps: MealHttpDeps,
): Promise<Response> {
  if (!deps.config.deepseekApiKey) return response({ error: 'ai_model_unavailable' }, 503);
  const parsedQuestion = await requestQuestion(request);
  if (parsedQuestion.kind === 'too_large') return response({ error: 'request_too_large' }, 413);
  if (parsedQuestion.kind === 'invalid') return response({ error: 'invalid_ai_request' }, 400);
  let resolvedCatalog: ConfirmCatalog;
  try {
    resolvedCatalog = await catalogForUser(userId, deps);
  } catch {
    return serviceUnavailable();
  }
  try {
    const suggestions = await suggestMealEdits({
      apiKey: deps.config.deepseekApiKey,
      question: parsedQuestion.question,
      meal,
      catalog: resolvedCatalog.catalog,
      client: deps.assistant,
    });
    return response({ suggestions });
  } catch (error) {
    if (error instanceof MealAssistantError) return response({ error: error.code }, 502);
    return serviceUnavailable();
  }
}

export async function handleCurrentMealDraftAiSuggestions(request: Request, draftId: string, deps: MealHttpDeps): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const session = await requireSession(request, deps, true);
  if (isResponse(session)) return session;
  const draft = await deps.store.currentMeals.findEditorDraft(session, draftId);
  if (!draft) return response({ error: 'not_found' }, 404);
  return handleAiSuggestions(request, draft, session, deps);
}

export async function handleCurrentMealAiSuggestions(request: Request, mealId: string, deps: MealHttpDeps): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const session = await requireSession(request, deps, true);
  if (isResponse(session)) return session;
  const current = await deps.store.currentMeals.findCurrentMeal(session, mealId);
  if (!current) return response({ error: 'not_found' }, 404);
  return handleAiSuggestions(request, savedEditor(current), session, deps);
}

function syncNotReady(reason: string): Response {
  return response({ error: 'meal_sync_not_ready', reason }, 409);
}

export async function handleCurrentMealSync(request: Request, mealId: string, deps: MealHttpDeps): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const session = await requireSession(request, deps, true);
  if (isResponse(session)) return session;
  const current = await deps.store.currentMeals.findCurrentMeal(session, mealId);
  if (!current) return response({ error: 'not_found' }, 404);
  const mealSync = deps.store.mealSync;
  if (!mealSync) return syncNotReady('sync_feature_unavailable');
  if (current.syncState === 'synced') return syncNotReady('no_unsynced_changes');
  if (current.syncState === 'syncing') return syncNotReady('sync_in_progress');
  if (current.syncState === 'recovery') {
    const state = await mealSync.readGenerationState({ mealId, userId: session });
    if (!state) return syncNotReady('sync_generation_unavailable');
    if (state.hasUnknownPoint) {
      const generation = await mealSync.beginRecovery({
        mealId,
        userId: session,
        now: nowFor(deps),
        reason: 'unknown_exact_get',
      });
      return generation ? response({ mealId, syncState: 'recovery' }, 202) : syncNotReady('sync_generation_unavailable');
    }
    if (!await deps.store.users.nutritionWritebackEnabled(session)) return syncNotReady('nutrition_writeback_disabled');
    const connection = await deps.store.connections.findByUserId(session);
    if (!connection || !syncable(connection.status)) return syncNotReady('connection_unavailable');
    if (!canWriteNutrition(connection.grantedScopes)) return syncNotReady('nutrition_write_scope_missing');
    const generation = await mealSync.beginRecovery({
      mealId,
      userId: session,
      now: nowFor(deps),
      reason: 'writeback_prerequisites_restored',
    });
    return generation ? response({ mealId, syncState: generation.phase === 'recovery' ? 'recovery' : 'syncing' }, 202) : syncNotReady('sync_generation_unavailable');
  }
  if (!await deps.store.users.nutritionWritebackEnabled(session)) return syncNotReady('nutrition_writeback_disabled');
  const connection = await deps.store.connections.findByUserId(session);
  if (!connection || !syncable(connection.status)) return syncNotReady('connection_unavailable');
  if (!canWriteNutrition(connection.grantedScopes)) return syncNotReady('nutrition_write_scope_missing');
  if (googlePayloadProjection(draftEditor(current)).nutrients.length === 0) return syncNotReady('no_google_writable_nutrients');
  const generation = await mealSync.startGeneration({ mealId, userId: session, now: nowFor(deps) });
  if (!generation) return syncNotReady('sync_generation_unavailable');
  return response({ mealId, syncState: 'syncing' }, 202);
}

export async function handleMealConfirm(request: Request, draftId: string, deps: MealHttpDeps): Promise<Response> {
  void draftId;
  void deps;
  if (request.method !== 'POST') return methodNotAllowed('POST');
  return response({ error: 'meal_confirm_replaced' }, 410);
}
