import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import pg from 'pg';

import { migrate } from '../../src/server/db/migrate';

const baseUrl = process.env.POSTGRES_INTEGRATION_BASE_URL;
const migrationId = '013_homepage_strain_provenance.sql';
const cardioLoadMigrationId = '014_cardio_load_trimp_v3.sql';
const cardioLoadUtilizationMigrationId = '015_cardio_load_utilization.sql';
const fingerprint = `sha256:${'a'.repeat(64)}`;
const context = JSON.stringify({ metric_version: 'whoop-style-v2' });

function scratchUrl(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function quoteIdentifier(identifier: string): string {
  if (!/^fitbit_homepage_provenance_it_[a-f0-9]+$/u.test(identifier)) {
    throw new Error('unsafe scratch database identifier');
  }
  return `"${identifier}"`;
}

async function assertCheckViolation(work: () => Promise<unknown>): Promise<void> {
  await assert.rejects(work(), (error: unknown) => (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code: unknown }).code === '23514'
  ));
}

async function insertUser(client: pg.Client): Promise<string> {
  const userId = randomUUID();
  await client.query('INSERT INTO users (id) VALUES ($1)', [userId]);
  return userId;
}

async function insertLegacyStrainRows(client: pg.Client, userId: string): Promise<void> {
  await client.query(
    `INSERT INTO daily_cardio (
      user_id, civil_date, status, strain, dose, light_minutes, moderate_minutes, vigorous_minutes, peak_minutes,
      known_context_minutes, raw_coverage_minutes, attributed_minutes, metric_version
    ) VALUES ($1, '2026-08-01', 'complete', 8.4, 10, 10, 4, 1, 0, 15, 16, 15, 'whoop-style-v2')`,
    [userId],
  );
  await client.query(
    `INSERT INTO metric_results (
      user_id, civil_date, metric_name, metric_version, score, status, quality, reason, evidence, source, coverage
    ) VALUES ($1, '2026-08-01', 'strain', 'whoop-style-v2', 8.4, 'complete', NULL, NULL, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
    [userId],
  );
}

async function assertProvenanceConstraintMatrix(client: pg.Client, userId: string): Promise<void> {
  const invalidRows: Array<[number | null, string | null, string | null]> = [
    [null, fingerprint, context],
    [1, '', context],
    [1, 'sha256:not-a-fingerprint', context],
    [1, fingerprint, null],
    [1, fingerprint, '[]'],
  ];

  for (const [index, [version, inputFingerprint, calculationContext]] of invalidRows.entries()) {
    const civilDate = `2026-09-${String(index + 1).padStart(2, '0')}`;
    await assertCheckViolation(() => client.query(
      `INSERT INTO daily_cardio (
        user_id, civil_date, status, strain, dose, light_minutes, moderate_minutes, vigorous_minutes, peak_minutes,
        known_context_minutes, raw_coverage_minutes, attributed_minutes, metric_version,
        provenance_version, input_fingerprint, calculation_context
      ) VALUES ($1, $2, 'complete', 1, 1, 1, 0, 0, 0, 1, 1, 1, 'whoop-style-v2', $3, $4, $5::jsonb)`,
      [userId, civilDate, version, inputFingerprint, calculationContext],
    ));
    await assertCheckViolation(() => client.query(
      `INSERT INTO metric_results (
        user_id, civil_date, metric_name, metric_version, score, status, quality, reason, evidence, source, coverage,
        provenance_version, input_fingerprint, calculation_context
      ) VALUES ($1, $2, 'strain', 'whoop-style-v2', 1, 'complete', NULL, NULL, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $3, $4, $5::jsonb)`,
      [userId, `2026-10-${String(index + 1).padStart(2, '0')}`, version, inputFingerprint, calculationContext],
    ));
  }

  await client.query(
    `INSERT INTO daily_cardio (
      user_id, civil_date, status, strain, dose, light_minutes, moderate_minutes, vigorous_minutes, peak_minutes,
      known_context_minutes, raw_coverage_minutes, attributed_minutes, metric_version,
      provenance_version, input_fingerprint, calculation_context
    ) VALUES ($1, '2026-11-01', 'complete', 1, 1, 1, 0, 0, 0, 1, 1, 1, 'whoop-style-v2', 1, $2, $3::jsonb)`,
    [userId, fingerprint, context],
  );
  await client.query(
    `INSERT INTO metric_results (
      user_id, civil_date, metric_name, metric_version, score, status, quality, reason, evidence, source, coverage,
      provenance_version, input_fingerprint, calculation_context
    ) VALUES ($1, '2026-11-01', 'strain', 'whoop-style-v2', 1, 'complete', NULL, NULL, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, $2, $3::jsonb)`,
    [userId, fingerprint, context],
  );
}

async function insertTrimpRows(client: pg.Client, userId: string): Promise<void> {
  await client.query(
    `INSERT INTO heart_rate_minute_evidence (user_id, source_family, minute_start_utc, segments)
     VALUES ($1, 'google-wearables', '2026-08-24T11:41:00.000Z',
       '[{"startOffsetMs":0,"endOffsetMs":60000,"bpm":140}]'::jsonb)`,
    [userId],
  );
  await client.query(
    `INSERT INTO daily_cardio_loads (
       user_id, civil_date, metric_version, status, daily_load, qualified_seconds,
       unverified_elevated_hr_seconds, raw_hr_coverage_seconds, awake_coverage_ratio,
       motion_source, quality_state, rhr_base_bpm, hr_max_est_bpm, hr_max_provenance,
       input_fingerprint, calculation_context
     ) VALUES (
       $1, '2026-08-24', 'cardio-load-trimp-v3', 'scored', 6.4, 1800,
       120, 43200, 0.8, 'both', 'qualified', 54, 181,
       '{"filterRuleVersion":"google-wearables-hrmax-v1","sourceFamily":"google-wearables","minuteStartUtc":"2026-08-20T10:00:00.000Z","bpm":181,"coverageSeconds":60,"sampleCount":1}'::jsonb,
       $2, '{"metric_version":"cardio-load-trimp-v3"}'::jsonb
     )`,
    [userId, fingerprint],
  );
  await client.query(
    `INSERT INTO weekly_cardio_baselines (
       user_id, week_start, metric_version, status, weekly_load, week_to_date_load, rm4, ewma4, baseline, input_fingerprint
     ) VALUES ($1, '2026-08-24', 'cardio-load-trimp-v3', 'calibrating', NULL, 6.4, NULL, NULL, NULL, $2)`,
    [userId, fingerprint],
  );
  await client.query(
    `INSERT INTO daily_load_capacities (
       user_id, civil_date, metric_version, status, actual_load, usable_load, utilization,
       history_sample_count, used_global_fallback, recovery_tier, recovery_metric_version,
       recovery_civil_date, recovery_quality, recovery_input_fingerprint, input_fingerprint
     ) VALUES (
       $1, '2026-08-24', 'cardio-load-trimp-v3', 'calibrating', 6.4, NULL, NULL,
       0, false, 'unadjusted', NULL, NULL, NULL, NULL, $2
     )`,
    [userId, fingerprint],
  );
}

test('PostgreSQL migration 013 preserves legacy Strain rows, rolls back failures, and constrains provenance', {
  skip: baseUrl ? false : 'set POSTGRES_INTEGRATION_BASE_URL to run PostgreSQL integration tests',
}, async () => {
  if (!baseUrl) throw new Error('POSTGRES_INTEGRATION_BASE_URL is required');

  const scratchDatabase = `fitbit_homepage_provenance_it_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = scratchUrl(baseUrl, scratchDatabase);
  const migrationsDir = await mkdtemp(path.join(tmpdir(), 'fitbit-homepage-provenance-migrations-'));
  const admin = new pg.Client({ connectionString: baseUrl });
  let created = false;

  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${quoteIdentifier(scratchDatabase)}`);
    created = true;

    await cp(path.join(process.cwd(), 'db/migrations'), migrationsDir, { recursive: true });
    await rm(path.join(migrationsDir, migrationId));
    await migrate(databaseUrl, migrationsDir);

    const before = new pg.Client({ connectionString: databaseUrl });
    await before.connect();
    const legacyUser = await insertUser(before);
    await insertLegacyStrainRows(before, legacyUser);
    await before.end();

    const fixedMigration = await readFile(path.join(process.cwd(), 'db/migrations', migrationId), 'utf8');
    await writeFile(path.join(migrationsDir, migrationId), `${fixedMigration}\nSELECT homepage_provenance_migration_failure();\n`);
    await assert.rejects(migrate(databaseUrl, migrationsDir), /homepage_provenance_migration_failure/u);

    const afterFailure = new pg.Client({ connectionString: databaseUrl });
    await afterFailure.connect();
    try {
      const migration = await afterFailure.query<{ applied: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE id = $1) AS applied',
        [migrationId],
      );
      const column = await afterFailure.query<{ exists: boolean }>(
        `SELECT EXISTS(
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'daily_cardio' AND column_name = 'provenance_version'
        ) AS exists`,
      );
      assert.equal(migration.rows[0]?.applied, false);
      assert.equal(column.rows[0]?.exists, false);
    } finally {
      await afterFailure.end();
    }

    await writeFile(path.join(migrationsDir, migrationId), fixedMigration);
    await migrate(databaseUrl, migrationsDir);

    const afterSuccess = new pg.Client({ connectionString: databaseUrl });
    await afterSuccess.connect();
    try {
      const legacy = await afterSuccess.query<{ daily_legacy: boolean; metric_legacy: boolean }>(
        `SELECT
          (SELECT provenance_version IS NULL AND input_fingerprint IS NULL AND calculation_context IS NULL
             FROM daily_cardio WHERE user_id = $1 AND civil_date = '2026-08-01') AS daily_legacy,
          (SELECT provenance_version IS NULL AND input_fingerprint IS NULL AND calculation_context IS NULL
             FROM metric_results WHERE user_id = $1 AND civil_date = '2026-08-01' AND metric_name = 'strain') AS metric_legacy`,
        [legacyUser],
      );
      assert.deepEqual(legacy.rows[0], { daily_legacy: true, metric_legacy: true });
      await assertProvenanceConstraintMatrix(afterSuccess, legacyUser);
    } finally {
      await afterSuccess.end();
    }
  } finally {
    try {
      if (created) await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(scratchDatabase)} WITH (FORCE)`);
    } finally {
      await admin.end();
      await rm(migrationsDir, { recursive: true, force: true });
    }
  }
});

