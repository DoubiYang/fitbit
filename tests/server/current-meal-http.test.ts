import assert from 'node:assert/strict';
import test from 'node:test';

import { completeGoogleOAuth, startGoogleOAuth } from '../../src/server/auth/oauth-service';
import { REQUESTED_SCOPES } from '../../src/server/auth/scopes';
import type { AuthStore, GoogleOAuthClient, MealSyncStore } from '../../src/server/auth/types';
import { loadConfig, type OAuthConfig } from '../../src/server/config/env';
import { createMemoryStore } from '../../src/server/db/memory-store';
import {
  handleCurrentMeal,
  handleCurrentMealAiSuggestions,
  handleCurrentMealDraft,
  handleCurrentMealDraftAiSuggestions,
  handleCurrentMealDraftSave,
  handleCurrentMealSync,
} from '../../src/server/meals/http';
import { MealAssistantError, type MealAssistantClient } from '../../src/server/meals/meal-assistant';
import type { TwFdaFoodCatalog } from '../../src/server/nutrition/tw-fda';

const now = new Date('2026-08-27T12:00:00.000Z');
const encryptionKey = Buffer.alloc(32, 8).toString('base64');

function config(): OAuthConfig {
  const loaded = loadConfig({
    DATABASE_URL: 'postgresql://rhythm:x@db:5432/rhythm',
    GOOGLE_HEALTH_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_HEALTH_CLIENT_SECRET: 'client-secret',
    TOKEN_ENCRYPTION_KEY: encryptionKey,
    SYNC_SECRET: 'test-sync-secret',
    APP_ORIGIN: 'http://localhost:3000',
    DEEPSEEK_APIKEY: 'server-only-key',
  });
  assert.equal(loaded.kind, 'oauth');
  if (loaded.kind !== 'oauth') throw new Error('expected oauth config');
  return loaded;
}

function google(): GoogleOAuthClient {
  return {
    async exchangeCode() {
      return {
        accessToken: 'access-token', refreshToken: 'refresh-token',
        expiresAt: new Date('2026-08-27T13:00:00.000Z'), refreshExpiresAt: undefined,
        grantedScopes: [...REQUESTED_SCOPES],
      };
    },
    async getIdentity() { return { healthUserId: 'health-user', legacyUserId: undefined }; },
    async revoke() {},
  };
}

async function signedInStore() {
  const store = createMemoryStore();
  const started = await startGoogleOAuth({ config: config(), store, now });
  assert.equal(started.kind, 'redirect');
  if (started.kind !== 'redirect') throw new Error('expected oauth redirect');
  const completed = await completeGoogleOAuth({
    config: config(), store, google: google(),
    query: { code: 'code', state: new URL(started.url).searchParams.get('state') ?? undefined },
    transactionId: started.transactionId, now,
  });
  assert.ok(completed.sessionToken && completed.userId);
  return { store, sessionToken: completed.sessionToken!, userId: completed.userId! };
}

const catalog: TwFdaFoodCatalog = {
  async findExact(nameZh) {
    if (nameZh !== '西兰花' && nameZh !== '鸡胸肉') return undefined;
    return {
      sourceRevision: 'fda-test-sha', officialFoodId: nameZh === '西兰花' ? 'BROCCOLI' : 'CHICKEN', nameZh, aliases: [],
      nutrients: [
        { officialName: '熱量', rawUnit: 'kcal', per100gValue: 34 },
        { officialName: '粗蛋白', rawUnit: 'g', per100gValue: 2.8 },
        { officialName: '維生素C', rawUnit: 'mg', per100gValue: 89.4 },
      ],
    };
  },
};

const vision = {
  foods: [{
    nameZh: '西兰花', ingredients: ['西兰花'], portionGrams: 100, visibleFraction: 'full' as const,
    confidence: 0.9, needsConfirmation: [], eatFraction: 1, barcode: null, labelText: null,
  }],
  photoQuality: 'usable' as const,
  globalUncertainties: ['only for the raw vision record'],
};

