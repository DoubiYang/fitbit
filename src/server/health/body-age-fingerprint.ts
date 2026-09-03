import { createHash } from 'node:crypto';

import referenceTable from '../../../data/reference/chinese-community-cycle-vo2peak-p50-v1.json';
import { calculateBodyAge, type BodyAgeEstimate, type BodyAgeProfile, type DailyRhrInput } from '../../domain/body-age';
import { civilDate, utcCivilDate } from '../time/civil-date';
import type { HealthTimeZoneHistory, StoredDailyVo2 } from './cardio-store';
import type { UserHealthRecords } from './provider';

export const BODY_AGE_TRUSTED_SOURCE_FAMILY = 'google-wearables';

export type BodyAgeFingerprintContext = {
  timeZone: string;
  asOfCivilDate: string;
  fromCivilDate: string;
};

export type BodyAgeFingerprintInput = {
  algorithmVersion: string;
  windowDays: number;
  userId: string;
  profile: BodyAgeProfile;
  timeZoneHistory: readonly HealthTimeZoneHistory[];
  now: Date;
  dailyVo2: readonly StoredDailyVo2[];
  records: UserHealthRecords;
  estimate?: Pick<BodyAgeEstimate, 'route'>;
  dailyRhr?: DailyRhrInput[];
};

function addCivilDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Body-age fingerprint input must be defined.');
  return serialized;
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function effectiveTimeZone(history: readonly HealthTimeZoneHistory[], now: Date): string {
  const current = [...history]
    .filter((row) => Date.parse(row.effectiveAt) <= now.getTime())
    .sort((left, right) => Date.parse(right.effectiveAt) - Date.parse(left.effectiveAt))[0]?.ianaTimeZone;
  if (!current) return 'UTC';
  try {
    civilDate(now, current);
    return current;
  } catch {
    return 'UTC';
  }
}

export function bodyAgeFingerprintContext(input: {
  timeZoneHistory: readonly HealthTimeZoneHistory[];
  now: Date;
  windowDays: number;
}): BodyAgeFingerprintContext {
  const timeZone = effectiveTimeZone(input.timeZoneHistory, input.now);
  const asOfCivilDate = timeZone === 'UTC' ? utcCivilDate(input.now) : civilDate(input.now, timeZone);
  return {
    timeZone,
    asOfCivilDate,
    fromCivilDate: addCivilDays(asOfCivilDate, -(input.windowDays - 1)),
  };
}

export function bodyAgeDailyRhrInputs(input: {
  records: UserHealthRecords;
  userId: string;
  receivedAt: string;
}): DailyRhrInput[] {
  return input.records.dailyRhr
    .filter((row) => row.userId === input.userId && row.source === 'google_health')
    .map((row) => ({
      date: row.date,
      valueBpm: row.valueBpm,
      sourceFamily: BODY_AGE_TRUSTED_SOURCE_FAMILY,
      receivedAt: input.receivedAt,
      revision: 0,
    }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

/**
 * Produces the server-only calculation fingerprint used for result freshness.
 * It deliberately returns only a digest, never the raw profile or health inputs.
 */
export function bodyAgeInputFingerprint(input: BodyAgeFingerprintInput): string {
  const context = bodyAgeFingerprintContext(input);
  const dailyRhr = input.dailyRhr ?? bodyAgeDailyRhrInputs({
    records: input.records,
    userId: input.userId,
    receivedAt: input.now.toISOString(),
  });
  const route = input.estimate?.route ?? calculateBodyAge({
    profile: input.profile,
    dailyVo2: [...input.dailyVo2],
    dailyRhr,
    asOfCivilDate: context.asOfCivilDate,
  }).route;
  const sortedDailyVo2 = [...input.dailyVo2]
    .sort((left, right) => left.civilDate.localeCompare(right.civilDate))
    .map(({ civilDate, vo2Max, estimated, sourceFamily }) => ({ civilDate, vo2Max, estimated, sourceFamily }));

  return sha256({
    algorithmVersion: input.algorithmVersion,
    referenceHash: referenceTable.canonicalPayloadSha256,
    windowDays: input.windowDays,
    profileRevision: input.profile.profileRevision,
    timeZone: context.timeZone,
    timeZoneHistory: [...input.timeZoneHistory]
      .sort((left, right) => (
        left.effectiveAt.localeCompare(right.effectiveAt)
        || left.ianaTimeZone.localeCompare(right.ianaTimeZone)
        || Number(left.isBackfillAnchor) - Number(right.isBackfillAnchor)
      ))
      .map(({ effectiveAt, ianaTimeZone, isBackfillAnchor }) => ({ effectiveAt, ianaTimeZone, isBackfillAnchor })),
    asOfCivilDate: context.asOfCivilDate,
    route,
    dailyVo2: sortedDailyVo2,
    dailyRhr: dailyRhr.map(({ date, valueBpm, sourceFamily }) => ({ date, valueBpm, sourceFamily })),
    observedHrPeakBpm: input.profile.observedHrPeakBpm ?? null,
  });
}
