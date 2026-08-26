import { parseVisionMeal, type VisionMeal } from '../../domain/meal-vision';
import { extractJsonObject } from './extract-json';
import type { IngestedPhoto } from './photo-ingest';

export const DEEPSEEK_VISION_MODEL = 'deepseek-v4-flash-vision-exp';
export const DEEPSEEK_CHAT_URL = 'https://api.deepseek.com/chat/completions';

const SYSTEM_PROMPT = `你是餐食识别器。只根据照片列出用户可能吃到的每一道菜，不要合成一个总菜名，不要给出热量数字。
只输出一个 JSON 对象，字段必须是：
{
  "foods": [
    {
      "nameZh": string,
      "ingredients": string[],
      "portionGrams": {"min": number, "max": number},
      "visibleFraction": "full" | "partial" | "unknown",
      "confidence": number,
      "needsConfirmation": string[],
      "barcode": string | null,
      "labelText": string | null
    }
  ],
  "photoQuality": "usable" | "poor" | "unusable",
  "globalUncertainties": string[]
}
portionGrams 用克的区间。共享菜、油量、酱汁、食用比例不确定时写入 needsConfirmation 或 globalUncertainties。`;

export type VisionClient = {
  complete(input: { apiKey: string; photo: IngestedPhoto; prompt: string }): Promise<string>;
};

export async function fetchDeepSeekVision(input: { apiKey: string; photo: IngestedPhoto; prompt: string }): Promise<string> {
  const dataUrl = `data:${input.photo.mime};base64,${input.photo.bytes.toString('base64')}`;
  const response = await fetch(DEEPSEEK_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: DEEPSEEK_VISION_MODEL,
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: input.prompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: '识别这张餐食照片里的每一道菜。' },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
          ],
        },
      ],
    }),
  });
  const body = (await response.json()) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  if (!response.ok) {
    throw new Error(`deepseek vision ${response.status}`);
  }
  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('deepseek vision empty content');
  }
  return content;
}

export async function recognizeMealPhoto(
  photo: IngestedPhoto,
  apiKey: string,
  client: VisionClient = { complete: fetchDeepSeekVision },
): Promise<VisionMeal> {
  const content = await client.complete({ apiKey, photo, prompt: SYSTEM_PROMPT });
  return parseVisionMeal(extractJsonObject(content));
}
