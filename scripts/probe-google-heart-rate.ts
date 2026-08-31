import { readFileSync } from 'node:fs';
import path, { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig } from '../src/server/config/env';
import { getPool, getPostgresStore } from '../src/server/db/postgres-store';
import { createGoogleTokenRefresher, resolveAccessToken } from '../src/server/health/access-token';
import { createHealthApiClient } from '../src/server/health/health-api';
import { civilDateFrom, parseNumeric } from '../src/server/health/proto';

// Observed Fitbit Air facts live in docs/superpowers/specs/2026-08-31-google-heart-rate-whoop-style-metrics-design.md section 9.
// heart-rate list returns 400 on this account; queries reuse reconcile + google-wearables. Output is counts/labels only.
const GOOGLE_WEARABLES_SOURCE_FAMILY = 'google-wearables';
const SAMPLE_LOOKBACK_MS = 10 * 60 * 1000;
const DAILY_WINDOW_BEFORE_DAYS = 1;
const DAILY_WINDOW_UNTIL_EXCLUSIVE_DAYS = 2;
const SAMPLE_PAGE_SIZE = 1000;
const DAILY_PAGE_SIZE = 25;
const ACTIVITY_LEVEL_ORDER = ['SEDENTARY', 'LIGHTLY_ACTIVE', 'MODERATELY_ACTIVE', 'VERY_ACTIVE'] as const;
const ZONE_ORDER = ['LIGHT', 'MODERATE', 'VIGOROUS', 'PEAK'] as const;
const PROBE_DATA_TYPES = ['heart-rate', 'activity-level', 'daily-heart-rate-zones', 'time-in-heart-rate-zone'] as const;

type ProbeDataType = (typeof PROBE_DATA_TYPES)[number];

type ProbeInterval = {
  startTime?: string;
  endTime?: string;
};

export type HeartRateProbePoint = {
  name?: string;
  dataPointName?: string;
  heartRate?: {
    sampleTime?: { physicalTime?: string; utcOffset?: string; civilTime?: unknown };
    beatsPerMinute?: string | number;
    metadata?: { motionContext?: string };
  };
  activityLevel?: {
    interval?: ProbeInterval;
    activityLevelType?: string;
  };
  dailyHeartRateZones?: {
    date?: { year?: number; month?: number; day?: number };
    heartRateZones?: Array<{
      heartRateZoneType?: string;
      minBeatsPerMinute?: string | number;
      maxBeatsPerMinute?: string | number;
    }>;
  };
  timeInHeartRateZone?: {
    interval?: ProbeInterval;
    heartRateZoneType?: string;
    duration?: unknown;
  };
};

export type HeartRateProbeApi = {
  listDataPoints(input: {
    accessToken: string;
    dataType: string;
    filter: string;
    pageSize?: number;
  }): Promise<HeartRateProbePoint[]>;
};

export type HeartRateCapabilityReport = {
  sourceFamily: typeof GOOGLE_WEARABLES_SOURCE_FAMILY;
  lookbackMinutes: number;
  lookbackDays: number;
  heartRate: {
    available: boolean;
    pointCount: number;
    hasMotionContext: boolean;
  };
  activityLevel: {
    available: boolean;
    intervalCount: number;
    types: string[];
  };
  dailyHeartRateZones: {
    available: boolean;
    dayCount: number;
    dates: string[];
    zoneLabels: string[];
    adjacentZonesHaveOneBpmGap: boolean;
  };
  timeInHeartRateZone: {
    available: boolean;
    intervalCount: number;
    zoneLabels: string[];
    hasDurationField: boolean;
    intervalSeconds: number[];
  };
};

function heartRateCapabilityFilter(dataType: ProbeDataType, from: string, untilExclusive: string): string {
  switch (dataType) {
    case 'heart-rate':
      return `heart_rate.sample_time.physical_time >= "${from}" AND heart_rate.sample_time.physical_time < "${untilExclusive}"`;
    case 'activity-level':
      return `activity_level.interval.start_time >= "${from}" AND activity_level.interval.start_time < "${untilExclusive}"`;
    case 'daily-heart-rate-zones':
      return `daily_heart_rate_zones.date >= "${from}" AND daily_heart_rate_zones.date < "${untilExclusive}"`;
    case 'time-in-heart-rate-zone':
      return `time_in_heart_rate_zone.interval.start_time >= "${from}" AND time_in_heart_rate_zone.interval.start_time < "${untilExclusive}"`;
  }
}

