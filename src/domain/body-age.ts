import referenceTable from '../../data/reference/chinese-community-cycle-vo2peak-p50-v1.json';

const DAY_MS = 24 * 60 * 60 * 1_000;
const WINDOW_DAYS = 28;
const FRESHNESS_DAYS = 7;
const DAILY_VO2_PROVISIONAL_DAYS = 7;
const DAILY_VO2_STABLE_DAYS = 21;
const RHR_MIN_BPM = 30;
const RHR_MAX_BPM = 120;
const OBSERVED_PEAK_MIN_BPM = 100;
const OBSERVED_PEAK_MAX_BPM = 230;

export const BODY_AGE_REFERENCE_VERSION = referenceTable.version;

export type BodyAgeProfile = {
  birthDate?: string;
  referenceSex?: 'male' | 'female';
  profileRevision: number;
  /** Highest valid Air minute BPM observed since this account was connected; not a physiological HRmax. */
  observedHrPeakBpm?: number;
};

export type DailyVo2Input = {
  civilDate: string;
  vo2Max: number;
  /** Only this trusted Google Health source family participates; this is not a device-model assertion. */
  sourceFamily: string;
  /** Receipt timestamp for deterministic same-civil-date revisions. */
  receivedAt: string;
  /** Monotonically increasing source revision used when receipt timestamps tie. */
  revision: number;
  /** Air may mark the daily value estimated; v1 still treats it as usable daily input. */
  estimated?: boolean;
};

export type DailyRhrInput = {
  date: string;
  valueBpm: number;
  /** Only this trusted Google Health source family participates; this is not a device-model assertion. */
  sourceFamily: string;
  /** Receipt timestamp for deterministic same-civil-date revisions. */
  receivedAt: string;
  /** Monotonically increasing source revision used when receipt timestamps tie. */
  revision: number;
};

export type BodyAgeInput = {
  profile: BodyAgeProfile;
  dailyVo2: DailyVo2Input[];
  dailyRhr: DailyRhrInput[];
  asOfCivilDate: string;
};

export type BodyAgeRoute = 'daily_vo2' | 'observed_peak_ratio' | null;
export type BodyAgeStatus =
  | 'profile_missing'
  | 'data_accumulating'
  | 'daily_vo2_provisional'
  | 'daily_vo2_stable'
  | 'observed_peak_ratio_provisional'
  | 'stale';
export type BodyAgeValue = number | 'below_reference_min' | 'above_reference_max';

export type BodyAgeDataGaps = {
  dailyVo2DaysNeeded: number;
  rhrDaysNeeded: number;
  observedHrPeakRequired: boolean;
};

/**
 * A display-safe result. It deliberately excludes birth date, daily VO2, daily RHR,
 * observed peak BPM, and any provider/source identifiers.
 */
export type BodyAgeEstimate = {
  age: BodyAgeValue | null;
  coverageDays: number;
  latestInputCivilDate: string | null;
  route: BodyAgeRoute;
  status: BodyAgeStatus;
  referenceVersion: string;
  disclaimer: 'non_medical_non_calibrated_estimate';
  dataGaps: BodyAgeDataGaps;
};

type DatedNumber = {
  civilDate: string;
  dayIndex: number;
  value: number;
};

type RevisionedDatedValueInput = {
  civilDate: string;
  value: number;
  sourceFamily: string;
  receivedAt: string;
  revision: number;
};

export type ObservedHeartRateMinute = {
  /** Only this trusted Google Health source family participates; this is not a device-model assertion. */
  sourceFamily: string;
  sampleCount: number;
  coverageSeconds: number;
  maxBpm: number;
};

