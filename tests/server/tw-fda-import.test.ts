import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createPostgresFoodCompositionSink,
  importTwFdaJson,
  isTwFdaSnapshotReady,
  manifestPathForSnapshot,
  snapshotPathFromArgv,
  type FoodCompositionImportSink,
  type ImportedFood,
  type ImportedNutrient,
} from '../../scripts/import-tw-fda-food-composition';

const fixturePath = new URL('../fixtures/tw-fda-small.json', import.meta.url);

test('finds a manifest next to the snapshot file rather than at the working-directory root', () => {
  assert.equal(
    manifestPathForSnapshot('/tmp/data/tw-fda/food-composition.json.zip'),
    '/tmp/data/tw-fda/manifest.json',
  );
});

test('accepts a snapshot path after pnpm command forwarding separator', () => {
  assert.equal(
    snapshotPathFromArgv(['node', 'scripts/import-tw-fda-food-composition.ts', '--', 'data/tw-fda/food-composition.json.zip']),
    'data/tw-fda/food-composition.json.zip',
  );
});

test('skips a Compose startup import only when this exact snapshot has every expected row count', () => {
  const expected = { recordCount: 226720, foodCount: 2180, nutrientCount: 160045 };
  assert.equal(isTwFdaSnapshotReady(expected, { ...expected }), true);
  assert.equal(isTwFdaSnapshotReady(expected, { ...expected, nutrientCount: 160044 }), false);
  assert.equal(isTwFdaSnapshotReady(expected, undefined), false);
});

class MemorySink implements FoodCompositionImportSink {
  readonly sources = new Map<string, { sha256: string; recordCount: number }>();
  readonly foods = new Map<string, ImportedFood>();
  readonly nutrients = new Map<string, ImportedNutrient>();

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  async upsertSource(input: { sha256: string; recordCount: number }): Promise<void> {
    this.sources.set(input.sha256, input);
  }

  async upsertFood(input: ImportedFood): Promise<void> {
    this.foods.set(`${input.sourceRevision}:${input.officialFoodId}`, input);
  }

  async upsertNutrient(input: ImportedNutrient): Promise<void> {
    this.nutrients.set(`${input.sourceRevision}:${input.officialFoodId}:${input.officialNutrientName}`, input);
  }
}

async function fixtureSha256(): Promise<string> {
  return createHash('sha256').update(await readFile(fixturePath)).digest('hex');
}

test('refuses a mismatched SHA-256 before it writes any food-composition rows', async () => {
  const sink = new MemorySink();
  await assert.rejects(
    importTwFdaJson({ path: fixturePath, expectedSha256: '0'.repeat(64) }, sink),
    { code: 'tw_fda_snapshot_sha_mismatch' },
  );
  assert.equal(sink.sources.size, 0);
  assert.equal(sink.foods.size, 0);
  assert.equal(sink.nutrients.size, 0);
});

test('merges repeated official food IDs into one food with every nutrient fact', async () => {
  const sink = new MemorySink();
  const result = await importTwFdaJson({ path: fixturePath, expectedSha256: await fixtureSha256() }, sink);

  assert.equal(result.recordCount, 4);
  assert.equal(result.foodCount, 2);
  assert.equal(result.nutrientCount, 4);
  assert.equal(sink.foods.get(`${result.sha256}:V0100101`)?.nameZh, '花椰菜');
  assert.equal(sink.nutrients.get(`${result.sha256}:V0100101:維生素C`)?.per100gValue, 89.4);
});

test('imports the same verified snapshot idempotently', async () => {
  const sink = new MemorySink();
  const input = { path: fixturePath, expectedSha256: await fixtureSha256() };
  await importTwFdaJson(input, sink);
  const second = await importTwFdaJson(input, sink);

  assert.equal(sink.sources.size, 1);
  assert.equal(sink.foods.size, 2);
  assert.equal(sink.nutrients.size, 4);
  assert.equal(second.foodCount, 2);
});

test('does not coerce an invalid nutrient value to zero', async () => {
  const source = await readFile(fixturePath, 'utf8');
  const invalidRows = JSON.parse(source) as Array<Record<string, unknown>>;
  invalidRows[0] = { ...invalidRows[0], '每100克含量': '未檢出' };
  const path = join(tmpdir(), `tw-fda-invalid-${process.pid}-${Date.now()}.json`);
  await writeFile(path, JSON.stringify(invalidRows));
  const sink = new MemorySink();
  const result = await importTwFdaJson({ path, expectedSha256: createHash('sha256').update(await readFile(path)).digest('hex') }, sink);

  assert.equal(result.skippedNutrientCount, 1);
  assert.equal([...sink.nutrients.values()].some((row) => row.per100gValue === 0), false);
});

test('uses parameterized transaction queries when writing a verified snapshot to PostgreSQL', async () => {
  const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const sink = createPostgresFoodCompositionSink({ async connect() { return client; } });
  await importTwFdaJson({ path: fixturePath, expectedSha256: await fixtureSha256() }, sink);

  assert.equal(queries[0]?.text, 'BEGIN');
  assert.ok(queries.some((query) => query.text.includes('INSERT INTO food_composition_sources')));
  assert.ok(queries.some((query) => query.text.includes('INSERT INTO food_composition_aliases')));
  assert.ok(queries.some((query) => query.text.includes('INSERT INTO food_composition_nutrients')));
  assert.ok(queries.filter((query) => query.values?.includes('V0100101')).length > 0);
  assert.equal(queries.at(-1)?.text, 'COMMIT');
});
