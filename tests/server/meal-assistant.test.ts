import assert from 'node:assert/strict';
import test from 'node:test';

import type { EditableMealDraft } from '../../src/domain/meal-editor';
import {
  fetchDeepSeekMealAssistant,
  MealAssistantError,
  suggestMealEdits,
  type MealAssistantClient,
} from '../../src/server/meals/meal-assistant';
import type { LocalTwFdaFood, TwFdaFoodCatalog } from '../../src/server/nutrition/tw-fda';

const meal: EditableMealDraft = {
  view: 'draft',
  mealId: 'meal-1',
  mealType: 'LUNCH',
  eatenAt: '2026-08-26T12:00:00.000Z',
  dishes: [{
    id: 'dish-1',
    nameZh: '番茄炒蛋',
    portionGrams: 200,
    ingredients: [
      { nameZh: '番茄', grams: 120, foodSource: 'tw_fda', foodSourceId: 'TOMATO', foodSourceVersion: 'fda-sha' },
      { nameZh: '雞蛋', grams: 80, foodSource: 'tw_fda', foodSourceId: 'EGG', foodSourceVersion: 'fda-sha' },
    ],
  }],
  nutrients: [
    { dishId: 'dish-1', nutrientCode: 'ENERGY', value: 180, unit: 'kcal', source: 'tw_fda' },
    { dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 16, unit: 'g', source: 'tw_fda' },
    { dishId: 'dish-1', nutrientCode: 'VITAMIN_C', value: 0.02, unit: 'g', source: 'tw_fda' },
    { dishId: 'dish-1', nutrientCode: 'VITAMIN_D', value: 0.00001, unit: 'g', source: 'tw_fda' },
  ],
};

const foods: Record<string, LocalTwFdaFood> = {
  番茄: { sourceRevision: 'fda-sha', officialFoodId: 'TOMATO', nameZh: '番茄', aliases: [], nutrients: [] },
  雞蛋: { sourceRevision: 'fda-sha', officialFoodId: 'EGG', nameZh: '雞蛋', aliases: [], nutrients: [] },
};
const catalog: TwFdaFoodCatalog = { async findExact(nameZh) { return foods[nameZh]; } };

function clientReturning(content: unknown): MealAssistantClient {
  return { async complete() { return typeof content === 'string' ? content : JSON.stringify(content); } };
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    assert.fail('expected an assistant error');
  } catch (error) {
    assert.ok(error instanceof MealAssistantError);
    return error.code;
  }
  throw new Error('unreachable');
}

test('returns only suggestions validated against the current meal, units, and local FDA catalog', async () => {
  let received: Parameters<MealAssistantClient['complete']>[0] | undefined;
  const client: MealAssistantClient = {
    async complete(input) {
      received = input;
      return `\`\`\`json\n${JSON.stringify({ suggestions: [
        {
          kind: 'replace_ingredients', dishId: 'dish-1', nameZh: '少油番茄炒蛋',
          ingredients: [{ nameZh: '番茄', grams: 150 }, { nameZh: '雞蛋', grams: 60 }],
        },
        { kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'VITAMIN_C', value: 30, unit: 'mg' },
      ] })}\n\`\`\``;
    },
  };

  const suggestions = await suggestMealEdits({
    apiKey: 'server-only-key', question: '少放一点油后营养怎么改？', meal, catalog, client,
  });

  assert.equal(suggestions.length, 2);
  assert.equal(suggestions[1]?.kind, 'set_nutrient');
  const prompt = received?.prompt ?? '';
  assert.equal(received?.question, '少放一点油后营养怎么改？');
  assert.match(prompt, /dish-1/);
  assert.doesNotMatch(prompt, /server-only-key|photo|image_url|data:image|Authorization|history/i);
  assert.deepEqual(received?.meal.dishes[0]?.ingredients.map(({ nameZh, grams }) => ({ nameZh, grams })), [
    { nameZh: '番茄', grams: 120 }, { nameZh: '雞蛋', grams: 80 },
  ]);
  assert.deepEqual(received?.meal.nutrients, [
    { dishId: 'dish-1', nutrientCode: 'ENERGY', value: 180, unit: 'kcal' },
    { dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 16, unit: 'g' },
    { dishId: 'dish-1', nutrientCode: 'VITAMIN_C', value: 20, unit: 'mg' },
    { dishId: 'dish-1', nutrientCode: 'VITAMIN_D', value: 10, unit: 'μg' },
  ]);
  assert.equal('foodSource' in (received?.meal.dishes[0]?.ingredients[0] ?? {}), false);
});

test('drops invalid model entries and fails only when no valid suggestion remains', async () => {
  const oneValid = await suggestMealEdits({
    apiKey: 'key', question: '给一个建议', meal, catalog,
    client: clientReturning({ suggestions: [
      { kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 18, unit: 'g' },
      { kind: 'set_nutrient', dishId: 'missing', nutrientCode: 'PROTEIN', value: 18, unit: 'g' },
      { kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'ZINC', value: 18, unit: 'mg' },
      { kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'VITAMIN_C', value: 10, unit: 'g' },
      {
        kind: 'replace_ingredients', dishId: 'dish-1', nameZh: '未知菜',
        ingredients: [{ nameZh: '不存在食材', grams: 20 }],
      },
    ] }),
  });
  assert.deepEqual(oneValid, [{
    kind: 'set_nutrient', dishId: 'dish-1', nutrientCode: 'PROTEIN', value: 18, unit: 'g',
  }]);

  assert.equal(await errorCode(suggestMealEdits({
    apiKey: 'key', question: '给一个建议', meal, catalog,
    client: clientReturning({ suggestions: [{ kind: 'delete_dish', dishId: 'dish-1' }] }),
  })), 'ai_response_invalid');
});

