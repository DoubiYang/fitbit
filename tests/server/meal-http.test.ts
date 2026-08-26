import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { completeGoogleOAuth, startGoogleOAuth } from '../../src/server/auth/oauth-service';
import { REQUESTED_SCOPES } from '../../src/server/auth/scopes';
import type { GoogleOAuthClient } from '../../src/server/auth/types';
import { loadConfig, type OAuthConfig } from '../../src/server/config/env';
import { createMemoryStore } from '../../src/server/db/memory-store';
import { handleMealConfirm, handleMealDraft, handleMealPhoto } from '../../src/server/meals/http';
import type { TwFdaFoodCatalog } from '../../src/server/nutrition/tw-fda';

const now = new Date('2026-08-26T12:00:00.000Z');
const encryptionKey = Buffer.alloc(32, 4).toString('base64');

function config(deepseekApiKey: string | undefined = 'test-deepseek-key'): OAuthConfig {
  const loaded = loadConfig({
    DATABASE_URL: 'postgresql://rhythm:x@db:5432/rhythm',
    GOOGLE_HEALTH_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_HEALTH_CLIENT_SECRET: 'client-secret',
    TOKEN_ENCRYPTION_KEY: encryptionKey,
    SYNC_SECRET: 'test-sync-secret',
    APP_ORIGIN: 'http://localhost:3000',
    ...(deepseekApiKey === undefined ? {} : { DEEPSEEK_APIKEY: deepseekApiKey }),
  });
  assert.equal(loaded.kind, 'oauth');
  if (loaded.kind !== 'oauth') {
    throw new Error('expected oauth config');
  }
  return loaded;
}

function google(): GoogleOAuthClient {
  return {
    async exchangeCode() {
      return {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: new Date('2026-08-26T13:00:00.000Z'),
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
  if (started.kind !== 'redirect') {
    throw new Error('expected oauth redirect');
  }
  const completed = await completeGoogleOAuth({
    config: config(),
    store,
    google: google(),
    query: { code: 'code', state: new URL(started.url).searchParams.get('state') ?? undefined },
    transactionId: started.transactionId,
    now,
  });
  assert.ok(completed.sessionToken);
  assert.ok(completed.userId);
  return { store, sessionToken: completed.sessionToken!, userId: completed.userId! };
}

async function photoRequest(input: { sessionToken?: string; consent?: boolean } = {}): Promise<Request> {
  const form = new FormData();
  form.set('aiPhotoConsent', input.consent === false ? 'false' : 'true');
  form.set('mealType', 'LUNCH');
  form.set('eatenAt', now.toISOString());
  form.set(
    'photo',
    new Blob([await sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } }).jpeg().toBuffer()], {
      type: 'image/jpeg',
    }),
    'meal.jpg',
  );
  return new Request('http://localhost:3000/rhythm/api/meals/photo', {
    method: 'POST',
    headers: {
      Origin: 'http://localhost:3000',
      ...(input.sessionToken ? { Cookie: `rhythm_session=${input.sessionToken}` } : {}),
    },
    body: form,
  });
}

const visionJson = JSON.stringify({
  foods: [
    {
      nameZh: '米饭',
      ingredients: ['稻米'],
      portionGrams: { min: 150, max: 220 },
      visibleFraction: 'full',
      confidence: 0.8,
      needsConfirmation: [],
      barcode: null,
      labelText: null,
    },
  ],
  photoQuality: 'usable',
  globalUncertainties: [],
});

function readyVision() {
  return {
    foods: [
      {
        nameZh: '西兰花',
        ingredients: ['西兰花'],
        portionGrams: 100,
        visibleFraction: 'full' as const,
        confidence: 0.9,
        needsConfirmation: [],
        eatFraction: 1,
        barcode: null,
        labelText: null,
      },
    ],
    photoQuality: 'usable' as const,
    globalUncertainties: [],
  };
}

function catalog(): TwFdaFoodCatalog {
  return {
    async findExact() {
      return {
        sourceRevision: 'tw-fda-test-sha',
        officialFoodId: 'V0100101',
        nameZh: '花椰菜',
        aliases: ['西兰花'],
        nutrients: [
          { officialName: '熱量', rawUnit: 'kcal', per100gValue: 34 },
          { officialName: '粗蛋白', rawUnit: 'g', per100gValue: 2.82 },
          { officialName: '總碳水化合物', rawUnit: 'g', per100gValue: 6.64 },
          { officialName: '粗脂肪', rawUnit: 'g', per100gValue: 0.37 },
          { officialName: '維生素C', rawUnit: 'mg', per100gValue: 89.4 },
          { officialName: '鈣', rawUnit: 'mg', per100gValue: 50 },
        ],
      };
    },
  };
}