function headers(sessionToken: string, json = false): HeadersInit {
  return {
    Origin: 'http://localhost:3000', Cookie: `rhythm_session=${sessionToken}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function insertDraft() {
  const signedIn = await signedInStore();
  const draft = await signedIn.store.currentMeals.insertEditorDraft({
    id: 'draft-1', userId: signedIn.userId, mealType: 'LUNCH', eatenAt: now, vision,
    editor: {
      view: 'draft', mealId: 'draft-1', mealType: 'LUNCH', eatenAt: now.toISOString(),
      dishes: [{
        id: 'dish-1', nameZh: '西兰花', portionGrams: 100,
        ingredients: [{ nameZh: '西兰花', grams: 100, foodSource: 'tw_fda', foodSourceId: 'BROCCOLI', foodSourceVersion: 'fda-test-sha' }],
      }],
      nutrients: [
        { dishId: 'dish-1', nutrientCode: 'ENERGY', value: 34, unit: 'kcal', source: 'tw_fda' },
        { dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 2.8, unit: 'g', source: 'tw_fda' },
        { dishId: 'dish-1', nutrientCode: 'VITAMIN_C', value: 0.0894, unit: 'g', source: 'tw_fda' },
      ],
    }, now,
  });
  return { ...signedIn, draft };
}

function deps(store: AuthStore, assistant?: MealAssistantClient) {
  return {
    config: config(), store, now: () => now,
    catalogForUser: async () => ({ catalog, canWriteNutrition: true, connectionSyncable: true }),
    assistant,
  };
}

test('draft PATCH recalculates every nutrient for ingredients but replaces only one direct nutrient', async () => {
  const input = await insertDraft();
  const ingredientResponse = await handleCurrentMealDraft(
    new Request('http://localhost:3000/rhythm/api/meals/drafts/draft-1', {
      method: 'PATCH', headers: headers(input.sessionToken, true),
      body: JSON.stringify({ kind: 'replace_ingredients', dishId: 'dish-1', nameZh: '鸡胸肉', ingredients: [{ nameZh: '鸡胸肉', grams: 50 }] }),
    }), 'draft-1', deps(input.store),
  );
  assert.equal(ingredientResponse.status, 200);
  const afterIngredients = (await ingredientResponse.json()) as { draft: { nutrients: Array<{ nutrientCode: string; value: number }> } };
  assert.deepEqual(afterIngredients.draft.nutrients.map(({ nutrientCode, value }) => ({ nutrientCode, value })), [
    { nutrientCode: 'ENERGY', value: 17 }, { nutrientCode: 'PROTEIN', value: 1.4 }, { nutrientCode: 'VITAMIN_C', value: 0.044700000000000004 },
  ]);

  const nutrientResponse = await handleCurrentMealDraft(
    new Request('http://localhost:3000/rhythm/api/meals/drafts/draft-1', {
      method: 'PATCH', headers: headers(input.sessionToken, true),
      body: JSON.stringify({ kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 9000, unit: 'mg' }),
    }), 'draft-1', deps(input.store),
  );
  assert.equal(nutrientResponse.status, 200);
  const afterNutrient = (await nutrientResponse.json()) as { draft: { nutrients: Array<{ nutrientCode: string; value: number; source: string }> } };
  assert.deepEqual(afterNutrient.draft.nutrients, [
    { dishId: 'dish-1', nutrientCode: 'ENERGY', value: 17, unit: 'kcal', source: 'tw_fda' },
    { dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 9, unit: 'g', source: 'user_edit' },
    { dishId: 'dish-1', nutrientCode: 'VITAMIN_C', value: 0.044700000000000004, unit: 'g', source: 'tw_fda' },
  ]);
});

test('draft PATCH reports a transaction outage as a safe 503 instead of invalid user input', async () => {
  const input = await insertDraft();
  const unavailableStore: AuthStore = {
    ...input.store,
    async withTransaction() { throw new Error('database connection reset'); },
  };

  const response = await handleCurrentMealDraft(
    new Request('http://localhost:3000/rhythm/api/meals/drafts/draft-1', {
      method: 'PATCH', headers: headers(input.sessionToken, true),
      body: JSON.stringify({ kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 10, unit: 'g' }),
    }), 'draft-1', deps(unavailableStore),
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'service_unavailable' });
});

test('draft ingredient PATCH reports a catalog outage as a safe 503', async () => {
  const input = await insertDraft();
  const response = await handleCurrentMealDraft(
    new Request('http://localhost:3000/rhythm/api/meals/drafts/draft-1', {
      method: 'PATCH', headers: headers(input.sessionToken, true),
      body: JSON.stringify({ kind: 'replace_ingredients', dishId: 'dish-1', nameZh: '鸡胸肉', ingredients: [{ nameZh: '鸡胸肉', grams: 50 }] }),
    }),
    'draft-1',
    { ...deps(input.store), catalogForUser: async () => { throw new Error('catalog database unavailable'); } },
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'service_unavailable' });
});

test('draft PATCH rejects a declared oversized JSON body before parsing it', async () => {
  const input = await insertDraft();
  const response = await handleCurrentMealDraft(
    new Request('http://localhost:3000/rhythm/api/meals/drafts/draft-1', {
      method: 'PATCH',
      headers: { ...headers(input.sessionToken, true), 'Content-Length': '70000' },
      body: JSON.stringify({ kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 10, unit: 'g' }),
    }), 'draft-1', deps(input.store),
  );

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'request_too_large' });
});

test('draft PATCH stops counting an oversized JSON stream without a Content-Length declaration', async () => {
  const input = await insertDraft();
  const body = `${JSON.stringify({ kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 10, unit: 'g' })}${' '.repeat(70_000)}`;
  const request = new Request('http://localhost:3000/rhythm/api/meals/drafts/draft-1', {
    method: 'PATCH', headers: headers(input.sessionToken, true), body,
  });
  assert.equal(request.headers.get('Content-Length'), null);

  const response = await handleCurrentMealDraft(request, 'draft-1', deps(input.store));

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'request_too_large' });
});

test('saving a draft writes only the current meal snapshot and saved edits become unsynced', async () => {
  const input = await insertDraft();
  const savedResponse = await handleCurrentMealDraftSave(
    new Request('http://localhost:3000/rhythm/api/meals/drafts/draft-1/save', { method: 'POST', headers: headers(input.sessionToken) }),
    'draft-1', deps(input.store),
  );
  assert.equal(savedResponse.status, 201);
  assert.deepEqual(input.store.outboxRows(), []);
  assert.deepEqual(input.store.mealSyncPoints(), []);
  const saved = await savedResponse.json() as { meal: { mealId: string }; syncState: string };
  assert.equal(saved.meal.mealId, 'draft-1');
  assert.equal(saved.syncState, 'unsynced');

  const response = await handleCurrentMeal(
    new Request('http://localhost:3000/rhythm/api/meals/draft-1', {
      method: 'PATCH', headers: headers(input.sessionToken, true),
      body: JSON.stringify({ kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 10, unit: 'g' }),
    }), 'draft-1', deps(input.store),
  );
  assert.equal(response.status, 200);
  const body = await response.json() as { meal: { nutrients: Array<{ nutrientCode: string; value: number }> }; syncState: string };
  assert.equal(body.syncState, 'unsynced');
  assert.equal(body.meal.nutrients.find((nutrient) => nutrient.nutrientCode === 'PROTEIN')?.value, 10);
});

test('saved GET and PATCH expose the server-computed single-meal sync preflight', async () => {
  const input = await insertDraft();
  await input.store.currentMeals.saveEditorDraft({ userId: input.userId, draftId: 'draft-1', now });

  const blockedRead = await handleCurrentMeal(
    new Request('http://localhost:3000/rhythm/api/meals/draft-1', { headers: headers(input.sessionToken) }),
    'draft-1', deps(input.store),
  );
  assert.equal(blockedRead.status, 200);
  assert.deepEqual(await blockedRead.json(), {
    meal: {
      view: 'saved', mealId: 'draft-1', mealType: 'LUNCH', eatenAt: now.toISOString(), savedAt: now.toISOString(),
      dishes: input.draft.dishes, nutrients: input.draft.nutrients,
    },
    syncState: 'unsynced',
    canSync: false,
    syncReason: 'nutrition_writeback_disabled',
  });

  await input.store.users.setNutritionWritebackEnabled(input.userId, true);
  const eligiblePatch = await handleCurrentMeal(
    new Request('http://localhost:3000/rhythm/api/meals/draft-1', {
      method: 'PATCH', headers: headers(input.sessionToken, true),
      body: JSON.stringify({ kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 10, unit: 'g' }),
    }), 'draft-1', deps(input.store),
  );
  assert.equal(eligiblePatch.status, 200);
  const body = await eligiblePatch.json() as { canSync?: unknown; syncReason?: unknown; syncState: string };
  assert.equal(body.syncState, 'unsynced');
  assert.equal(body.canSync, true);
  assert.equal(body.syncReason, undefined);
});

test('a post-commit sync-readiness failure keeps draft save and saved PATCH successful but safely disables sync', async () => {
  const input = await insertDraft();
  const preflightUnavailableStore: AuthStore = {
    ...input.store,
    users: {
      ...input.store.users,
      async nutritionWritebackEnabled() { throw new Error('read replica unavailable'); },
    },
  };

  const saved = await handleCurrentMealDraftSave(
    new Request('http://localhost:3000/rhythm/api/meals/drafts/draft-1/save', { method: 'POST', headers: headers(input.sessionToken) }),
    'draft-1', deps(preflightUnavailableStore),
  );
  assert.equal(saved.status, 201);
  assert.deepEqual(await saved.json(), {
    meal: {
      view: 'saved', mealId: 'draft-1', mealType: 'LUNCH', eatenAt: now.toISOString(), savedAt: now.toISOString(),
      dishes: input.draft.dishes, nutrients: input.draft.nutrients,
    },
    syncState: 'unsynced',
    canSync: false,
    syncReason: 'sync_feature_unavailable',
  });

  const patched = await handleCurrentMeal(
    new Request('http://localhost:3000/rhythm/api/meals/draft-1', {
      method: 'PATCH', headers: headers(input.sessionToken, true),
      body: JSON.stringify({ kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 10, unit: 'g' }),
    }), 'draft-1', deps(preflightUnavailableStore),
  );
  assert.equal(patched.status, 200);
  const body = await patched.json() as { meal: { nutrients: Array<{ nutrientCode: string; value: number }> }; canSync: boolean; syncReason?: string };
  assert.equal(body.meal.nutrients.find((nutrient) => nutrient.nutrientCode === 'PROTEIN')?.value, 10);
  assert.equal(body.canSync, false);
  assert.equal(body.syncReason, 'sync_feature_unavailable');

  const read = await handleCurrentMeal(
    new Request('http://localhost:3000/rhythm/api/meals/draft-1', { headers: headers(input.sessionToken) }),
    'draft-1', deps(preflightUnavailableStore),
  );
  assert.equal(read.status, 503);
  assert.deepEqual(await read.json(), { error: 'service_unavailable' });
});

test('draft save distinguishes a missing draft from a transaction outage', async () => {
  const input = await insertDraft();
  const unavailableStore: AuthStore = {
    ...input.store,
    async withTransaction() { throw new Error('database connection reset'); },
  };

  const response = await handleCurrentMealDraftSave(
    new Request('http://localhost:3000/rhythm/api/meals/drafts/draft-1/save', { method: 'POST', headers: headers(input.sessionToken) }),
    'draft-1', deps(unavailableStore),
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'service_unavailable' });
});

test('saved PATCH reports a transaction outage as a safe 503', async () => {
  const input = await insertDraft();
  await input.store.currentMeals.saveEditorDraft({ userId: input.userId, draftId: 'draft-1', now });
  const unavailableStore: AuthStore = {
    ...input.store,
    async withTransaction() { throw new Error('database connection reset'); },
  };

  const response = await handleCurrentMeal(
    new Request('http://localhost:3000/rhythm/api/meals/draft-1', {
      method: 'PATCH', headers: headers(input.sessionToken, true),
      body: JSON.stringify({ kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 10, unit: 'g' }),
    }), 'draft-1', deps(unavailableStore),
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'service_unavailable' });
});

test('AI suggestion routes receive only the current structured meal and never persist suggestions', async () => {
  const input = await insertDraft();
  const received: Array<Record<string, unknown>> = [];
  const assistant: MealAssistantClient = {
    async complete(request) {
      received.push(request as unknown as Record<string, unknown>);
      return JSON.stringify({ suggestions: [{ kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 10, unit: 'g' }] });
    },
  };
  const draftResponse = await handleCurrentMealDraftAiSuggestions(
    new Request('http://localhost:3000/rhythm/api/meals/drafts/draft-1/ai-suggestions', {
      method: 'POST', headers: headers(input.sessionToken, true), body: JSON.stringify({ question: '蛋白质改成 10g' }),
    }), 'draft-1', deps(input.store, assistant),
  );
  assert.equal(draftResponse.status, 200);
  assert.deepEqual((await draftResponse.json() as { suggestions: unknown[] }).suggestions.length, 1);
  assert.equal(received[0]?.apiKey, 'server-only-key');
  assert.equal(JSON.stringify((received[0] as { meal?: unknown }).meal).includes('globalUncertainties'), false);
  assert.equal((await input.store.currentMeals.findEditorDraft(input.userId, 'draft-1'))?.nutrients.find((nutrient) => nutrient.nutrientCode === 'PROTEIN')?.value, 2.8);

  await input.store.currentMeals.saveEditorDraft({ userId: input.userId, draftId: 'draft-1', now });
  const savedResponse = await handleCurrentMealAiSuggestions(
    new Request('http://localhost:3000/rhythm/api/meals/draft-1/ai-suggestions', {
      method: 'POST', headers: headers(input.sessionToken, true), body: JSON.stringify({ question: '再给一个建议' }),
    }), 'draft-1', deps(input.store, assistant),
  );
  assert.equal(savedResponse.status, 200);
  assert.equal(received.length, 2);
});

test('AI suggestion requests reject an oversized declared JSON body before invoking the model', async () => {
  const input = await insertDraft();
  let calls = 0;
  const assistant: MealAssistantClient = {
    async complete() {
      calls += 1;
      return JSON.stringify({ suggestions: [{ kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 10, unit: 'g' }] });
    },
  };
  const response = await handleCurrentMealDraftAiSuggestions(
    new Request('http://localhost:3000/rhythm/api/meals/drafts/draft-1/ai-suggestions', {
      method: 'POST',
      headers: { ...headers(input.sessionToken, true), 'Content-Length': '70000' },
      body: JSON.stringify({ question: '给我一个建议' }),
    }), 'draft-1', deps(input.store, assistant),
  );

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'request_too_large' });
  assert.equal(calls, 0);
});

test('AI routes preserve known model errors but report catalog lookup outages as safe 503 responses', async () => {
  const input = await insertDraft();
  const unavailableModel = await handleCurrentMealDraftAiSuggestions(
    new Request('http://localhost:3000/rhythm/api/meals/drafts/draft-1/ai-suggestions', {
      method: 'POST', headers: headers(input.sessionToken, true), body: JSON.stringify({ question: '给我一个建议' }),
    }),
    'draft-1',
    deps(input.store, { async complete() { throw new MealAssistantError('ai_model_unavailable'); } }),
  );
  assert.equal(unavailableModel.status, 502);
  assert.deepEqual(await unavailableModel.json(), { error: 'ai_model_unavailable' });

  const catalogOutage = await handleCurrentMealDraftAiSuggestions(
    new Request('http://localhost:3000/rhythm/api/meals/drafts/draft-1/ai-suggestions', {
      method: 'POST', headers: headers(input.sessionToken, true), body: JSON.stringify({ question: '换成鸡胸肉' }),
    }),
    'draft-1',
    {
      ...deps(input.store, {
        async complete() {
          return JSON.stringify({ suggestions: [{ kind: 'replace_ingredients', dishId: 'dish-1', nameZh: '鸡胸肉', ingredients: [{ nameZh: '鸡胸肉', grams: 50 }] }] });
        },
      }),
      catalogForUser: async () => ({
        catalog: { async findExact() { throw new Error('catalog lookup connection reset'); } },
        canWriteNutrition: true,
        connectionSyncable: true,
      }),
    },
  );
  assert.equal(catalogOutage.status, 503);
  assert.deepEqual(await catalogOutage.json(), { error: 'service_unavailable' });
});

test('writes require origin and ownership, and saved edits are locked while sync state is active', async () => {
  const input = await insertDraft();
  const unauthenticated = await handleCurrentMealDraft(
    new Request('http://localhost:3000/rhythm/api/meals/drafts/draft-1'), 'draft-1', deps(input.store),
  );
  assert.equal(unauthenticated.status, 401);
  const malformed = await handleCurrentMealDraft(
    new Request('http://localhost:3000/rhythm/api/meals/drafts/draft-1', {
      method: 'PATCH', headers: headers(input.sessionToken, true),
      body: JSON.stringify({ kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 10, unit: 'g', extra: 'rejected' }),
    }), 'draft-1', deps(input.store),
  );
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'invalid_meal_patch' });
  const foreignOrigin = await handleCurrentMealDraft(
    new Request('http://localhost:3000/rhythm/api/meals/drafts/draft-1', {
      method: 'PATCH', headers: { ...headers(input.sessionToken, true), Origin: 'https://attacker.example' },
      body: JSON.stringify({ kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 10, unit: 'g' }),
    }), 'draft-1', deps(input.store),
  );
  assert.equal(foreignOrigin.status, 403);
  await input.store.users.insert('other-user');
  await input.store.currentMeals.insertEditorDraft({
    id: 'other-draft', userId: 'other-user', mealType: 'LUNCH', eatenAt: now, vision,
    editor: { ...input.draft, mealId: 'other-draft' }, now,
  });
  const otherUsersDraft = await handleCurrentMealDraft(
    new Request('http://localhost:3000/rhythm/api/meals/drafts/other-draft', { headers: headers(input.sessionToken) }),
    'other-draft', deps(input.store),
  );
  assert.equal(otherUsersDraft.status, 404);

  await input.store.currentMeals.saveEditorDraft({ userId: input.userId, draftId: 'draft-1', now });
  const lockedStore: AuthStore = {
    ...input.store,
    async withTransaction(fn) {
      const transactionStore: AuthStore = {
        ...input.store,
        currentMeals: {
          ...input.store.currentMeals,
          async lockCurrentMealForEdit(userId, mealId) {
            const value = await input.store.currentMeals.findCurrentMeal(userId, mealId);
            return value ? { ...value, syncState: 'syncing' } : undefined;
          },
        },
      };
      return fn(transactionStore);
    },
  };
  const locked = await handleCurrentMeal(
    new Request('http://localhost:3000/rhythm/api/meals/draft-1', {
      method: 'PATCH', headers: headers(input.sessionToken, true),
      body: JSON.stringify({ kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 10, unit: 'g' }),
    }), 'draft-1', deps(lockedStore),
  );
  assert.equal(locked.status, 409);
  assert.deepEqual(await locked.json(), { error: 'meal_locked_for_sync', reason: 'sync_in_progress' });
});

test('a generation that activates after the initial read rejects the saved edit without reverting it to unsynced', async () => {
  const input = await insertDraft();
  await input.store.currentMeals.saveEditorDraft({ userId: input.userId, draftId: 'draft-1', now });
  let persisted = (await input.store.currentMeals.findCurrentMeal(input.userId, 'draft-1'))!;
  let attemptedMutation = false;
  const currentMeals = {
    ...input.store.currentMeals,
    async findCurrentMeal(userId: string, mealId: string) {
      return userId === input.userId && mealId === 'draft-1' ? structuredClone(persisted) : undefined;
    },
    async lockCurrentMealForEdit(userId: string, mealId: string) {
      return userId === input.userId && mealId === 'draft-1' ? structuredClone(persisted) : undefined;
    },
    async setCurrentMealNutrient() {
      attemptedMutation = true;
      persisted = { ...persisted, syncState: 'unsynced' };
      return structuredClone(persisted);
    },
  };
  const activeGenerationStore: AuthStore = {
    ...input.store,
    currentMeals,
    async withTransaction(fn) {
      persisted = { ...persisted, syncState: 'syncing' };
      return fn({ ...input.store, currentMeals });
    },
  };

  const response = await handleCurrentMeal(
    new Request('http://localhost:3000/rhythm/api/meals/draft-1', {
      method: 'PATCH', headers: headers(input.sessionToken, true),
      body: JSON.stringify({ kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 10, unit: 'g' }),
    }), 'draft-1', deps(activeGenerationStore),
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'meal_locked_for_sync', reason: 'sync_in_progress' });
  assert.equal(attemptedMutation, false);
  assert.equal(persisted.syncState, 'syncing');
  assert.equal(persisted.nutrients.find((nutrient) => nutrient.nutrientCode === 'PROTEIN')?.value, 2.8);
});

test('sync enforces writeback preconditions and only accepts a single locally saved meal', async () => {
  const input = await insertDraft();
  await input.store.currentMeals.saveEditorDraft({ userId: input.userId, draftId: 'draft-1', now });
  const disabled = await handleCurrentMealSync(
    new Request('http://localhost:3000/rhythm/api/meals/draft-1/sync', { method: 'POST', headers: headers(input.sessionToken) }),
    'draft-1', deps(input.store),
  );
  assert.equal(disabled.status, 409);
  assert.deepEqual(await disabled.json(), { error: 'meal_sync_not_ready', reason: 'nutrition_writeback_disabled' });

  await input.store.users.setNutritionWritebackEnabled(input.userId, true);
  const noWritableContent = await input.store.currentMeals.replaceCurrentMealContent({
    userId: input.userId,
    mealId: 'draft-1',
    editor: {
      view: 'draft', mealId: 'draft-1', mealType: 'LUNCH', eatenAt: now.toISOString(),
      dishes: input.draft.dishes,
      nutrients: [{ dishId: 'dish-1', nutrientCode: 'LOCAL_ONLY_NUTRIENT', value: 1, unit: 'g', source: 'user_edit' }],
    },
    now,
  });
  assert.ok(noWritableContent);
  const noWritable = await handleCurrentMealSync(
    new Request('http://localhost:3000/rhythm/api/meals/draft-1/sync', { method: 'POST', headers: headers(input.sessionToken) }),
    'draft-1', deps(input.store),
  );
  assert.equal(noWritable.status, 409);
  assert.deepEqual(await noWritable.json(), { error: 'meal_sync_not_ready', reason: 'no_google_writable_nutrients' });
  await input.store.currentMeals.replaceCurrentMealContent({
    userId: input.userId,
    mealId: 'draft-1',
    editor: input.draft,
    now,
  });
  let startCalls = 0;
  const sync: MealSyncStore = {
    async startGeneration({ mealId, userId }) {
      startCalls += 1;
      assert.equal(mealId, 'draft-1');
      assert.equal(userId, input.userId);
      return { id: 'generation-1', mealId, userId, contentRevision: 1, phase: 'pending_create', createdAt: now, updatedAt: now };
    },
    async beginRecovery() { throw new Error('not expected'); },
    async claimDuePoints() { return []; },
    async renewPointLease() { return false; },
    async finishPoint() { return false; },
    async retryPoint() { return false; },
    async markPointUnknown() { return false; },
    async markPointFailedActionRequired() { return false; },
    async markPointOperationPending() { return false; },
    async requestUnknownRecovery() { return false; },
    async readGenerationState() { return undefined; },
  };
  const syncStore: AuthStore = { ...input.store, mealSync: sync };
  const accepted = await handleCurrentMealSync(
    new Request('http://localhost:3000/rhythm/api/meals/draft-1/sync', { method: 'POST', headers: headers(input.sessionToken) }),
    'draft-1', deps(syncStore),
  );
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { mealId: 'draft-1', syncState: 'syncing' });
  assert.equal(startCalls, 1);

  let syncedStartCalls = 0;
  const alreadySyncedStore: AuthStore = {
    ...input.store,
    currentMeals: {
      ...input.store.currentMeals,
      async findCurrentMeal(userId, mealId) {
        const current = await input.store.currentMeals.findCurrentMeal(userId, mealId);
        return current ? { ...current, syncState: 'synced' } : undefined;
      },
    },
    mealSync: {
      ...sync,
      async startGeneration() {
        syncedStartCalls += 1;
        return undefined;
      },
    },
  };
  const alreadySynced = await handleCurrentMealSync(
    new Request('http://localhost:3000/rhythm/api/meals/draft-1/sync', { method: 'POST', headers: headers(input.sessionToken) }),
    'draft-1', deps(alreadySyncedStore),
  );
  assert.equal(alreadySynced.status, 409);
  assert.deepEqual(await alreadySynced.json(), { error: 'meal_sync_not_ready', reason: 'no_unsynced_changes' });
  assert.equal(syncedStartCalls, 0);
});

test('sync recovery requests only exact-name recovery before checking writeback prerequisites', async () => {
  const input = await insertDraft();
  await input.store.currentMeals.saveEditorDraft({ userId: input.userId, draftId: 'draft-1', now });
  let beginCalls = 0;
  const recoverySync: MealSyncStore = {
    async startGeneration() { throw new Error('must not create a generation during recovery'); },
    async beginRecovery({ mealId, userId, reason }) {
      beginCalls += 1;
      assert.equal(mealId, 'draft-1');
      assert.equal(userId, input.userId);
      assert.equal(reason, 'unknown_exact_get');
      return { id: 'generation-1', mealId, userId, contentRevision: 1, phase: 'recovery', createdAt: now, updatedAt: now };
    },
    async claimDuePoints() { return []; },
    async renewPointLease() { return false; },
    async finishPoint() { return false; },
    async retryPoint() { return false; },
    async markPointUnknown() { return false; },
    async markPointFailedActionRequired() { return false; },
    async markPointOperationPending() { return false; },
    async requestUnknownRecovery() { return false; },
    async readGenerationState() {
      return {
        generation: { id: 'generation-1', mealId: 'draft-1', userId: input.userId, contentRevision: 1, phase: 'recovery', createdAt: now, updatedAt: now },
        pointStatusCounts: { unknown: 1, failed_action_required: 1 },
        hasUnknownPoint: true,
        recoveryRequestedAt: undefined,
      };
    },
  };
  const recoveryStore: AuthStore = {
    ...input.store,
    currentMeals: {
      ...input.store.currentMeals,
      async findCurrentMeal(userId, mealId) {
        const current = await input.store.currentMeals.findCurrentMeal(userId, mealId);
        return current && userId === input.userId && mealId === 'draft-1' ? { ...current, syncState: 'recovery' } : undefined;
      },
    },
    mealSync: recoverySync,
  };

  const response = await handleCurrentMealSync(
    new Request('http://localhost:3000/rhythm/api/meals/draft-1/sync', { method: 'POST', headers: headers(input.sessionToken) }),
    'draft-1', deps(recoveryStore),
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { mealId: 'draft-1', syncState: 'recovery' });
  assert.equal(beginCalls, 1);
});