test('distinguishes unavailable models from invalid model responses without mutating the meal', async () => {
  assert.equal(await errorCode(suggestMealEdits({
    apiKey: 'key', question: '给一个建议', meal, catalog,
    client: { async complete() { throw new Error('network unavailable'); } },
  })), 'ai_model_unavailable');
  assert.equal(await errorCode(suggestMealEdits({
    apiKey: 'key', question: '给一个建议', meal, catalog,
    client: clientReturning('not JSON'),
  })), 'ai_response_invalid');
  assert.equal(meal.nutrients[0]?.value, 180);
});

test('DeepSeek text request uses JSON-only messages with no image or token in its body', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  let requestHeaders: Headers | undefined;
  globalThis.fetch = (async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requestHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"suggestions":[]}' } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await fetchDeepSeekMealAssistant({
      apiKey: 'server-only-key',
      prompt: 'prompt text',
      question: 'question text',
      meal: { mealType: 'LUNCH', eatenAt: meal.eatenAt, dishes: [], nutrients: [] },
    });
    assert.equal(result, '{"suggestions":[]}');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const body = JSON.stringify(requestBody);
  assert.match(body, /response_format/);
  assert.doesNotMatch(body, /server-only-key|photo|image_url|data:image|Authorization|history/i);
  assert.equal(requestHeaders?.get('Authorization'), 'Bearer server-only-key');
  const messages = requestBody?.messages as Array<{ content?: unknown }>;
  assert.ok(messages.every((message) => typeof message.content === 'string'));
});

test('maps malformed DeepSeek bodies to ai_response_invalid in both helper and suggestion paths', async () => {
  const originalFetch = globalThis.fetch;
  let responseBody: unknown = null;
  globalThis.fetch = (async () => new Response(JSON.stringify(responseBody), { status: 200 })) as typeof fetch;
  try {
    for (const invalidBody of [null, [], {}, { choices: null }, { choices: [] }, { choices: [{}] }]) {
      responseBody = invalidBody;
      assert.equal(await errorCode(fetchDeepSeekMealAssistant({
        apiKey: 'server-only-key', prompt: 'prompt', question: 'question',
        meal: { mealType: 'LUNCH', eatenAt: meal.eatenAt, dishes: [], nutrients: [] },
      })), 'ai_response_invalid');
    }

    responseBody = null;
    assert.equal(await errorCode(suggestMealEdits({
      apiKey: 'server-only-key', question: '给一个建议', meal, catalog,
    })), 'ai_response_invalid');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('maps a controlled request timeout abort to ai_model_unavailable', async () => {
  let triggerTimeout: (() => void) | undefined;
  let cleared = false;
  const request = fetchDeepSeekMealAssistant({
    apiKey: 'server-only-key', prompt: 'prompt', question: 'question',
    meal: { mealType: 'LUNCH', eatenAt: meal.eatenAt, dishes: [], nutrients: [] },
  }, {
    timeoutMs: 123,
    scheduleTimeout(callback, timeoutMs) {
      assert.equal(timeoutMs, 123);
      triggerTimeout = callback;
      return () => { cleared = true; };
    },
    async fetch(_url, init) {
      return new Promise<Response>((_resolve, reject) => {
        (init?.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    },
  });

  assert.ok(triggerTimeout);
  triggerTimeout();
  assert.equal(await errorCode(request), 'ai_model_unavailable');
  assert.equal(cleared, true);
});

test('keeps the request deadline through a stalled response.json call', async () => {
  let triggerTimeout: (() => void) | undefined;
  let jsonStarted!: () => void;
  let releaseJson!: (value: unknown) => void;
  const jsonHasStarted = new Promise<void>((resolve) => { jsonStarted = resolve; });
  const stalledJson = new Promise<unknown>((resolve) => { releaseJson = resolve; });
  const request = fetchDeepSeekMealAssistant({
    apiKey: 'server-only-key', prompt: 'prompt', question: 'question',
    meal: { mealType: 'LUNCH', eatenAt: meal.eatenAt, dishes: [], nutrients: [] },
  }, {
    scheduleTimeout(callback) {
      triggerTimeout = callback;
      return () => {};
    },
    async fetch() {
      return {
        ok: true,
        json() {
          jsonStarted();
          return stalledJson;
        },
      } as Response;
    },
  });
  let rejection: unknown;
  void request.catch((error) => { rejection = error; });

  try {
    await jsonHasStarted;
    assert.ok(triggerTimeout);
    triggerTimeout();
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(rejection instanceof MealAssistantError);
    assert.equal((rejection as MealAssistantError).code, 'ai_model_unavailable');
  } finally {
    releaseJson(null);
    await request.catch(() => undefined);
  }
});
