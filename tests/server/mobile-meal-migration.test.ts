import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL('../../db/migrations/009_mobile_meal_review.sql', import.meta.url), 'utf8');

test('allows cross-generation sync-point handoff while keeping point names unique per generation', () => {
  assert.match(migration, /UNIQUE \(generation_id, data_point_name\)/u);
  assert.doesNotMatch(migration, /UNIQUE \(data_point_name\)/u);
});

test('keeps the remote identity and immutable recovery mapping fields unchanged after point creation', () => {
  assert.match(migration, /NEW\.data_point_name IS DISTINCT FROM OLD\.data_point_name/u);
  assert.match(migration, /NEW\.role IS DISTINCT FROM OLD\.role/u);
  assert.match(migration, /BEFORE UPDATE OF data_point_name, role, payload, payload_hash ON meal_sync_points/u);
});