function civilDayIndex(civilDate: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(civilDate)) {
    return null;
  }

  const timestamp = Date.parse(`${civilDate}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== civilDate) {
    return null;
  }

  return Math.floor(timestamp / DAY_MS);
}

function requiredGaps(dailyVo2Count: number, rhrCount: number, observedPeakAvailable: boolean): BodyAgeDataGaps {
  return {
    dailyVo2DaysNeeded: Math.max(0, DAILY_VO2_PROVISIONAL_DAYS - dailyVo2Count),
    rhrDaysNeeded: Math.max(0, DAILY_VO2_PROVISIONAL_DAYS - rhrCount),
    observedHrPeakRequired: !observedPeakAvailable,
  };
}

function noDataGaps(): BodyAgeDataGaps {
  return {
    dailyVo2DaysNeeded: 0,
    rhrDaysNeeded: 0,
    observedHrPeakRequired: false,
  };
}

function result(
  overrides: Pick<BodyAgeEstimate, 'age' | 'coverageDays' | 'latestInputCivilDate' | 'route' | 'status'>,
  dataGaps: BodyAgeDataGaps,
): BodyAgeEstimate {
  return {
    ...overrides,
    referenceVersion: BODY_AGE_REFERENCE_VERSION,
    disclaimer: 'non_medical_non_calibrated_estimate',
    dataGaps,
  };
}

function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function latestDate(values: DatedNumber[]): string | null {
  return values.reduce<string | null>((latest, value) => (latest === null || value.civilDate > latest ? value.civilDate : latest), null);
}

function newestDate(left: string | null, right: string | null): string | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return left > right ? left : right;
}

function isFresh(latestCivilDate: string, asOfDayIndex: number): boolean {
  const latestDayIndex = civilDayIndex(latestCivilDate);
  return latestDayIndex !== null && asOfDayIndex - latestDayIndex <= FRESHNESS_DAYS;
}

function instantTimestamp(instant: string): number | null {
  if (
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(instant) ||
    civilDayIndex(instant.slice(0, 10)) === null
  ) {
    return null;
  }
  const timestamp = Date.parse(instant);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isEligibleObservedPeakBpm(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= OBSERVED_PEAK_MIN_BPM &&
    value <= OBSERVED_PEAK_MAX_BPM
  );
}

/**
 * Monotonically updates the account's observed Air peak from eligible minute
 * aggregates. The value is an observed peak, not a physiological HRmax.
 */
export function updateObservedHrPeakBpm(
  existingObservedPeakBpm: number | undefined,
  minuteSamples: ObservedHeartRateMinute[],
): number | undefined {
  let observedPeak = isEligibleObservedPeakBpm(existingObservedPeakBpm) ? existingObservedPeakBpm : undefined;

  for (const minute of minuteSamples) {
    if (
      minute.sourceFamily !== 'google-wearables' ||
      !Number.isFinite(minute.sampleCount) ||
      minute.sampleCount <= 0 ||
      !Number.isFinite(minute.coverageSeconds) ||
      minute.coverageSeconds < 30 ||
      !isEligibleObservedPeakBpm(minute.maxBpm)
    ) {
      continue;
    }
    observedPeak = observedPeak === undefined ? minute.maxBpm : Math.max(observedPeak, minute.maxBpm);
  }

  return observedPeak;
}

function validRevisionedDatedValues(
  records: RevisionedDatedValueInput[],
  asOfDayIndex: number,
  minValue: number,
  maxValue: number,
  metricName: string,
): DatedNumber[] {
  const byDate = new Map<
    string,
    DatedNumber & { receivedAtTimestamp: number; revision: number; valuesAtHighestPriority: Set<number> }
  >();
  const oldestAllowedDayIndex = asOfDayIndex - (WINDOW_DAYS - 1);

  for (const record of records) {
    const dayIndex = civilDayIndex(record.civilDate);
    const receivedAtTimestamp = instantTimestamp(record.receivedAt);
    if (
      record.sourceFamily !== 'google-wearables' ||
      dayIndex === null ||
      dayIndex < oldestAllowedDayIndex ||
      dayIndex > asOfDayIndex ||
      !Number.isFinite(record.value) ||
      record.value < minValue ||
      record.value > maxValue ||
      receivedAtTimestamp === null ||
      !Number.isSafeInteger(record.revision) ||
      record.revision < 0
    ) {
      continue;
    }

    const candidate = {
      civilDate: record.civilDate,
      dayIndex,
      value: record.value,
      receivedAtTimestamp,
      revision: record.revision,
      valuesAtHighestPriority: new Set([record.value]),
    };
    const existing = byDate.get(record.civilDate);
    if (
      existing === undefined ||
      candidate.receivedAtTimestamp > existing.receivedAtTimestamp ||
      (candidate.receivedAtTimestamp === existing.receivedAtTimestamp && candidate.revision > existing.revision)
    ) {
      byDate.set(record.civilDate, candidate);
      continue;
    }

    if (
      candidate.receivedAtTimestamp === existing.receivedAtTimestamp &&
      candidate.revision === existing.revision
    ) {
      existing.valuesAtHighestPriority.add(candidate.value);
    }
  }

  return [...byDate.values()].map((candidate) => {
    if (candidate.valuesAtHighestPriority.size > 1) {
      throw new Error(`Conflicting ${metricName} revisions for ${candidate.civilDate}.`);
    }
    return {
      civilDate: candidate.civilDate,
      dayIndex: candidate.dayIndex,
      value: candidate.value,
    };
  });
}

function mapVo2ToBodyAge(referenceSex: 'male' | 'female', vo2: number): BodyAgeValue {
  const valueKey = referenceSex === 'male' ? 'maleP50' : 'femaleP50';
  const anchors = referenceTable.anchors;
  const youngest = anchors[0]!;
  const oldest = anchors[anchors.length - 1]!;

  if (vo2 > youngest[valueKey]) {
    return 'below_reference_min';
  }
  if (vo2 < oldest[valueKey]) {
    return 'above_reference_max';
  }

  for (let index = 0; index < anchors.length - 1; index += 1) {
    const younger = anchors[index]!;
    const older = anchors[index + 1]!;
    if (vo2 <= younger[valueKey] && vo2 >= older[valueKey]) {
      const progress = (younger[valueKey] - vo2) / (younger[valueKey] - older[valueKey]);
      return Math.round(younger.ageYears + progress * (older.ageYears - younger.ageYears));
    }
  }

  return oldest.ageYears;
}

function hasCompleteProfile(profile: BodyAgeProfile): profile is BodyAgeProfile & {
  birthDate: string;
  referenceSex: 'male' | 'female';
} {
  return civilDayIndex(profile.birthDate ?? '') !== null && (profile.referenceSex === 'male' || profile.referenceSex === 'female');
}

function isObservedPeakAvailable(profile: BodyAgeProfile): boolean {
  return isEligibleObservedPeakBpm(profile.observedHrPeakBpm);
}

/**
 * Maps current Air-derived cardiorespiratory inputs to a Wang 2022 Chinese
 * community cycle-CPET reference. This is a non-medical, non-calibrated estimate.
 * The observed-peak route is only a proxy: observed peak BPM is never treated as HRmax.
 */
export function calculateBodyAge(input: BodyAgeInput): BodyAgeEstimate {
  if (!hasCompleteProfile(input.profile)) {
    return result(
      {
        age: null,
        coverageDays: 0,
        latestInputCivilDate: null,
        route: null,
        status: 'profile_missing',
      },
      requiredGaps(0, 0, false),
    );
  }

  const asOfDayIndex = civilDayIndex(input.asOfCivilDate);
  if (asOfDayIndex === null) {
    throw new Error('asOfCivilDate must be a valid YYYY-MM-DD civil date.');
  }

  const dailyVo2 = validRevisionedDatedValues(
    input.dailyVo2.map((record) => ({
      civilDate: record.civilDate,
      value: record.vo2Max,
      sourceFamily: record.sourceFamily,
      receivedAt: record.receivedAt,
      revision: record.revision,
    })),
    asOfDayIndex,
    Number.MIN_VALUE,
    Number.POSITIVE_INFINITY,
    'daily VO2',
  );
  const dailyRhr = validRevisionedDatedValues(
    input.dailyRhr.map((record) => ({
      civilDate: record.date,
      value: record.valueBpm,
      sourceFamily: record.sourceFamily,
      receivedAt: record.receivedAt,
      revision: record.revision,
    })),
    asOfDayIndex,
    RHR_MIN_BPM,
    RHR_MAX_BPM,
    'daily RHR',
  ).sort((left, right) => right.dayIndex - left.dayIndex);
  const observedPeakAvailable = isObservedPeakAvailable(input.profile);
  const gaps = requiredGaps(dailyVo2.length, dailyRhr.length, observedPeakAvailable);
  const latestDailyVo2Date = latestDate(dailyVo2);

  if (dailyVo2.length >= DAILY_VO2_PROVISIONAL_DAYS) {
    if (latestDailyVo2Date === null || !isFresh(latestDailyVo2Date, asOfDayIndex)) {
      return result(
        {
          age: null,
          coverageDays: dailyVo2.length,
          latestInputCivilDate: latestDailyVo2Date,
          route: 'daily_vo2',
          status: 'stale',
        },
        noDataGaps(),
      );
    }

    return result(
      {
        age: mapVo2ToBodyAge(input.profile.referenceSex, median(dailyVo2.map((record) => record.value))),
        coverageDays: dailyVo2.length,
        latestInputCivilDate: latestDailyVo2Date,
        route: 'daily_vo2',
        status: dailyVo2.length >= DAILY_VO2_STABLE_DAYS ? 'daily_vo2_stable' : 'daily_vo2_provisional',
      },
      noDataGaps(),
    );
  }

  const latestSevenRhr = dailyRhr.slice(0, DAILY_VO2_PROVISIONAL_DAYS);
  const latestRhrDate = latestSevenRhr[0]?.civilDate ?? null;
  if (latestSevenRhr.length >= DAILY_VO2_PROVISIONAL_DAYS && observedPeakAvailable) {
    if (latestRhrDate === null || !isFresh(latestRhrDate, asOfDayIndex)) {
      return result(
        {
          age: null,
          coverageDays: latestSevenRhr.length,
          latestInputCivilDate: latestRhrDate,
          route: 'observed_peak_ratio',
          status: 'stale',
        },
        noDataGaps(),
      );
    }

    const estimatedVo2Proxy = 15.3 * (input.profile.observedHrPeakBpm! / median(latestSevenRhr.map((record) => record.value)));
    return result(
      {
        age: mapVo2ToBodyAge(input.profile.referenceSex, estimatedVo2Proxy),
        coverageDays: latestSevenRhr.length,
        latestInputCivilDate: latestRhrDate,
        route: 'observed_peak_ratio',
        status: 'observed_peak_ratio_provisional',
      },
      noDataGaps(),
    );
  }

  return result(
    {
      age: null,
      coverageDays: Math.max(dailyVo2.length, dailyRhr.length),
      latestInputCivilDate: newestDate(latestDailyVo2Date, latestDate(dailyRhr)),
      route: null,
      status: 'data_accumulating',
    },
    gaps,
  );
}
