import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import pg from 'pg';

import { resolveDatabaseUrl } from '../src/server/config/env';
import { migrate } from '../src/server/db/migrate';
import { mapTwFdaNutrient, normalizeTwFdaFoodName } from '../src/server/nutrition/tw-fda';

const execFile = promisify(execFileCallback);

type TwFdaRow = {
  '整合編號'?: unknown;
  '樣品名稱'?: unknown;
  '俗名'?: unknown;
  '樣品英文名稱'?: unknown;
  '食品分類'?: unknown;
  '內容物描述'?: unknown;
  '分析項'?: unknown;
  '分析項分類'?: unknown;
  '含量單位'?: unknown;
  '每100克含量'?: unknown;
};

export type ImportedFood = {
  sourceRevision: string;
  officialFoodId: string;
  nameZh: string;
  aliases: string[];
  nameEn: string | undefined;
  category: string | undefined;
  description: string | undefined;
};

export type ImportedNutrient = {
  sourceRevision: string;
  officialFoodId: string;
  officialNutrientName: string;
  officialNutrientCategory: string | undefined;
  rawUnit: string;
  per100gValue: number;
};

export type FoodCompositionImportSink = {
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;
  upsertSource(input: { sha256: string; recordCount: number }): Promise<void>;
  upsertFood(input: ImportedFood): Promise<void>;
  upsertNutrient(input: ImportedNutrient): Promise<void>;
};

type ParameterizedQuery = <Row = never>(text: string, values?: unknown[]) => Promise<{ rows: Row[] }>;

export type PostgresFoodCompositionPool = {
  connect(): Promise<{ query: ParameterizedQuery; release(): void }>;
};

export type TwFdaImportResult = {
  sha256: string;
  recordCount: number;
  foodCount: number;
  nutrientCount: number;
  skippedNutrientCount: number;
};

export type TwFdaSnapshotCounts = Pick<TwFdaImportResult, 'recordCount' | 'foodCount' | 'nutrientCount'>;

export class TwFdaSnapshotShaMismatchError extends Error {
  readonly code = 'tw_fda_snapshot_sha_mismatch';

