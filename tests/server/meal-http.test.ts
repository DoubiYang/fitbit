import assert from 'node:assert/strict';
import test from 'node:test';

import { completeGoogleOAuth, startGoogleOAuth } from '../../src/server/auth/oauth-service';
import { REQUESTED_SCOPES } from '../../src/server/auth/scopes';
import type { GoogleOAuthClient } from '../../src/server/auth/types';
import { loadConfig, type OAuthConfig } from '../../src/server/config/env';
import { createMemoryStore } from '../../src/server/db/memory-store';
import { handleMealDraft, handleMealPhoto } from '../../src/server/meals/http';

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

function photoRequest(input: { sessionToken?: string; consent?: boolean } = {}): Request {
  const form = new FormData();
  form.set('aiPhotoConsent', input.consent === false ? 'false' : 'true');
  form.set('mealType', 'LUNCH');
  form.set('eatenAt', now.toISOString());
  form.set(
    'photo',
    new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])], {
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

test('meal photo rejects an unauthenticated request before calling vision', async () => {
  let calls = 0;
  const response = await handleMealPhoto(photoRequest(), {
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
  const response = await handleMealPhoto(photoRequest({ sessionToken: signedIn.sessionToken, consent: false }), {
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

test('meal photo persists a caller-owned validated draft without returning image bytes', async () => {
  const signedIn = await signedInStore();
  const response = await handleMealPhoto(photoRequest({ sessionToken: signedIn.sessionToken }), {
    config: config(),
    store: signedIn.store,
    now: () => now,
    vision: { async complete() { return visionJson; } },
  });
  assert.equal(response.status, 201);
  const body = (await response.json()) as { draftId?: string; foods?: unknown[] };
  assert.ok(body.draftId);
  assert.equal(body.foods?.length, 1);
  assert.equal(JSON.stringify(body).includes('base64'), false);

  const read = await handleMealDraft(new Request(`http://localhost:3000/rhythm/api/meals/drafts/${body.draftId}`, {
    headers: { Cookie: `rhythm_session=${signedIn.sessionToken}` },
  }), body.draftId!, { config: config(), store: signedIn.store, now: () => now });
  assert.equal(read.status, 200);
});

test('meal photo does not send an image when the DeepSeek key is absent', async () => {
  const signedIn = await signedInStore();
  let calls = 0;
  const response = await handleMealPhoto(photoRequest({ sessionToken: signedIn.sessionToken }), {
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