test('PostgreSQL migration 014 preserves v2 rows, rolls back atomically, and cascades v3 rows', {
  skip: baseUrl ? false : 'set POSTGRES_INTEGRATION_BASE_URL to run PostgreSQL integration tests',
}, async () => {
  if (!baseUrl) throw new Error('POSTGRES_INTEGRATION_BASE_URL is required');

  const scratchDatabase = `fitbit_homepage_provenance_it_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = scratchUrl(baseUrl, scratchDatabase);
  const migrationsDir = await mkdtemp(path.join(tmpdir(), 'fitbit-trimp-migrations-'));
  const admin = new pg.Client({ connectionString: baseUrl });
  let created = false;

  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${quoteIdentifier(scratchDatabase)}`);
    created = true;

    await cp(path.join(process.cwd(), 'db/migrations'), migrationsDir, { recursive: true });
    await rm(path.join(migrationsDir, cardioLoadMigrationId));
    await rm(path.join(migrationsDir, cardioLoadUtilizationMigrationId));
    await migrate(databaseUrl, migrationsDir);

    const before = new pg.Client({ connectionString: databaseUrl });
    await before.connect();
    const legacyUser = await insertUser(before);
    await insertLegacyStrainRows(before, legacyUser);
    await before.end();

    const fixedMigration = await readFile(path.join(process.cwd(), 'db/migrations', cardioLoadMigrationId), 'utf8');
    const utilizationMigration = await readFile(path.join(process.cwd(), 'db/migrations', cardioLoadUtilizationMigrationId), 'utf8');
    await writeFile(path.join(migrationsDir, cardioLoadMigrationId), `${fixedMigration}\nSELECT cardio_load_migration_failure();\n`);
    await assert.rejects(migrate(databaseUrl, migrationsDir), /cardio_load_migration_failure/u);

    const afterFailure = new pg.Client({ connectionString: databaseUrl });
    await afterFailure.connect();
    try {
      const state = await afterFailure.query<{ applied: boolean; v3_exists: boolean; legacy_strain: number }>(
        `SELECT
           EXISTS(SELECT 1 FROM schema_migrations WHERE id = $1) AS applied,
           to_regclass('public.daily_cardio_loads') IS NOT NULL AS v3_exists,
           (SELECT strain FROM daily_cardio WHERE user_id = $2 AND civil_date = '2026-08-01') AS legacy_strain`,
        [cardioLoadMigrationId, legacyUser],
      );
      assert.deepEqual(state.rows[0], { applied: false, v3_exists: false, legacy_strain: 8.4 });
    } finally {
      await afterFailure.end();
    }

    await writeFile(path.join(migrationsDir, cardioLoadMigrationId), fixedMigration);
    await writeFile(path.join(migrationsDir, cardioLoadUtilizationMigrationId), utilizationMigration);
    await migrate(databaseUrl, migrationsDir);

    const afterSuccess = new pg.Client({ connectionString: databaseUrl });
    await afterSuccess.connect();
    try {
      await insertTrimpRows(afterSuccess, legacyUser);
      await afterSuccess.query('DELETE FROM users WHERE id = $1', [legacyUser]);
      const rows = await afterSuccess.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM heart_rate_minute_evidence
         UNION ALL SELECT count(*)::text FROM daily_cardio_loads
         UNION ALL SELECT count(*)::text FROM weekly_cardio_baselines
         UNION ALL SELECT count(*)::text FROM daily_load_capacities`,
      );
      assert.deepEqual(rows.rows.map((row) => row.count), ['0', '0', '0', '0']);
    } finally {
      await afterSuccess.end();
    }
  } finally {
    try {
      if (created) await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(scratchDatabase)} WITH (FORCE)`);
    } finally {
      await admin.end();
      await rm(migrationsDir, { recursive: true, force: true });
    }
  }
});
