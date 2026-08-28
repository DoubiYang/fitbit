import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { completeGoogleOAuth, startGoogleOAuth } from '../../src/server/auth/oauth-service';
import { REQUESTED_SCOPES } from '../../src/server/auth/scopes';
import type { AuthStore, GoogleOAuthClient } from '../../src/server/auth/types';
import { loadConfig, type OAuthConfig } from '../../src/server/config/env';
import { createMemoryStore } from '../../src/server/db/memory-store';
import { runCurrentMealSyncOutbox } from '../../src/server/meals/current-meal-sync';
import {
  handleCurrentMeal,
  handleCurrentMealAiSuggestions,
  handleCurrentMealDraft,
  handleCurrentMealDraftSave,
  handleCurrentMealSync,
  handleMealPhoto,
} from '../../src/server/meals/http';
import type { MealAssistantClient } from '../../src/server/meals/meal-assistant';
import type { VisionClient } from '../../src/server/meals/deepseek-vision';
import type { GoogleNutritionOutboxClient } from '../../src/server/meals/nutrition-outbox';
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
  if (loaded.kind !== 'oauth') throw new Error('expected OAuth configuration');
  return loaded;
}

function oauthGoogle(): GoogleOAuthClient {
  return {
    async exchangeCode() {
      return {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: new Date('2026-08-27T13:00:00.000Z'),
        refreshExpiresAt: undefined,
        grantedScopes: [...REQUESTED_SCOPES],
      };
    },
    async getIdentity() {
      return { healthUserId: 'health-user', legacyUserId: undefined };
    },
    async revoke() {},
  };
}

async function signedInStore() {
  const store = createMemoryStore();
  const started = await startGoogleOAuth({ config: config(), store, now });
  assert.equal(started.kind, 'redirect');
  if (started.kind !== 'redirect') throw new Error('expected OAuth redirect');
  const completed = await completeGoogleOAuth({
    config: config(),
    store,
    google: oauthGoogle(),
    query: { code: 'code', state: new URL(started.url).searchParams.get('state') ?? undefined },
    transactionId: started.transactionId,
    now,
  });
  assert.ok(completed.sessionToken && completed.userId);
  return { store, sessionToken: completed.sessionToken!, userId: completed.userId! };
}

const catalog: TwFdaFoodCatalog = {
  async findExact(nameZh) {
    const food = {
      '鸡胸肉': {
        officialFoodId: 'CHICKEN',
        nutrients: [
          { officialName: '熱量', rawUnit: 'kcal', per100gValue: 34 },
          { officialName: '粗蛋白', rawUnit: 'g', per100gValue: 2.8 },
          { officialName: '維生素C', rawUnit: 'mg', per100gValue: 89.4 },
        ],
      },
      '西兰花': {
        officialFoodId: 'BROCCOLI',
        nutrients: [
          { officialName: '熱量', rawUnit: 'kcal', per100gValue: 20 },
          { officialName: '粗蛋白', rawUnit: 'g', per100gValue: 1 },
          { officialName: '維生素C', rawUnit: 'mg', per100gValue: 50 },
        ],
      },
    }[nameZh];
    return food && { sourceRevision: 'fda-test-sha', nameZh, aliases: [], ...food };
  },
};

