import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import pg from 'pg';

import { migrate } from '../../src/server/db/migrate';

const baseUrl = process.env.POSTGRES_INTEGRATION_BASE_URL;
const migrationId = '012_body_age_air_cn_v1.sql';
const dataGaps = JSON.stringify({
  dailyVo2DaysNeeded: 0,
  rhrDaysNeeded: 0,
  observedHrPeakRequired: false,
});
const exclusionCounts = JSON.stringify({
  invalidDailyVo2: 0,
  futureDailyVo2: 0,
  untrustedDailyVo2: 0,
  invalidDailyRhr: 0,
  futureDailyRhr: 0,
  untrustedDailyRhr: 0,
});

function scratchUrl(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function quoteIdentifier(identifier: string): string {
  if (!/^fitbit_body_age_it_[a-f0-9]+$/u.test(identifier)) {
    throw new Error('unsafe scratch database identifier');
  }
  return `"${identifier}"`;
}

async function insertUser(client: pg.Client): Promise<string> {
  const userId = randomUUID();
  await client.query('INSERT INTO users (id) VALUES ($1)', [userId]);
  return userId;
}

async function assertCheckViolation(work: () => Promise<unknown>): Promise<void> {
  await assert.rejects(work(), (error: unknown) => (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code: unknown }).code === '23514'
  ));
}

async function assertFloatConstraints(client: pg.Client): Promise<void> {
  const observedAt = new Date('2026-09-03T12:00:00.000Z');
  const validUser = await insertUser(client);
  await client.query(
    `INSERT INTO user_body_age_profiles (
      user_id, historical_observed_hr_peak_bpm, first_observed_hr_peak_at, latest_observed_hr_peak_at
    ) VALUES ($1,$2,$3,$3)`,
    [validUser, 181, observedAt],
  );
  await client.query(
    `INSERT INTO air_daily_vo2 (
      user_id, source_family, civil_date, vo2_max, estimated, received_at, revision
    ) VALUES ($1,'google-wearables','2026-09-03',$2,false,$3,0)`,
    [validUser, 101, observedAt],
  );
  await client.query(
    `INSERT INTO body_age_results (
      user_id, algorithm_version, age_years, route, status, coverage_days, latest_input_civil_date,
      last_calculated_civil_date, reference_version, reference_hash, input_fingerprint, profile_revision,
      chronological_age_delta_years, data_gaps, window_days, exclusion_counts, computed_at
    ) VALUES ($1,$2,39,'daily_vo2','daily_vo2_provisional',7,'2026-09-03',
      '2026-09-03','reference-v1','sha256:reference','sha256:input',0,$3,$4::jsonb,28,$5::jsonb,$6)`,
    [validUser, 'finite-delta', -2, dataGaps, exclusionCounts, observedAt],
  );

  for (const special of ['NaN', 'Infinity', '-Infinity'] as const) {
    const profileUser = await insertUser(client);
    await assertCheckViolation(() => client.query(
      `INSERT INTO user_body_age_profiles (
        user_id, historical_observed_hr_peak_bpm, first_observed_hr_peak_at, latest_observed_hr_peak_at
      ) VALUES ($1,$2::double precision,$3,$3)`,
      [profileUser, special, observedAt],
    ));

    const vo2User = await insertUser(client);
    await assertCheckViolation(() => client.query(
      `INSERT INTO air_daily_vo2 (
        user_id, source_family, civil_date, vo2_max, estimated, received_at, revision
      ) VALUES ($1,'google-wearables','2026-09-03',$2::double precision,false,$3,0)`,
      [vo2User, special, observedAt],
    ));

    const resultUser = await insertUser(client);
    await assertCheckViolation(() => client.query(
      `INSERT INTO body_age_results (
        user_id, algorithm_version, age_years, route, status, coverage_days, latest_input_civil_date,
        last_calculated_civil_date, reference_version, reference_hash, input_fingerprint, profile_revision,
        chronological_age_delta_years, data_gaps, window_days, exclusion_counts, computed_at
      ) VALUES ($1,$2,39,'daily_vo2','daily_vo2_provisional',7,'2026-09-03',
        '2026-09-03','reference-v1','sha256:reference','sha256:input',0,$3::double precision,$4::jsonb,28,$5::jsonb,$6)`,
      [resultUser, `special-delta-${special}`, special, dataGaps, exclusionCounts, observedAt],
    ));
  }
}

test('PostgreSQL 16 migration retries cleanly and rejects non-finite body-age floats', {
  skip: baseUrl ? false : 'set POSTGRES_INTEGRATION_BASE_URL to run PostgreSQL integration tests',
}, async () => {
  if (!baseUrl) throw new Error('POSTGRES_INTEGRATION_BASE_URL is required');

  const scratchDatabase = `fitbit_body_age_it_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = scratchUrl(baseUrl, scratchDatabase);
  const migrationsDir = await mkdtemp(path.join(tmpdir(), 'fitbit-body-age-migrations-'));
  const admin = new pg.Client({ connectionString: baseUrl });
  let created = false;

  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${quoteIdentifier(scratchDatabase)}`);
    created = true;

    await cp(path.join(process.cwd(), 'db/migrations'), migrationsDir, { recursive: true });
    const brokenMigrationPath = path.join(migrationsDir, migrationId);
    const fixedMigration = await readFile(brokenMigrationPath, 'utf8');
    const fixedPredicate = "historical_observed_hr_peak_bpm NOT IN ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)";
    assert.notEqual(fixedMigration.includes(fixedPredicate), false, 'test fixture must begin from the fixed migration');
    await writeFile(
      brokenMigrationPath,
      fixedMigration.replace(fixedPredicate, 'isfinite(historical_observed_hr_peak_bpm)'),
    );

    await assert.rejects(migrate(databaseUrl, migrationsDir), /function isfinite\(double precision\) does not exist/u);

    const afterFailure = new pg.Client({ connectionString: databaseUrl });
    await afterFailure.connect();
    try {
      const migration = await afterFailure.query<{ applied: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE id = $1) AS applied',
        [migrationId],
      );
      const table = await afterFailure.query<{ table_name: string | null }>(
        "SELECT to_regclass('public.user_body_age_profiles') AS table_name",
      );
      assert.equal(migration.rows[0]?.applied, false);
      assert.equal(table.rows[0]?.table_name, null);
    } finally {
      await afterFailure.end();
    }

    await migrate(databaseUrl);

    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const migration = await client.query<{ applied: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE id = $1) AS applied',
        [migrationId],
      );
      assert.equal(migration.rows[0]?.applied, true);
      await assertFloatConstraints(client);
    } finally {
      await client.end();
    }
  } finally {
    try {
      if (created) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(scratchDatabase)} WITH (FORCE)`);
      }
    } finally {
      await admin.end();
      await rm(migrationsDir, { recursive: true, force: true });
    }
  }
});