  constructor() {
    super('Taiwan FDA source SHA-256 does not match the expected manifest value');
  }
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function splitAliases(value: unknown): string[] {
  const aliases = new Set<string>();
  for (const alias of asTrimmedString(value)?.split(/[，,、;]/u) ?? []) {
    const trimmed = alias.trim();
    if (trimmed) {
      aliases.add(trimmed);
    }
  }
  return [...aliases];
}

function parseNumber(value: unknown): number | undefined {
  const text = asTrimmedString(value);
  if (!text || !/^[+-]?\d+(?:\.\d+)?$/u.test(text)) {
    return undefined;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function sha256File(path: URL | string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function parseRows(json: string): TwFdaRow[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error('Taiwan FDA snapshot must be a JSON array');
  }
  return parsed.filter((row): row is TwFdaRow => typeof row === 'object' && row !== null);
}

async function importRows(input: { rows: TwFdaRow[]; sha256: string }, sink: FoodCompositionImportSink): Promise<TwFdaImportResult> {
  const foods = new Map<string, ImportedFood>();
  const nutrients = new Map<string, ImportedNutrient>();
  let skippedNutrientCount = 0;

  for (const row of input.rows) {
    const officialFoodId = asTrimmedString(row['整合編號']);
    const nameZh = asTrimmedString(row['樣品名稱']);
    if (!officialFoodId || !nameZh) {
      continue;
    }

    const aliases = new Set([nameZh, ...splitAliases(row['俗名'])]);
    foods.set(officialFoodId, {
      sourceRevision: input.sha256,
      officialFoodId,
      nameZh,
      aliases: [...aliases],
      nameEn: asTrimmedString(row['樣品英文名稱']),
      category: asTrimmedString(row['食品分類']),
      description: asTrimmedString(row['內容物描述']),
    });

    const officialNutrientName = asTrimmedString(row['分析項']);
    const rawUnit = asTrimmedString(row['含量單位']);
    const per100gValue = parseNumber(row['每100克含量']);
    if (!officialNutrientName || !rawUnit || per100gValue === undefined) {
      skippedNutrientCount += 1;
      continue;
    }

    nutrients.set(`${officialFoodId}\u0000${officialNutrientName}`, {
      sourceRevision: input.sha256,
      officialFoodId,
      officialNutrientName,
      officialNutrientCategory: asTrimmedString(row['分析項分類']),
      rawUnit,
      per100gValue,
    });
  }

  await sink.withTransaction(async () => {
    await sink.upsertSource({ sha256: input.sha256, recordCount: input.rows.length });
    for (const food of foods.values()) {
      await sink.upsertFood(food);
    }
    for (const nutrient of nutrients.values()) {
      await sink.upsertNutrient(nutrient);
    }
  });

  return {
    sha256: input.sha256,
    recordCount: input.rows.length,
    foodCount: foods.size,
    nutrientCount: nutrients.size,
    skippedNutrientCount,
  };
}

export async function importTwFdaJson(
  input: { path: URL | string; expectedSha256: string },
  sink: FoodCompositionImportSink,
): Promise<TwFdaImportResult> {
  const [actualSha256, json] = await Promise.all([sha256File(input.path), readFile(input.path, 'utf8')]);
  if (actualSha256 !== input.expectedSha256) {
    throw new TwFdaSnapshotShaMismatchError();
  }
  return importRows({ rows: parseRows(json), sha256: actualSha256 }, sink);
}

export async function importTwFdaArchive(
  input: { path: string; expectedSha256: string },
  sink: FoodCompositionImportSink,
): Promise<TwFdaImportResult> {
  const actualSha256 = await sha256File(input.path);
  if (actualSha256 !== input.expectedSha256) {
    throw new TwFdaSnapshotShaMismatchError();
  }
  const extracted = await execFile('unzip', ['-p', input.path], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return importRows({ rows: parseRows(extracted.stdout), sha256: actualSha256 }, sink);
}

export function createPostgresFoodCompositionSink(pool: PostgresFoodCompositionPool): FoodCompositionImportSink {
  let query: ParameterizedQuery | undefined;
  const activeQuery = (): ParameterizedQuery => {
    if (!query) {
      throw new Error('food-composition writes must occur inside a transaction');
    }
    return query;
  };
  return {
    async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
      const client = await pool.connect();
      query = client.query.bind(client);
      try {
        await query('BEGIN');
        const result = await fn();
        await query('COMMIT');
        return result;
      } catch (error) {
        await query('ROLLBACK');
        throw error;
      } finally {
        query = undefined;
        client.release();
      }
    },
    async upsertSource(input): Promise<void> {
      const current = activeQuery();
      await current('UPDATE food_composition_sources SET is_current = false WHERE source_revision <> $1 AND is_current = true', [input.sha256]);
      await current(
        `INSERT INTO food_composition_sources (
          source_revision, source_url, source_license, source_record_count, is_current, imported_at
        ) VALUES ($1,$2,$3,$4,true,now())
        ON CONFLICT (source_revision) DO UPDATE SET
          source_record_count = EXCLUDED.source_record_count,
          is_current = true,
          imported_at = now()`,
        [
          input.sha256,
          'https://data.fda.gov.tw/data/opendata/export/20/json',
          'Government Open Data License, version 1.0',
          input.recordCount,
        ],
      );
    },
    async upsertFood(input): Promise<void> {
      const current = activeQuery();
      await current(
        `INSERT INTO food_composition_foods (
          source_revision, official_food_id, name_zh, name_en, category, description
        ) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (source_revision, official_food_id) DO UPDATE SET
          name_zh = EXCLUDED.name_zh,
          name_en = EXCLUDED.name_en,
          category = EXCLUDED.category,
          description = EXCLUDED.description`,
        [input.sourceRevision, input.officialFoodId, input.nameZh, input.nameEn ?? null, input.category ?? null, input.description ?? null],
      );
      for (const alias of input.aliases) {
        const normalizedAlias = normalizeTwFdaFoodName(alias);
        if (!normalizedAlias) {
          continue;
        }
        await current(
          `INSERT INTO food_composition_aliases (
            source_revision, official_food_id, normalized_alias, display_alias
          ) VALUES ($1,$2,$3,$4)
          ON CONFLICT (source_revision, official_food_id, normalized_alias) DO UPDATE SET
            display_alias = EXCLUDED.display_alias`,
          [input.sourceRevision, input.officialFoodId, normalizedAlias, alias],
        );
      }
    },
    async upsertNutrient(input): Promise<void> {
      const mapped = mapTwFdaNutrient({
        officialName: input.officialNutrientName,
        rawUnit: input.rawUnit,
        per100gValue: input.per100gValue,
      });
      const current = activeQuery();
      await current(
        `INSERT INTO food_composition_nutrients (
          source_revision, official_food_id, official_nutrient_name, official_nutrient_category,
          raw_unit, per_100g_value, canonical_code, canonical_grams_per_100g, canonical_kcal_per_100g
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (source_revision, official_food_id, official_nutrient_name) DO UPDATE SET
          official_nutrient_category = EXCLUDED.official_nutrient_category,
          raw_unit = EXCLUDED.raw_unit,
          per_100g_value = EXCLUDED.per_100g_value,
          canonical_code = EXCLUDED.canonical_code,
          canonical_grams_per_100g = EXCLUDED.canonical_grams_per_100g,
          canonical_kcal_per_100g = EXCLUDED.canonical_kcal_per_100g`,
        [
          input.sourceRevision,
          input.officialFoodId,
          input.officialNutrientName,
          input.officialNutrientCategory ?? null,
          input.rawUnit,
          input.per100gValue,
          mapped?.nutrientCode ?? null,
          mapped && 'gramsPer100g' in mapped ? mapped.gramsPer100g : null,
          mapped && 'kcalPer100g' in mapped ? mapped.kcalPer100g : null,
        ],
      );
    },
  };
}

type SnapshotManifest = {
  artifact?: { sha256?: unknown };
  content?: { record_count?: unknown; food_count?: unknown; nutrient_count?: unknown; skipped_nutrient_count?: unknown };
};

function manifestCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`manifest content.${field} must be a non-negative integer`);
  }
  return value;
}

