import { readFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../src/server/config/env';
import { ensurePostgresReady, getPool } from '../src/server/db/postgres-store';
import { createGoogleTokenRefresher, resolveAccessToken } from '../src/server/health/access-token';
import { createGoogleFoodCatalog, displayNutrients } from '../src/server/meals/google-food';

function loadEnvFile(filePath: string): void {
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
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

async function main(): Promise<void> {
  const user = process.env.POSTGRES_USER ?? 'rhythm';
  const password = process.env.POSTGRES_PASSWORD ?? '';
  const database = process.env.POSTGRES_DB ?? 'rhythm';
  process.env.DATABASE_URL = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:5432/${encodeURIComponent(database)}`;
  const config = loadConfig();
  if (config.kind !== 'oauth') {
    throw new Error(`config is ${config.kind}`);
  }
  const store = await ensurePostgresReady(config.databaseUrl);
  const pool = getPool(config.databaseUrl);
  const listed = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM google_health_connections WHERE status IN ('active','partial') ORDER BY updated_at DESC LIMIT 1`,
  );
  const userId = listed.rows[0]?.user_id;
  if (!userId) {
    throw new Error('no connection');
  }
  const connection = await store.connections.findByUserId(userId);
  if (!connection) {
    throw new Error('connection missing');
  }
  const accessToken = await resolveAccessToken({
    config,
    store,
    connection,
    refresher: createGoogleTokenRefresher(config),
  });
  const now = new Date();
  const draft = await store.meals.insertDraft({
    userId,
    mealType: 'LUNCH',
    eatenAt: now,
    now,
    vision: {
      photoQuality: 'usable',
      globalUncertainties: [],
      foods: [
        {
          nameZh: '酱牛肉',
          ingredients: ['牛肉', '酱油', '芝麻'],
          portionGrams: 125,
          visibleFraction: 'full',
          confidence: 0.8,
          needsConfirmation: [],
          eatFraction: 1,
        },
        {
          nameZh: '西兰花',
          ingredients: ['西兰花'],
          portionGrams: 40,
          visibleFraction: 'full',
          confidence: 0.8,
          needsConfirmation: [],
          eatFraction: 1,
        },
        {
          nameZh: '炒胡萝卜',
          ingredients: ['胡萝卜', '油'],
          portionGrams: 30,
          visibleFraction: 'full',
          confidence: 0.8,
          needsConfirmation: [],
          eatFraction: 1,
        },
      ],
    },
  });
  const confirmed = await store.meals.confirmDraft({
    userId,
    draftId: draft.id,
    writebackThisMeal: false,
    canWriteNutrition: false,
    connectionSyncable: true,
    now,
    catalog: createGoogleFoodCatalog(accessToken),
  });
  if (!confirmed.ok) {
    throw new Error(confirmed.reason);
  }
  const nutrients = await store.meals.listNutrients(userId, confirmed.version.id);
  const ingredients = await store.meals.listIngredients(userId, confirmed.version.id);
  const totals: Record<string, number> = {};
  let energyKcal = 0;
  for (const row of nutrients) {
    if (row.nutrientCode === 'ENERGY') {
      energyKcal += row.kcal ?? 0;
      continue;
    }
    if (row.grams !== undefined) {
      totals[row.nutrientCode] = (totals[row.nutrientCode] ?? 0) + row.grams;
    }
  }
  console.log(
    JSON.stringify(
      {
        writeback: 'skipped',
        versionId: confirmed.version.id,
        dishes: confirmed.dishes.map((dish) => dish.nameZh),
        ingredientCount: ingredients.length,
        nutrientCodes: [...new Set(nutrients.map((row) => row.nutrientCode))].sort(),
        energyKcal,
        nutrients: displayNutrients(totals),
      },
      null,
      2,
    ),
  );
}

void main();