function headers(sessionToken: string, json = false): HeadersInit {
  return {
    Origin: 'http://localhost:3000',
    Cookie: `rhythm_session=${sessionToken}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function photoRequest(sessionToken: string): Promise<Request> {
  const form = new FormData();
  form.set('aiPhotoConsent', 'true');
  form.set('mealType', 'LUNCH');
  form.set('eatenAt', now.toISOString());
  const bytes = await sharp({
    create: { width: 16, height: 16, channels: 3, background: 'red' },
  }).jpeg().toBuffer();
  form.set('photo', new Blob([bytes], { type: 'image/jpeg' }), 'meal.jpg');
  return new Request('http://localhost:3000/rhythm/api/meals/photo', {
    method: 'POST', headers: headers(sessionToken), body: form,
  });
}

function deps(store: AuthStore, assistant?: MealAssistantClient) {
  return {
    config: config(),
    store,
    now: () => now,
    catalogForUser: async () => ({ catalog, canWriteNutrition: true, connectionSyncable: true }),
    assistant,
  };
}

function completedGoogle(overrides: Partial<GoogleNutritionOutboxClient> = {}): GoogleNutritionOutboxClient {
  return {
    create: async () => ({ done: true }),
    batchDelete: async () => ({ done: true }),
    getDataPoint: async () => undefined,
    getOperation: async () => ({ done: true }),
    ...overrides,
  };
}

function assertNoTransientMealData(
  value: unknown,
  prohibitedFields = ['vision', 'photo', 'image', 'history', 'messages'],
): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    const tokens = key
      .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
      .toLowerCase()
      .split('_');
    for (const prohibited of prohibitedFields) {
      assert.equal(tokens.includes(prohibited), false, `must not expose ${prohibited}`);
    }
    assertNoTransientMealData(nested, prohibitedFields);
  }
}

test('mobile meal review persists only the reviewed meal and writes Google only after explicit sync', async () => {
  const input = await signedInStore();
  const vision = {
    foods: [{
      nameZh: '鸡胸肉西兰花',
      ingredients: ['鸡胸肉', '西兰花'],
      portionGrams: 100,
      visibleFraction: 'full' as const,
      confidence: 0.9,
      needsConfirmation: [],
      eatFraction: 1,
      barcode: null,
      labelText: null,
    }],
    photoQuality: 'usable' as const,
    globalUncertainties: ['raw image uncertainty must not reach the saved meal'],
  };
  const visionRequests: Array<Parameters<VisionClient['complete']>[0]> = [];
  const photoResponse = await handleMealPhoto(await photoRequest(input.sessionToken), {
    ...deps(input.store),
    vision: {
      async complete(request) {
        visionRequests.push(structuredClone(request));
        return JSON.stringify(vision);
      },
    },
  });
  assert.equal(photoResponse.status, 201);
  const photoBody = await photoResponse.json() as {
    draft?: { mealId?: string; dishes?: Array<{ id?: string }> };
  };
  const draftId = photoBody.draft?.mealId;
  const dishId = photoBody.draft?.dishes?.[0]?.id;
  assert.ok(draftId && dishId);
  assert.equal(visionRequests.length, 1);
  assert.equal(visionRequests[0]?.photo.mime, 'image/jpeg');
  assert.ok(visionRequests[0]?.photo.bytes.length);

  const ingredientsResponse = await handleCurrentMealDraft(
    new Request(`http://localhost:3000/rhythm/api/meals/drafts/${draftId}`, {
      method: 'PATCH',
      headers: headers(input.sessionToken, true),
      body: JSON.stringify({
        kind: 'replace_ingredients', dishId, nameZh: '鸡胸肉', ingredients: [{ nameZh: '鸡胸肉', grams: 50 }],
      }),
    }),
    draftId,
    deps(input.store),
  );
  assert.equal(ingredientsResponse.status, 200);
  const ingredientsBody = await ingredientsResponse.json() as {
    draft: { nutrients: Array<{ nutrientCode: string; value: number }> };
  };
  assert.deepEqual(ingredientsBody.draft.nutrients.map(({ nutrientCode, value }) => ({ nutrientCode, value })), [
    { nutrientCode: 'ENERGY', value: 17 },
    { nutrientCode: 'PROTEIN', value: 1.4 },
    { nutrientCode: 'VITAMIN_C', value: 0.044700000000000004 },
  ]);

  const nutrientResponse = await handleCurrentMealDraft(
    new Request(`http://localhost:3000/rhythm/api/meals/drafts/${draftId}`, {
      method: 'PATCH',
      headers: headers(input.sessionToken, true),
      body: JSON.stringify({ kind: 'set_nutrient', dishId, nutrientCode: 'PROTEIN', value: 9000, unit: 'mg' }),
    }),
    draftId,
    deps(input.store),
  );
  assert.equal(nutrientResponse.status, 200);
  const nutrientBody = await nutrientResponse.json() as {
    draft: { nutrients: Array<{ nutrientCode: string; value: number; source: string }> };
  };
  assert.deepEqual(nutrientBody.draft.nutrients, [
    { dishId, nutrientCode: 'ENERGY', value: 17, unit: 'kcal', source: 'tw_fda' },
    { dishId, nutrientCode: 'PROTEIN', value: 9, unit: 'g', source: 'user_edit' },
    { dishId, nutrientCode: 'VITAMIN_C', value: 0.044700000000000004, unit: 'g', source: 'tw_fda' },
  ]);

  const saveResponse = await handleCurrentMealDraftSave(
    new Request(`http://localhost:3000/rhythm/api/meals/drafts/${draftId}/save`, {
      method: 'POST', headers: headers(input.sessionToken),
    }),
    draftId,
    deps(input.store),
  );
  assert.equal(saveResponse.status, 201);
  assert.deepEqual(input.store.outboxRows(), []);
  assert.deepEqual(input.store.mealSyncPoints(), []);
  assert.equal(await input.store.currentMeals.findEditorDraft(input.userId, draftId), undefined);

  const readResponse = await handleCurrentMeal(
    new Request(`http://localhost:3000/rhythm/api/meals/${draftId}`, { headers: headers(input.sessionToken) }),
    draftId,
    deps(input.store),
  );
  assert.equal(readResponse.status, 200);
  const readBody = await readResponse.json() as { meal: unknown; syncState: string };
  assert.equal(readBody.syncState, 'unsynced');
  assertNoTransientMealData(readBody.meal);
  assertNoTransientMealData(await input.store.currentMeals.findCurrentMeal(input.userId, draftId));

  const assistantRequests: Array<Parameters<MealAssistantClient['complete']>[0]> = [];
  const assistant: MealAssistantClient = {
    async complete(request) {
      assistantRequests.push(structuredClone(request));
      return JSON.stringify({
        suggestions: [{ kind: 'set_nutrient', dishId, nutrientCode: 'PROTEIN', value: 10, unit: 'g' }],
      });
    },
  };
  const aiResponse = await handleCurrentMealAiSuggestions(
    new Request(`http://localhost:3000/rhythm/api/meals/${draftId}/ai-suggestions`, {
      method: 'POST',
      headers: headers(input.sessionToken, true),
      body: JSON.stringify({ question: '蛋白质看起来偏高吗？' }),
    }),
    draftId,
    deps(input.store, assistant),
  );
  assert.equal(aiResponse.status, 200);
  assert.equal((await aiResponse.json() as { suggestions: unknown[] }).suggestions.length, 1);
  assert.equal(assistantRequests.length, 1);
  assertNoTransientMealData(assistantRequests[0], ['vision', 'photo', 'image', 'history', 'messages', 'token']);
  assert.doesNotMatch(JSON.stringify(assistantRequests[0]), /access-token|refresh-token/u);

  await input.store.users.setNutritionWritebackEnabled(input.userId, true);
  const writes: string[] = [];
  const google = completedGoogle({
    create: async () => {
      writes.push('create');
      return { done: true };
    },
    batchDelete: async () => {
      writes.push('delete');
      return { done: true };
    },
  });

  const initialSync = await handleCurrentMealSync(
    new Request(`http://localhost:3000/rhythm/api/meals/${draftId}/sync`, {
      method: 'POST', headers: headers(input.sessionToken),
    }),
    draftId,
    deps(input.store),
  );
  assert.equal(initialSync.status, 202);
  await runCurrentMealSyncOutbox({ store: input.store, now, tokenForUser: async () => 'token', google });
  assert.deepEqual(writes, ['create']);

  const editResponse = await handleCurrentMeal(
    new Request(`http://localhost:3000/rhythm/api/meals/${draftId}`, {
      method: 'PATCH',
      headers: headers(input.sessionToken, true),
      body: JSON.stringify({ kind: 'set_nutrient', dishId, nutrientCode: 'PROTEIN', value: 12, unit: 'g' }),
    }),
    draftId,
    deps(input.store),
  );
  assert.equal(editResponse.status, 200);
  const resync = await handleCurrentMealSync(
    new Request(`http://localhost:3000/rhythm/api/meals/${draftId}/sync`, {
      method: 'POST', headers: headers(input.sessionToken),
    }),
    draftId,
    deps(input.store),
  );
  assert.equal(resync.status, 202);
  await runCurrentMealSyncOutbox({ store: input.store, now, tokenForUser: async () => 'token', google });
  assert.deepEqual(writes, ['create', 'delete']);
  await runCurrentMealSyncOutbox({ store: input.store, now, tokenForUser: async () => 'token', google });
  assert.deepEqual(writes, ['create', 'delete', 'create']);

  const unknownEdit = await handleCurrentMeal(
    new Request(`http://localhost:3000/rhythm/api/meals/${draftId}`, {
      method: 'PATCH',
      headers: headers(input.sessionToken, true),
      body: JSON.stringify({ kind: 'set_nutrient', dishId, nutrientCode: 'PROTEIN', value: 13, unit: 'g' }),
    }),
    draftId,
    deps(input.store),
  );
  assert.equal(unknownEdit.status, 200);
  const unknownSync = await handleCurrentMealSync(
    new Request(`http://localhost:3000/rhythm/api/meals/${draftId}/sync`, {
      method: 'POST', headers: headers(input.sessionToken),
    }),
    draftId,
    deps(input.store),
  );
  assert.equal(unknownSync.status, 202);

  let unknownPosts = 0;
  const recoveredNames: string[] = [];
  const unknownGoogle = completedGoogle({
    batchDelete: async () => ({ done: true }),
    create: async () => {
      unknownPosts += 1;
      throw new Error('connection lost after request');
    },
    getDataPoint: async (_accessToken, name) => {
      recoveredNames.push(name);
      return undefined;
    },
  });
  await runCurrentMealSyncOutbox({ store: input.store, now, tokenForUser: async () => 'token', google: unknownGoogle });
  await runCurrentMealSyncOutbox({ store: input.store, now, tokenForUser: async () => 'token', google: unknownGoogle });
  assert.equal(unknownPosts, 1);
  await runCurrentMealSyncOutbox({
    store: input.store,
    now: new Date(now.getTime() + 60_000),
    tokenForUser: async () => 'token',
    google: unknownGoogle,
  });
  assert.equal(unknownPosts, 1);

  const recovery = await handleCurrentMealSync(
    new Request(`http://localhost:3000/rhythm/api/meals/${draftId}/sync`, {
      method: 'POST', headers: headers(input.sessionToken),
    }),
    draftId,
    deps(input.store),
  );
  assert.equal(recovery.status, 202);
  const unknownPointName = input.store.mealSyncPoints().find((point) => point.status === 'unknown')?.dataPointName;
  await runCurrentMealSyncOutbox({ store: input.store, now, tokenForUser: async () => 'token', google: unknownGoogle });
  assert.equal(unknownPosts, 1);
  assert.deepEqual(recoveredNames, [unknownPointName]);
});
