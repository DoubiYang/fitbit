import { z } from 'zod';

import {
  mealAiNutrientUnit,
  mealAiSuggestionSchema,
  type MealAiSuggestion,
} from '../../domain/meal-ai-suggestions';
import {
  fromInternalNutrientAmount,
  type EditableMealDraft,
  type EditableMealSaved,
} from '../../domain/meal-editor';
import { DEEPSEEK_CHAT_URL, DEEPSEEK_VISION_MODEL } from './deepseek-vision';
import { extractJsonObject } from './extract-json';
import type { TwFdaFoodCatalog } from '../nutrition/tw-fda';

const DEEPSEEK_MEAL_ASSISTANT_MODEL = DEEPSEEK_VISION_MODEL;

const candidateResponseSchema = z.object({
  suggestions: z.array(z.unknown()).max(20),
}).strict();

const deepSeekResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().min(1) }),
  })).min(1),
});

const questionSchema = z.string().trim().min(1).max(2_000);

export type MealAssistantPromptMeal = {
  mealType: string;
  eatenAt: string;
  dishes: Array<{
    id: string;
    nameZh: string;
    portionGrams: number;
    ingredients: Array<{ nameZh: string; grams: number }>;
  }>;
  nutrients: Array<{ dishId: string; nutrientCode: string; value: number; unit: string }>;
};

export type MealAssistantClient = {
  complete(input: {
    apiKey: string;
    prompt: string;
    meal: MealAssistantPromptMeal;
    question: string;
  }): Promise<string>;
};

type TimeoutScheduler = (callback: () => void, timeoutMs: number) => () => void;

export type MealAssistantRequestDependencies = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  scheduleTimeout?: TimeoutScheduler;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const defaultTimeoutScheduler: TimeoutScheduler = (callback, timeoutMs) => {
  const timer = setTimeout(callback, timeoutMs);
  return () => clearTimeout(timer);
};

export class MealAssistantError extends Error {
  constructor(
    readonly code: 'ai_model_unavailable' | 'ai_response_invalid',
    message = code,
  ) {
    super(message);
    this.name = 'MealAssistantError';
  }
}

type AssistantMeal = EditableMealDraft | EditableMealSaved;

function promptMeal(meal: AssistantMeal): MealAssistantPromptMeal {
  return {
    mealType: meal.mealType,
    eatenAt: meal.eatenAt,
    dishes: meal.dishes.map((dish) => ({
      id: dish.id,
      nameZh: dish.nameZh,
      portionGrams: dish.portionGrams,
      ingredients: dish.ingredients.map(({ nameZh, grams }) => ({ nameZh, grams })),
    })),
    nutrients: meal.nutrients.map(({ dishId, nutrientCode, value }) => {
      const display = fromInternalNutrientAmount(nutrientCode, value, mealAiNutrientUnit(nutrientCode));
      return { dishId, ...display };
    }),
  };
}

export function buildMealAssistantPrompt(meal: MealAssistantPromptMeal): string {
  const allowed = meal.dishes.map((dish) => ({
    dishId: dish.id,
    nutrientUpdates: meal.nutrients
      .filter((nutrient) => nutrient.dishId === dish.id)
      .map((nutrient) => ({ nutrientCode: nutrient.nutrientCode, unit: mealAiNutrientUnit(nutrient.nutrientCode) })),
  }));
  return [
    '你是餐食编辑助手。只能给出建议，绝不能声称已经修改数据。',
    '只输出 JSON 对象：{"suggestions":[...]}; 每一项只能是以下两个严格 shape 之一：',
    '{"kind":"replace_ingredients","dishId":string,"nameZh":string,"ingredients":[{"nameZh":string,"grams":number}]}',
    '{"kind":"set_nutrient","dishId":string,"nutrientCode":string,"value":number,"unit":"kcal"|"g"|"mg"|"μg"}',
    '不得新增或删除菜品，不得引用未列出的 dishId 或 nutrientCode。食材必须使用现有本地食物库可精确匹配的名称。',
    `当前结构与允许的营养修改：${JSON.stringify({ meal, allowed })}`,
  ].join('\n');
}

export async function fetchDeepSeekMealAssistant(input: {
  apiKey: string;
  prompt: string;
  meal: MealAssistantPromptMeal;
  question: string;
}, dependencies: MealAssistantRequestDependencies = {}): Promise<string> {
  const controller = new AbortController();
  const requestTimeoutMs = dependencies.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const clearRequestTimeout = (dependencies.scheduleTimeout ?? defaultTimeoutScheduler)(
    () => controller.abort(),
    requestTimeoutMs,
  );
  let response: Response;
  try {
    response = await (dependencies.fetch ?? globalThis.fetch)(DEEPSEEK_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: DEEPSEEK_MEAL_ASSISTANT_MODEL,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: input.prompt },
          { role: 'user', content: input.question },
        ],
      }),
    });
  } catch {
    throw new MealAssistantError('ai_model_unavailable');
  } finally {
    clearRequestTimeout();
  }

  if (!response.ok) {
    throw new MealAssistantError('ai_model_unavailable');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new MealAssistantError('ai_response_invalid');
  }
  const parsed = deepSeekResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new MealAssistantError('ai_response_invalid');
  }
  return parsed.data.choices[0]!.message.content;
}

async function isApplicableSuggestion(
  suggestion: MealAiSuggestion,
  meal: AssistantMeal,
  catalog: TwFdaFoodCatalog,
): Promise<boolean> {
  if (!meal.dishes.some((dish) => dish.id === suggestion.dishId)) {
    return false;
  }
  if (suggestion.kind === 'replace_ingredients') {
    const foods = await Promise.all(suggestion.ingredients.map((ingredient) => catalog.findExact(ingredient.nameZh)));
    return foods.every((food) => food !== undefined);
  }
  const nutrientExists = meal.nutrients.some((nutrient) => (
    nutrient.dishId === suggestion.dishId && nutrient.nutrientCode === suggestion.nutrientCode
  ));
  return nutrientExists && suggestion.unit === mealAiNutrientUnit(suggestion.nutrientCode);
}

function candidateSuggestions(content: string): unknown[] {
  try {
    return candidateResponseSchema.parse(extractJsonObject(content)).suggestions;
  } catch {
    throw new MealAssistantError('ai_response_invalid');
  }
}

/**
 * Gets suggestions only. It never applies a patch or writes to a store: the
 * caller must still explicitly select the returned suggestion(s).
 */
export async function suggestMealEdits(input: {
  apiKey: string;
  question: string;
  meal: AssistantMeal;
  catalog: TwFdaFoodCatalog;
  client?: MealAssistantClient;
}): Promise<MealAiSuggestion[]> {
  const question = questionSchema.parse(input.question);
  const meal = promptMeal(input.meal);
  const prompt = buildMealAssistantPrompt(meal);
  let content: string;
  try {
    content = await (input.client ?? { complete: fetchDeepSeekMealAssistant }).complete({
      apiKey: input.apiKey,
      prompt,
      meal,
      question,
    });
  } catch (error) {
    if (error instanceof MealAssistantError) throw error;
    throw new MealAssistantError('ai_model_unavailable');
  }

  const suggestions: MealAiSuggestion[] = [];
  for (const candidate of candidateSuggestions(content)) {
    const parsed = mealAiSuggestionSchema.safeParse(candidate);
    if (parsed.success && await isApplicableSuggestion(parsed.data, input.meal, input.catalog)) {
      suggestions.push(parsed.data);
    }
  }
  if (suggestions.length === 0) {
    throw new MealAssistantError('ai_response_invalid');
  }
  return suggestions;
}
