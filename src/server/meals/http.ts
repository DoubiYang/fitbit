import { checkPostOrigin } from '../auth/http';
import { readCookie, SESSION_COOKIE } from '../auth/cookies';
import { readSessionUserId } from '../auth/oauth-service';
import { canWriteNutrition } from '../auth/scopes';
import type { AuthStore } from '../auth/types';
import type { OAuthConfig } from '../config/env';
import { createGoogleTokenRefresher, resolveAccessToken } from '../health/access-token';

import { estimateDish } from './nutrition-resolver';
import { recognizeMealPhoto, type VisionClient } from './deepseek-vision';
import { createGoogleFoodCatalog, type GoogleFoodCatalog } from './google-food';
import { ingestMealPhoto } from './photo-ingest';
import type { MealType } from './types';

const MAX_MULTIPART_BYTES = 4 * 1024 * 1024 + 64 * 1024;
const MEAL_TYPES = new Set<MealType>(['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK']);

export type MealHttpDeps = {
  config: OAuthConfig;
  store: AuthStore;
  vision?: VisionClient;
  now?: () => Date;
  catalogForUser?: (userId: string) => Promise<ConfirmCatalog>;
};

type ConfirmCatalog = {
  catalog: GoogleFoodCatalog | undefined;
  canWriteNutrition: boolean;
  connectionSyncable: boolean;
};

function response(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function sessionUserId(request: Request, deps: MealHttpDeps): Promise<string | undefined> {
  return readSessionUserId(deps.store, readCookie(request.headers.get('Cookie'), SESSION_COOKIE), deps.now?.());
}

function syncable(status: string): boolean {
  return status === 'active' || status === 'partial';
}

async function defaultCatalogForUser(userId: string, deps: MealHttpDeps): Promise<ConfirmCatalog> {
  const connection = await deps.store.connections.findByUserId(userId);
  if (!connection || !syncable(connection.status)) {
    return { catalog: undefined, canWriteNutrition: false, connectionSyncable: false };
  }
  const accessToken = await resolveAccessToken({
    config: deps.config,
    store: deps.store,
    connection,
    refresher: createGoogleTokenRefresher(deps.config),
    now: deps.now?.(),
  });
  return {
    catalog: createGoogleFoodCatalog(accessToken),
    canWriteNutrition: canWriteNutrition(connection.grantedScopes),
    connectionSyncable: true,
  };
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
    return new Response(null, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } });
  }
  const originError = checkPostOrigin(request, deps.config);
  if (originError) {
    return response({ error: originError }, 403);
  }
  const userId = await sessionUserId(request, deps);
  if (!userId) {
    return response({ error: 'unauthorized' }, 401);
  }
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

  try {
    const photo = ingestMealPhoto(bytes);
    const vision = await recognizeMealPhoto(photo, deps.config.deepseekApiKey, deps.vision);
    const draft = await deps.store.meals.insertDraft({ userId, mealType, eatenAt, vision, now: deps.now?.() ?? new Date() });
    return response(
      {
        draftId: draft.id,
        mealType: draft.mealType,
        eatenAt: draft.eatenAt.toISOString(),
        foods: draft.vision.foods,
        estimates: draft.vision.foods.map((dish) => estimateDish(dish)),
      },
      201,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.startsWith('photo ')) {
      return response({ error: 'invalid_photo' }, 400);
    }
    return response({ error: 'vision_unavailable' }, 502);
  }
}

export async function handleMealDraft(request: Request, draftId: string, deps: MealHttpDeps): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response(null, { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'no-store' } });
  }
  const userId = await sessionUserId(request, deps);
  if (!userId) {
    return response({ error: 'unauthorized' }, 401);
  }
  const draft = await deps.store.meals.findDraft(userId, draftId);
  if (!draft) {
    return response({ error: 'not_found' }, 404);
  }
  return response({
    draftId: draft.id,
    mealType: draft.mealType,
    eatenAt: draft.eatenAt.toISOString(),
    foods: draft.vision.foods,
    estimates: draft.vision.foods.map((dish) => estimateDish(dish)),
  });
}

export async function handleMealConfirm(request: Request, draftId: string, deps: MealHttpDeps): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } });
  }
  const originError = checkPostOrigin(request, deps.config);
  if (originError) {
    return response({ error: originError }, 403);
  }
  const userId = await sessionUserId(request, deps);
  if (!userId) {
    return response({ error: 'unauthorized' }, 401);
  }
  let body: { writebackThisMeal?: unknown };
  try {
    body = (await request.json()) as { writebackThisMeal?: unknown };
  } catch {
    return response({ error: 'invalid_confirm_request' }, 400);
  }
  if (typeof body.writebackThisMeal !== 'boolean') {
    return response({ error: 'invalid_confirm_request' }, 400);
  }
  let catalog: ConfirmCatalog;
  try {
    catalog = await (deps.catalogForUser?.(userId) ?? defaultCatalogForUser(userId, deps));
  } catch {
    return response({ error: 'nutrition_catalog_unavailable' }, 502);
  }
  try {
    const result = await deps.store.meals.confirmDraft({
      userId,
      draftId,
      writebackThisMeal: body.writebackThisMeal,
      canWriteNutrition: catalog.canWriteNutrition,
      connectionSyncable: catalog.connectionSyncable,
      catalog: catalog.catalog,
      now: deps.now?.() ?? new Date(),
    });
    if (!result.ok) {
      return response({ error: 'meal_not_ready', reason: result.reason }, 400);
    }
    return response({
      version: result.version,
      dishes: result.dishes,
      nutrients: result.nutrients,
      outbox: result.outbox,
    });
  } catch {
    return response({ error: 'nutrition_catalog_unavailable' }, 502);
  }
}