test('meal photo rejects an unauthenticated request before calling vision', async () => {
  let calls = 0;
  const response = await handleMealPhoto(await photoRequest(), {
    config: config(),
    store: createMemoryStore(),
    now: () => now,
    vision: {
      async complete() {
        calls += 1;
        return visionJson;
      },
    },
  });
  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});

test('meal photo requires explicit consent before sending image to vision', async () => {
  const signedIn = await signedInStore();
  let calls = 0;
  const response = await handleMealPhoto(await photoRequest({ sessionToken: signedIn.sessionToken, consent: false }), {
    config: config(),
    store: signedIn.store,
    now: () => now,
    vision: {
      async complete() {
        calls += 1;
        return visionJson;
      },
    },
  });
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test('meal photo creates a sanitized editable draft without returning vision or image bytes', async () => {
  const signedIn = await signedInStore();
  const response = await handleMealPhoto(await photoRequest({ sessionToken: signedIn.sessionToken }), {
    config: config(),
    store: signedIn.store,
    now: () => now,
    vision: { async complete() { return visionJson; } },
  });
  assert.equal(response.status, 201);
  const body = (await response.json()) as { draft?: { mealId?: string; dishes?: unknown[] } };
  assert.ok(body.draft?.mealId);
  assert.equal(body.draft?.dishes?.length, 1);
  assert.equal(JSON.stringify(body).includes('base64'), false);
  assert.equal(JSON.stringify(body).includes('globalUncertainties'), false);

  const read = await handleMealDraft(new Request(`http://localhost:3000/rhythm/api/meals/drafts/${body.draft?.mealId}`, {
    headers: { Cookie: `rhythm_session=${signedIn.sessionToken}` },
  }), body.draft?.mealId!, { config: config(), store: signedIn.store, now: () => now, catalogForUser: async () => ({ catalog: catalog(), canWriteNutrition: true, connectionSyncable: true }) });
  assert.equal(read.status, 200);
});

test('meal photo does not send an image when the DeepSeek key is absent', async () => {
  const signedIn = await signedInStore();
  let calls = 0;
  const response = await handleMealPhoto(await photoRequest({ sessionToken: signedIn.sessionToken }), {
    config: config(''),
    store: signedIn.store,
    now: () => now,
    vision: {
      async complete() {
        calls += 1;
        return visionJson;
      },
    },
  });
  assert.equal(response.status, 503);
  assert.equal(calls, 0);
});

test('meal photo keeps a vision service failure distinct from local nutrition catalog errors', async () => {
  const signedIn = await signedInStore();
  const response = await handleMealPhoto(await photoRequest({ sessionToken: signedIn.sessionToken }), {
    config: config(),
    store: signedIn.store,
    now: () => now,
    vision: { async complete() { throw new Error('model gateway unavailable'); } },
    catalogForUser: async () => ({ catalog: catalog(), canWriteNutrition: true, connectionSyncable: true }),
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'vision_unavailable' });
});

test('legacy meal confirm is permanently retired and never queues a legacy writeback', async () => {
  const signedIn = await signedInStore();
  const draft = await signedIn.store.meals.insertDraft({
    userId: signedIn.userId,
    mealType: 'LUNCH',
    eatenAt: now,
    vision: readyVision(),
    now,
  });
  const response = await handleMealConfirm(
    new Request(`http://localhost:3000/rhythm/api/meals/drafts/${draft.id}/confirm`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000', Cookie: `rhythm_session=${signedIn.sessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ writebackThisMeal: true }),
    }),
    draft.id,
    {
      config: config(),
      store: signedIn.store,
      now: () => now,
      catalogForUser: async () => ({ catalog: catalog(), canWriteNutrition: true, connectionSyncable: true }),
    },
  );
  assert.equal(response.status, 410);
  assert.deepEqual(await response.json(), { error: 'meal_confirm_replaced' });
  assert.deepEqual(signedIn.store.outboxRows(), []);
});