function countsFromManifest(manifest: SnapshotManifest): TwFdaImportResult {
  const sha256 = typeof manifest.artifact?.sha256 === 'string' ? manifest.artifact.sha256 : undefined;
  if (!sha256 || !/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error('manifest artifact.sha256 must be a lowercase SHA-256 value');
  }
  return {
    sha256,
    recordCount: manifestCount(manifest.content?.record_count, 'record_count'),
    foodCount: manifestCount(manifest.content?.food_count, 'food_count'),
    nutrientCount: manifestCount(manifest.content?.nutrient_count, 'nutrient_count'),
    skippedNutrientCount: manifestCount(manifest.content?.skipped_nutrient_count, 'skipped_nutrient_count'),
  };
}

export function isTwFdaSnapshotReady(
  expected: TwFdaSnapshotCounts,
  current: TwFdaSnapshotCounts | undefined,
): boolean {
  return Boolean(
    current &&
      current.recordCount === expected.recordCount &&
      current.foodCount === expected.foodCount &&
      current.nutrientCount === expected.nutrientCount,
  );
}

async function currentSnapshotCounts(pool: PostgresFoodCompositionPool, sourceRevision: string): Promise<TwFdaSnapshotCounts | undefined> {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      record_count: string | number;
      food_count: string | number;
      nutrient_count: string | number;
    }>(
      `SELECT
         source_record_count AS record_count,
         (SELECT count(*) FROM food_composition_foods WHERE source_revision = sources.source_revision) AS food_count,
         (SELECT count(*) FROM food_composition_nutrients WHERE source_revision = sources.source_revision) AS nutrient_count
       FROM food_composition_sources AS sources
       WHERE source_revision = $1 AND is_current = true`,
      [sourceRevision],
    );
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    return {
      recordCount: Number(row.record_count),
      foodCount: Number(row.food_count),
      nutrientCount: Number(row.nutrient_count),
    };
  } finally {
    client.release();
  }
}

export function manifestPathForSnapshot(snapshotPath: string): string {
  return resolve(dirname(snapshotPath), 'manifest.json');
}

export function snapshotPathFromArgv(argv: string[]): string | undefined {
  return argv.slice(2).find((argument) => argument !== '--');
}

async function runCli(): Promise<void> {
  const snapshotPath = snapshotPathFromArgv(process.argv);
  if (!snapshotPath) {
    throw new Error('usage: pnpm import:tw-fda -- data/tw-fda/food-composition.json.zip');
  }
  const manifestPath = manifestPathForSnapshot(snapshotPath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as SnapshotManifest;
  const expected = countsFromManifest(manifest);
  const actualSha256 = await sha256File(snapshotPath);
  if (actualSha256 !== expected.sha256) {
    throw new TwFdaSnapshotShaMismatchError();
  }
  const databaseUrl = resolveDatabaseUrl(process.env);
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  await migrate(databaseUrl);
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const current = await currentSnapshotCounts(pool, expected.sha256);
    if (isTwFdaSnapshotReady(expected, current)) {
      console.log(JSON.stringify({ ...expected, skipped: true }));
      return;
    }
    const result = await importTwFdaArchive(
      { path: snapshotPath, expectedSha256: expected.sha256 },
      createPostgresFoodCompositionSink(pool),
    );
    console.log(JSON.stringify(result));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runCli();
}
