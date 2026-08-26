import { readFileSync } from 'node:fs';
import path from 'node:path';

import { dishesReadyToConfirm } from '../src/domain/meal-confirm';
import { loadConfig } from '../src/server/config/env';
import { getPool, getPostgresStore } from '../src/server/db/postgres-store';
import { createGoogleTokenRefresher, resolveAccessToken } from '../src/server/health/access-token';
import { recognizeMealPhoto } from '../src/server/meals/deepseek-vision';
import { createGoogleFoodCatalog, displayNutrients, probeFoodSearch } from '../src/server/meals/google-food';
import { resolveDishIngredients } from '../src/server/meals/ingredient-nutrition';
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

function hostDatabaseUrl(): string {
  const user = process.env.POSTGRES_USER ?? 'rhythm';
  const password = process.env.POSTGRES_PASSWORD ?? '';
  const database = process.env.POSTGRES_DB ?? 'rhythm';
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:5432/${encodeURIComponent(database)}`;
}

async function loadNutritionAccessToken(): Promise<
  | { ok: true; accessToken: string; status: string; hasNutritionReadonly: boolean }
  | { ok: false; reason: string }
> {
  process.env.DATABASE_URL = hostDatabaseUrl();
  const config = loadConfig();
  if (config.kind !== 'oauth') {
    return { ok: false, reason: `config is ${config.kind}` };
  }
  const pool = getPool(config.databaseUrl);
  const listed = await pool.query<{ user_id: string }>(
    `SELECT user_id
     FROM google_health_connections
     WHERE status IN ('active', 'partial')
       AND token_envelope_ciphertext IS NOT NULL
     ORDER BY updated_at DESC
     LIMIT 1`,
  );
  const userId = listed.rows[0]?.user_id;
  if (!userId) {
    return { ok: false, reason: 'no syncable google health connection' };
  }
  const store = getPostgresStore(config.databaseUrl);
  const connection = await store.connections.findByUserId(userId);
  if (!connection) {
    return { ok: false, reason: 'connection row missing after list' };
  }
  const accessToken = await resolveAccessToken({
    config,
    store,
    connection,
    refresher: createGoogleTokenRefresher(config),
  });
  return {
    ok: true,
    accessToken,
    status: connection.status,
    hasNutritionReadonly: connection.grantedScopes.includes(
      'https://www.googleapis.com/auth/googlehealth.nutrition.readonly',
    ),
  };
}

async function main(): Promise<void> {
  const imagePath = path.resolve(process.cwd(), '..', 'test.jpg');
  const ingested = ingestMealPhoto(readFileSync(imagePath));
  const meal = await recognizeMealPhoto(ingested, apiKey);

  let foodProbe: unknown = undefined;
  let catalog = undefined as ReturnType<typeof createGoogleFoodCatalog> | undefined;
  let tokenStatus: { ok: boolean; reason?: string; status?: string; hasNutritionReadonly?: boolean } = { ok: false };
  try {
    const token = await loadNutritionAccessToken();
    if (!token.ok) {
      tokenStatus = { ok: false, reason: token.reason };
    } else {
      tokenStatus = {
        ok: true,
        status: token.status,
        hasNutritionReadonly: token.hasNutritionReadonly,
      };
      foodProbe = await probeFoodSearch(token.accessToken, 'banana');
      catalog = createGoogleFoodCatalog(token.accessToken);
    }
  } catch (error) {
    tokenStatus = { ok: false, reason: error instanceof Error ? error.message : 'token failed' };
  }

  const dishes = catalog
    ? await Promise.all(meal.foods.map((dish) => resolveDishIngredients(dish, catalog!)))
    : meal.foods.map((dish) => ({
        dishNameZh: dish.nameZh,
        ingredients: dish.ingredients.map((nameZh) => ({ nameZh, grams: undefined, matchedDisplayName: undefined })),
        skipped: 'no google food catalog',
      }));

  console.log(
    JSON.stringify(
      {
        imageBytes: ingested.bytes.length,
        mime: ingested.mime,
        photoQuality: meal.photoQuality,
        globalUncertainties: meal.globalUncertainties,
        confirm: dishesReadyToConfirm(meal.foods),
        writeback: 'skipped',
        googleToken: tokenStatus,
        foodSearchProbe: foodProbe,
        vision: meal.foods.map((dish) => ({
          nameZh: dish.nameZh,
          ingredients: dish.ingredients,
          portionGrams: dish.portionGrams,
          needsConfirmation: dish.needsConfirmation,
        })),
        composition: dishes.map((dish) => {
          if (!('totals' in dish)) {
            return dish;
          }
          return {
            dishNameZh: dish.dishNameZh,
            dishGrams: dish.dishGrams,
            needsConfirmation: dish.needsConfirmation,
            energyKcal: dish.totals.energyKcal,
            proteinGrams: dish.totals.proteinGrams,
            carbGrams: dish.totals.carbGrams,
            fatGrams: dish.totals.fatGrams,
            nutrients: displayNutrients(dish.totals.nutrients),
            ingredients: dish.ingredients.map((item) => ({
              nameZh: item.nameZh,
              grams: item.grams,
              matchedDisplayName: item.matchedDisplayName,
              foodName: item.foodName,
              energyKcal: item.energyKcal,
              proteinGrams: item.proteinGrams,
              carbGrams: item.carbGrams,
              fatGrams: item.fatGrams,
              nutrients: displayNutrients(item.nutrients),
            })),
          };
        }),
      },
      null,
      2,
    ),
  );
}

void main();