function orderedLabels(values: Array<string | undefined>, preferred: readonly string[]): string[] {
  const unique = [...new Set(values.filter((value): value is string => Boolean(value)))];
  return [...preferred.filter((value) => unique.includes(value)), ...unique.filter((value) => !preferred.includes(value)).sort()];
}

function utcCivilDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addUtcDays(civilDate: string, days: number): string {
  const next = new Date(`${civilDate}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function intervalSeconds(interval: ProbeInterval | undefined): number | undefined {
  if (!interval?.startTime || !interval.endTime) {
    return undefined;
  }
  const ms = Date.parse(interval.endTime) - Date.parse(interval.startTime);
  if (!Number.isFinite(ms) || ms <= 0) {
    return undefined;
  }
  return Math.round(ms / 1000);
}

function adjacentZonesHaveOneBpmGap(
  zones: Array<{ heartRateZoneType?: string; minBeatsPerMinute?: string | number; maxBeatsPerMinute?: string | number }>,
): boolean {
  const byType = new Map<string, { min: number; max: number }>();
  for (const zone of zones) {
    const min = parseNumeric(zone.minBeatsPerMinute);
    const max = parseNumeric(zone.maxBeatsPerMinute);
    if (!zone.heartRateZoneType || min === undefined || max === undefined || min > max) {
      return false;
    }
    byType.set(zone.heartRateZoneType, { min, max });
  }
  if (ZONE_ORDER.some((label) => !byType.has(label))) {
    return false;
  }
  for (let index = 0; index < ZONE_ORDER.length - 1; index += 1) {
    const current = byType.get(ZONE_ORDER[index])!;
    const next = byType.get(ZONE_ORDER[index + 1])!;
    if (current.max + 1 !== next.min) {
      return false;
    }
  }
  return true;
}

function summarizeHeartRateCapabilities(input: {
  heartRate: HeartRateProbePoint[];
  activityLevel: HeartRateProbePoint[];
  dailyHeartRateZones: HeartRateProbePoint[];
  timeInHeartRateZone: HeartRateProbePoint[];
}): HeartRateCapabilityReport {
  const heartRatePoints = input.heartRate.filter((point) => point.heartRate);
  const activityPoints = input.activityLevel.filter((point) => point.activityLevel);
  const zonePoints = input.dailyHeartRateZones.filter((point) => point.dailyHeartRateZones);
  const timeInZonePoints = input.timeInHeartRateZone.filter((point) => point.timeInHeartRateZone);
  const zoneDates = [
    ...new Set(zonePoints.flatMap((point) => {
      const date = civilDateFrom(point.dailyHeartRateZones?.date);
      return date ? [date] : [];
    })),
  ].sort();
  const zoneLabels = orderedLabels(
    zonePoints.flatMap((point) => (point.dailyHeartRateZones?.heartRateZones ?? []).map((zone) => zone.heartRateZoneType)),
    ZONE_ORDER,
  );
  const completeZoneDays = zonePoints.flatMap((point) => {
    const zones = point.dailyHeartRateZones?.heartRateZones ?? [];
    return zones.length > 0 ? [zones] : [];
  });

  return {
    sourceFamily: GOOGLE_WEARABLES_SOURCE_FAMILY,
    lookbackMinutes: SAMPLE_LOOKBACK_MS / 60_000,
    lookbackDays: DAILY_WINDOW_BEFORE_DAYS + DAILY_WINDOW_UNTIL_EXCLUSIVE_DAYS,
    heartRate: {
      available: heartRatePoints.length > 0,
      pointCount: heartRatePoints.length,
      hasMotionContext: heartRatePoints.some((point) => point.heartRate?.metadata?.motionContext != null),
    },
    activityLevel: {
      available: activityPoints.length > 0,
      intervalCount: activityPoints.length,
      types: orderedLabels(
        activityPoints.map((point) => point.activityLevel?.activityLevelType),
        ACTIVITY_LEVEL_ORDER,
      ),
    },
    dailyHeartRateZones: {
      available: zonePoints.length > 0,
      dayCount: zoneDates.length,
      dates: zoneDates,
      zoneLabels,
      adjacentZonesHaveOneBpmGap:
        completeZoneDays.length > 0 && completeZoneDays.every((zones) => adjacentZonesHaveOneBpmGap(zones)),
    },
    timeInHeartRateZone: {
      available: timeInZonePoints.length > 0,
      intervalCount: timeInZonePoints.length,
      zoneLabels: orderedLabels(
        timeInZonePoints.map((point) => point.timeInHeartRateZone?.heartRateZoneType),
        ZONE_ORDER,
      ),
      hasDurationField: timeInZonePoints.some((point) =>
        point.timeInHeartRateZone != null && 'duration' in point.timeInHeartRateZone && point.timeInHeartRateZone.duration != null,
      ),
      intervalSeconds: [
        ...new Set(
          timeInZonePoints.flatMap((point) => {
            const seconds = intervalSeconds(point.timeInHeartRateZone?.interval);
            return seconds === undefined ? [] : [seconds];
          }),
        ),
      ].sort((left, right) => left - right),
    },
  };
}

export async function probeGoogleHeartRateCapabilities(input: {
  accessToken: string;
  now?: Date;
  api?: HeartRateProbeApi;
}): Promise<HeartRateCapabilityReport> {
  const now = input.now ?? new Date();
  const api = input.api ?? (createHealthApiClient() as HeartRateProbeApi);
  const sampleUntil = now.toISOString();
  const sampleFrom = new Date(now.getTime() - SAMPLE_LOOKBACK_MS).toISOString();
  const today = utcCivilDate(now);
  // Cover any legal UTC offset for a small recent window: UTC today-1 through UTC today+2 exclusive.
  const dailyFrom = addUtcDays(today, -DAILY_WINDOW_BEFORE_DAYS);
  const dailyUntilExclusive = addUtcDays(today, DAILY_WINDOW_UNTIL_EXCLUSIVE_DAYS);

  const [heartRate, activityLevel, dailyHeartRateZones, timeInHeartRateZone] = await Promise.all([
    api.listDataPoints({
      accessToken: input.accessToken,
      dataType: 'heart-rate',
      filter: heartRateCapabilityFilter('heart-rate', sampleFrom, sampleUntil),
      pageSize: SAMPLE_PAGE_SIZE,
    }),
    api.listDataPoints({
      accessToken: input.accessToken,
      dataType: 'activity-level',
      filter: heartRateCapabilityFilter('activity-level', sampleFrom, sampleUntil),
      pageSize: SAMPLE_PAGE_SIZE,
    }),
    api.listDataPoints({
      accessToken: input.accessToken,
      dataType: 'daily-heart-rate-zones',
      filter: heartRateCapabilityFilter('daily-heart-rate-zones', dailyFrom, dailyUntilExclusive),
      pageSize: DAILY_PAGE_SIZE,
    }),
    api.listDataPoints({
      accessToken: input.accessToken,
      dataType: 'time-in-heart-rate-zone',
      filter: heartRateCapabilityFilter('time-in-heart-rate-zone', sampleFrom, sampleUntil),
      pageSize: SAMPLE_PAGE_SIZE,
    }),
  ]);

  return summarizeHeartRateCapabilities({ heartRate, activityLevel, dailyHeartRateZones, timeInHeartRateZone });
}

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

function hostDatabaseUrl(): string {
  const user = process.env.POSTGRES_USER ?? 'rhythm';
  const password = process.env.POSTGRES_PASSWORD ?? '';
  const database = process.env.POSTGRES_DB ?? 'rhythm';
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:5432/${encodeURIComponent(database)}`;
}

async function main(): Promise<void> {
  loadEnvFile(path.join(process.cwd(), '.env.local'));
  process.env.DATABASE_URL = hostDatabaseUrl();
  const config = loadConfig();
  if (config.kind !== 'oauth') {
    throw new Error(`config is ${config.kind}`);
  }
  const pool = getPool(config.databaseUrl);
  try {
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
      throw new Error('no syncable google health connection');
    }
    const store = getPostgresStore(config.databaseUrl);
    const connection = await store.connections.findByUserId(userId);
    if (!connection) {
      throw new Error('connection row missing after list');
    }
    const accessToken = await resolveAccessToken({
      config,
      store,
      connection,
      refresher: createGoogleTokenRefresher(config),
    });
    const report = await probeGoogleHeartRateCapabilities({ accessToken });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'probe failed');
    process.exitCode = 1;
  });
}
