import { randomUUID } from 'node:crypto';

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
import type { CurrentMealSnapshot, MealType } from './types';
import type { TwFdaFoodCatalog } from '../nutrition/tw-fda';
import { mealPatchSchema, type EditableMealDraft, type EditableMealSaved, type MealPatch } from '../../domain/meal-editor';

const MAX_MULTIPART_BYTES = 4 * 1024 * 1024 + 64 * 1024;
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

async function catalogForUser(userId: string, deps: MealHttpDeps): Promise<ConfirmCatalog | undefined> {
  try {
    return await (deps.catalogForUser?.(userId) ?? defaultCatalogForUser(userId, deps));
  } catch {
    return undefined;
  }
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

function currentMealResponse(snapshot: CurrentMealSnapshot, status = 200): Response {
  return response({ meal: savedEditor(snapshot), syncState: snapshot.syncState }, status);
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

async function requestPatch(request: Request): Promise<MealPatch | undefined> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return undefined;
  }
  const parsed = mealPatchSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

async function requestQuestion(request: Request): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return undefined;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'question') return undefined;
  const question = (body as { question?: unknown }).question;
  return typeof question === 'string' && question.trim().length > 0 && question.length <= 2_000 ? question.trim() : undefined;
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
  const resolvedCatalog = await catalogForUser(userId, deps);
  if (!resolvedCatalog) return response({ error: 'nutrition_catalog_unavailable' }, 502);
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
    return response({ error: 'nutrition_catalog_unavailable' }, 502);
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

  const patch = await requestPatch(request);
  if (!patch) return response({ error: 'invalid_meal_patch' }, 400);
  const resolvedCatalog = patch.kind === 'replace_ingredients' ? await catalogForUser(userId, deps) : undefined;
  if (patch.kind === 'replace_ingredients' && !resolvedCatalog) return response({ error: 'nutrition_catalog_unavailable' }, 502);
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
  } catch {
    return response({ error: 'invalid_meal_patch' }, 400);
  }
}

/** Backwards-compatible server handler name for the GET/PATCH draft route. */
export const handleMealDraft = handleCurrentMealDraft;

export async function handleCurrentMealDraftSave(request: Request, draftId: string, deps: MealHttpDeps): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const session = await requireSession(request, deps, true);
  if (isResponse(session)) return session;
  try {
    const saved = await deps.store.withTransaction((store) => store.currentMeals.saveEditorDraft({
      userId: session,
      draftId,
      now: nowFor(deps),
    }));
    return currentMealResponse(saved, 201);
  } catch {
    return response({ error: 'not_found' }, 404);
  }
}

export async function handleCurrentMeal(request: Request, mealId: string, deps: MealHttpDeps): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'PATCH') return methodNotAllowed('GET, PATCH');
  const session = await requireSession(request, deps, request.method === 'PATCH');
  if (isResponse(session)) return session;
  const userId = session;
  const current = await deps.store.currentMeals.findCurrentMeal(userId, mealId);
  if (!current) return response({ error: 'not_found' }, 404);
  if (request.method === 'GET') return currentMealResponse(current);
  if (current.syncState === 'syncing' || current.syncState === 'recovery') {
    return response({ error: 'meal_locked_for_sync', reason: 'sync_in_progress' }, 409);
  }

  const patch = await requestPatch(request);
  if (!patch) return response({ error: 'invalid_meal_patch' }, 400);
  try {
    let updated: CurrentMealSnapshot | undefined;
    if (patch.kind === 'replace_ingredients') {
      const resolvedCatalog = await catalogForUser(userId, deps);
      if (!resolvedCatalog) return response({ error: 'nutrition_catalog_unavailable' }, 502);
      const editor = await replaceDishIngredients(draftEditor(current), patch, resolvedCatalog.catalog);
      updated = await deps.store.currentMeals.replaceCurrentMealContent({ userId, mealId, editor, now: nowFor(deps) });
    } else {
      updated = await deps.store.currentMeals.setCurrentMealNutrient({
        userId,
        mealId,
        dishId: patch.dishId,
        nutrientCode: patch.nutrientCode,
        value: patch.value,
        unit: patch.unit,
        now: nowFor(deps),
      });
    }
    return updated ? currentMealResponse(updated) : response({ error: 'not_found' }, 404);
  } catch {
    return response({ error: 'invalid_meal_patch' }, 400);
  }
}

async function handleAiSuggestions(
  request: Request,
  meal: EditableMealDraft | EditableMealSaved,
  userId: string,
  deps: MealHttpDeps,
): Promise<Response> {
  if (!deps.config.deepseekApiKey) return response({ error: 'ai_model_unavailable' }, 503);
  const question = await requestQuestion(request);
  if (!question) return response({ error: 'invalid_ai_request' }, 400);
  const resolvedCatalog = await catalogForUser(userId, deps);
  if (!resolvedCatalog) return response({ error: 'nutrition_catalog_unavailable' }, 502);
  try {
    const suggestions = await suggestMealEdits({
      apiKey: deps.config.deepseekApiKey,
      question,
      meal,
      catalog: resolvedCatalog.catalog,
      client: deps.assistant,
    });
    return response({ suggestions });
  } catch (error) {
    if (error instanceof MealAssistantError) return response({ error: error.code }, 502);
    return response({ error: 'ai_response_invalid' }, 502);
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
  if (!await deps.store.users.nutritionWritebackEnabled(session)) return syncNotReady('nutrition_writeback_disabled');
  const connection = await deps.store.connections.findByUserId(session);
  if (!connection || !syncable(connection.status)) return syncNotReady('connection_unavailable');
  if (!canWriteNutrition(connection.grantedScopes)) return syncNotReady('nutrition_write_scope_missing');
  if (googlePayloadProjection(draftEditor(current)).nutrients.length === 0) return syncNotReady('no_google_writable_nutrients');
  if (current.syncState === 'syncing') return syncNotReady('sync_in_progress');
  if (current.syncState === 'recovery') return syncNotReady('sync_recovery_required');
  if (!deps.store.mealSync) return syncNotReady('sync_feature_unavailable');
  const generation = await deps.store.mealSync.startGeneration({ mealId, userId: session, now: nowFor(deps) });
  if (!generation) return syncNotReady('sync_generation_unavailable');
  return response({ mealId, syncState: 'syncing' }, 202);
}

export async function handleMealConfirm(request: Request, draftId: string, deps: MealHttpDeps): Promise<Response> {
  void draftId;
  void deps;
  if (request.method !== 'POST') return methodNotAllowed('POST');
  return response({ error: 'meal_confirm_replaced' }, 410);
}
