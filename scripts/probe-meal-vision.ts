import { readFileSync } from 'node:fs';
import path from 'node:path';

import { dishesReadyToConfirm } from '../src/domain/meal-confirm';
import { recognizeMealPhoto } from '../src/server/meals/deepseek-vision';
import { estimateDish } from '../src/server/meals/nutrition-resolver';
import { ingestMealPhoto } from '../src/server/meals/photo-ingest';

function loadEnvFile(filePath: string): void {
  const text = readFileSync(filePath, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(process.cwd(), '.env.local'));

const loadedKey = process.env.DEEPSEEK_APIKEY ?? process.env.DEEPSEEK_API_KEY;
if (!loadedKey) {
  throw new Error('DEEPSEEK_APIKEY is missing');
}
const apiKey: string = loadedKey;

async function main(): Promise<void> {
  const imagePath = path.resolve(process.cwd(), '..', 'test.jpg');
  const ingested = ingestMealPhoto(readFileSync(imagePath));
  const meal = await recognizeMealPhoto(ingested, apiKey);
  const estimates = meal.foods.map((dish) => ({
    nameZh: dish.nameZh,
    ingredients: dish.ingredients,
    portionGrams: dish.portionGrams,
    needsConfirmation: dish.needsConfirmation,
    estimate: estimateDish(dish),
  }));
  console.log(
    JSON.stringify(
      {
        imageBytes: ingested.bytes.length,
        mime: ingested.mime,
        photoQuality: meal.photoQuality,
        globalUncertainties: meal.globalUncertainties,
        confirm: dishesReadyToConfirm(meal.foods),
        dishes: estimates,
      },
      null,
      2,
    ),
  );
}

void main();
