import referenceTable from '../../../data/reference/chinese-community-cycle-vo2peak-p50-v1.json';
import { calculateBodyAge, type BodyAgeProfile } from '../../domain/body-age';
import type { HealthMetricsStore, StoredDailyVo2 } from './cardio-store';
import {
  BODY_AGE_TRUSTED_SOURCE_FAMILY,
  bodyAgeDailyRhrInputs,
  bodyAgeFingerprintContext,
  bodyAgeInputFingerprint,
} from './body-age-fingerprint';
import type { UserHealthRecords } from './provider';

export const BODY_AGE_ALGORITHM_VERSION = 'body-age-air-cn-v1';
export const BODY_AGE_WINDOW_DAYS = 28;

type ExclusionKind = 'invalid' | 'future' | 'untrusted';

function isCivilDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const instant = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}

function isStrictInstant(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function classifyDailyVo2(row: StoredDailyVo2, asOf: string): ExclusionKind | undefined {
  if (row.sourceFamily !== BODY_AGE_TRUSTED_SOURCE_FAMILY) return 'untrusted';
  if (
    !isCivilDate(row.civilDate)
    || !Number.isFinite(row.vo2Max)
    || row.vo2Max <= 0
    || !isStrictInstant(row.receivedAt)
    || !Number.isSafeInteger(row.revision)
    || row.revision < 0
  ) return 'invalid';
  return row.civilDate > asOf ? 'future' : undefined;
}

function exclusionCounts(input: {
  dailyVo2: StoredDailyVo2[];
  records: UserHealthRecords;
  asOf: string;
}) {
  const counts = {
    invalidDailyVo2: 0,
    futureDailyVo2: 0,
    untrustedDailyVo2: 0,
    invalidDailyRhr: 0,
    futureDailyRhr: 0,
    untrustedDailyRhr: 0,
  };
  for (const row of input.dailyVo2) {
    const kind = classifyDailyVo2(row, input.asOf);
    if (kind === 'invalid') counts.invalidDailyVo2 += 1;
    else if (kind === 'future') counts.futureDailyVo2 += 1;
    else if (kind === 'untrusted') counts.untrustedDailyVo2 += 1;
  }
  for (const row of input.records.dailyRhr) {
    if (row.source !== 'google_health') {
      counts.untrustedDailyRhr += 1;
    } else if (!isCivilDate(row.date) || !Number.isFinite(row.valueBpm) || row.valueBpm < 30 || row.valueBpm > 120) {
      counts.invalidDailyRhr += 1;
    } else if (row.date > input.asOf) {
      counts.futureDailyRhr += 1;
    }
  }
  return counts;
}

function chronologicalAgeAt(birthDate: string | undefined, asOf: string): number | undefined {
  if (!birthDate || !isCivilDate(birthDate)) return undefined;
  const years = Number(asOf.slice(0, 4)) - Number(birthDate.slice(0, 4));
  const birthdayThisYear = `${asOf.slice(0, 4)}-${birthDate.slice(5)}`;
  const age = asOf < birthdayThisYear ? years - 1 : years;
  return age >= 0 && age <= 130 ? age : undefined;
}

/**
 * Computes and stores the server-only body-age result. Callers deliberately own
 * exception isolation so a failed estimate cannot fail heart, sleep, or recovery sync.
 */
export async function recomputeBodyAge(input: {
  store: HealthMetricsStore;
  userId: string;
  now: Date;
  records: UserHealthRecords;
}): Promise<void> {
  const [profileRow, history, currentResult] = await Promise.all([
    input.store.getBodyAgeProfile({ userId: input.userId }),
    input.store.listTimeZoneHistory(input.userId),
    input.store.readLatestBodyAgeResult({ userId: input.userId, algorithmVersion: BODY_AGE_ALGORITHM_VERSION }),
  ]);
  const fingerprintContext = bodyAgeFingerprintContext({
    timeZoneHistory: history,
    now: input.now,
    windowDays: BODY_AGE_WINDOW_DAYS,
  });
  const { asOfCivilDate: asOf, fromCivilDate } = fingerprintContext;
  const dailyVo2 = await input.store.listDailyVo2({ userId: input.userId, fromCivilDate, toCivilDate: asOf });
  const profile: BodyAgeProfile = {
    birthDate: profileRow?.birthDate,
    referenceSex: profileRow?.referenceSex,
    profileRevision: profileRow?.profileRevision ?? 0,
    observedHrPeakBpm: profileRow?.observedHrPeakBpm,
  };
  const receivedAt = input.now.toISOString();
  const dailyRhr = bodyAgeDailyRhrInputs({ records: input.records, userId: input.userId, receivedAt });
  const estimate = calculateBodyAge({ profile, dailyVo2, dailyRhr, asOfCivilDate: asOf });
  const chronologicalAge = chronologicalAgeAt(profile.birthDate, asOf);
  const chronologicalAgeDeltaYears = typeof estimate.age === 'number' && chronologicalAge !== undefined
    ? estimate.age - chronologicalAge
    : null;
  const lastCalculatedCivilDate = estimate.status === 'stale'
    && currentResult
    && (currentResult.estimate.age !== null || currentResult.estimate.status === 'stale')
    ? currentResult.lastCalculatedCivilDate
    : asOf;
  const fingerprint = bodyAgeInputFingerprint({
    algorithmVersion: BODY_AGE_ALGORITHM_VERSION,
    windowDays: BODY_AGE_WINDOW_DAYS,
    userId: input.userId,
    profile,
    timeZoneHistory: history,
    now: input.now,
    dailyVo2,
    records: input.records,
    estimate,
    dailyRhr,
  });
  await input.store.writeBodyAgeResult({
    userId: input.userId,
    algorithmVersion: BODY_AGE_ALGORITHM_VERSION,
    estimate,
    lastCalculatedCivilDate,
    referenceHash: referenceTable.canonicalPayloadSha256,
    inputFingerprint: fingerprint,
    profileRevision: profile.profileRevision,
    chronologicalAgeDeltaYears,
    windowDays: BODY_AGE_WINDOW_DAYS,
    exclusionCounts: exclusionCounts({ dailyVo2, records: input.records, asOf }),
    computedAt: receivedAt,
  });
}
