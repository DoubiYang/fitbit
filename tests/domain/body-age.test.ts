import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import referenceTable from '../../data/reference/chinese-community-cycle-vo2peak-p50-v1.json';
import { BODY_AGE_REFERENCE_VERSION, calculateBodyAge, updateObservedHrPeakBpm } from '../../src/domain/body-age';

const AS_OF = '2026-09-01';
const DAY_MS = 24 * 60 * 60 * 1_000;

function civilDateDaysBefore(daysBefore: number): string {
  return new Date(Date.UTC(2026, 8, 1) - daysBefore * DAY_MS).toISOString().slice(0, 10);
}

function dailyVo2Record(
  civilDate: string,
  vo2Max: number,
  options: { estimated?: boolean; sourceFamily?: string; receivedAt?: string; revision?: number } = {},
) {
  return {
    civilDate,
    vo2Max,
    sourceFamily: options.sourceFamily ?? 'google-wearables',
    receivedAt: options.receivedAt ?? '2026-09-01T12:00:00.000Z',
    revision: options.revision ?? 1,
    ...(options.estimated === undefined ? {} : { estimated: options.estimated }),
  };
}

function dailyVo2(
  count: number,
  vo2Max: number,
  options: { latestDaysBefore?: number; estimated?: boolean; sourceFamily?: string; receivedAt?: string; revision?: number } = {},
) {
  const latestDaysBefore = options.latestDaysBefore ?? 0;
  return Array.from({ length: count }, (_, index) =>
    dailyVo2Record(civilDateDaysBefore(latestDaysBefore + index), vo2Max, options),
  );
}

function dailyRhrRecord(
  date: string,
  valueBpm: number,
  options: { sourceFamily?: string; receivedAt?: string; revision?: number } = {},
) {
  return {
    date,
    valueBpm,
    sourceFamily: options.sourceFamily ?? 'google-wearables',
    receivedAt: options.receivedAt ?? '2026-09-01T12:00:00.000Z',
    revision: options.revision ?? 1,
  };
}

function dailyRhr(
  values: number[],
  options: { latestDaysBefore?: number; sourceFamily?: string; receivedAt?: string; revision?: number } = {},
) {
  const latestDaysBefore = options.latestDaysBefore ?? 0;
  return values.map((valueBpm, index) => dailyRhrRecord(civilDateDaysBefore(latestDaysBefore + index), valueBpm, options));
}

const completeProfile = {
  birthDate: '1981-02-03',
  referenceSex: 'male' as const,
  profileRevision: 4,
  observedHrPeakBpm: 180,
};

function estimate(
  overrides: Partial<Parameters<typeof calculateBodyAge>[0]> = {},
) {
  return calculateBodyAge({
    profile: completeProfile,
    dailyVo2: [],
    dailyRhr: [],
    asOfCivilDate: AS_OF,
    ...overrides,
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Canonical JSON does not permit undefined values.');
  }
  return serialized;
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseObjectKeys);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).reverse().map((key) => [key, reverseObjectKeys(record[key])]));
  }
  return value;
}

test('pins the Wang 2022 Chinese community cycle-CPET P50 reference and its canonical payload hash', () => {
  const { canonicalPayloadSha256, ...canonicalPayload } = referenceTable;

  assert.equal(referenceTable.version, 'chinese-community-cycle-vo2peak-p50-v1');
  assert.equal(referenceTable.reference.authors, 'Wang et al.');
  assert.equal(referenceTable.reference.publicationYear, 2022);
  assert.equal(referenceTable.reference.pmcid, 'PMC9409785');
  assert.equal(referenceTable.reference.doi, '10.3390/jcm11164904');
  assert.equal(referenceTable.cohort.completedCycleCpetParticipants, 1114);
  assert.equal(referenceTable.cohort.sampleLimitations.requiredNormalEcgDuringExercise, true);
  assert.equal(referenceTable.cohort.sampleLimitations.communitySampleNotNationallyRepresentative, true);
  assert.equal(referenceTable.protocol.modality, 'cycle ergometer CPET');
  assert.equal(referenceTable.protocol.measure, 'VO2peak');
  assert.equal(referenceTable.protocol.units, 'mL·kg^-1·min^-1');
  assert.deepEqual(referenceTable.anchors, [
    { ageYears: 25, maleP50: 35.7, femaleP50: 27.7 },
    { ageYears: 35, maleP50: 27.7, femaleP50: 26.0 },
    { ageYears: 45, maleP50: 26.7, femaleP50: 24.7 },
    { ageYears: 55, maleP50: 24.4, femaleP50: 22.0 },
    { ageYears: 65, maleP50: 22.4, femaleP50: 21.2 },
    { ageYears: 75, maleP50: 19.7, femaleP50: 17.0 },
  ]);
  assert.match(referenceTable.accessedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Array.isArray(referenceTable.limitations));
  assert.ok(referenceTable.limitations.includes('non_medical_non_calibrated_estimate'));
  assert.equal(referenceTable.canonicalization, 'recursive-key-sorted-json-v1');
  assert.match(canonicalPayloadSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    canonicalPayloadSha256,
    createHash('sha256').update(canonicalJson(canonicalPayload)).digest('hex'),
  );
  const reorderedPayload = reverseObjectKeys(canonicalPayload);
  assert.notEqual(JSON.stringify(reorderedPayload), JSON.stringify(canonicalPayload));
  assert.equal(canonicalJson(reorderedPayload), canonicalJson(canonicalPayload));
  assert.equal(
    createHash('sha256').update(canonicalJson(reorderedPayload)).digest('hex'),
    canonicalPayloadSha256,
  );
});

test('does not score daily VO2 from an untrusted source family', () => {
  const result = estimate({
    dailyVo2: dailyVo2(7, 26.7, { sourceFamily: 'google-fit' }),
  });

  assert.equal(result.status, 'data_accumulating');
  assert.equal(result.route, null);
  assert.equal(result.age, null);
  assert.equal(result.coverageDays, 0);
});

test('chooses the newest received daily VO2 revision independently of input order', () => {
  const otherDays = [15, 20, 21, 22, 23, 24].map((vo2Max, index) =>
    dailyVo2Record(civilDateDaysBefore(index + 1), vo2Max),
  );
  const olderReceipt = dailyVo2Record(AS_OF, 26.7, {
    receivedAt: '2026-09-01T10:00:00.000Z',
    revision: 8,
  });
  const newerReceipt = dailyVo2Record(AS_OF, 10, {
    receivedAt: '2026-09-01T11:00:00.000Z',
    revision: 1,
  });

  const forward = estimate({ dailyVo2: [...otherDays, olderReceipt, newerReceipt] });
  const reversed = estimate({ dailyVo2: [...otherDays, newerReceipt, olderReceipt] });

  assert.deepEqual(forward, reversed);
  assert.equal(forward.age, 70);
});

test('breaks equal-receipt daily VO2 ties by the higher revision independently of input order', () => {
  const otherDays = [15, 20, 21, 22, 23, 24].map((vo2Max, index) =>
    dailyVo2Record(civilDateDaysBefore(index + 1), vo2Max),
  );
  const lowerRevision = dailyVo2Record(AS_OF, 26.7, {
    receivedAt: '2026-09-01T11:00:00.000Z',
    revision: 1,
  });
  const higherRevision = dailyVo2Record(AS_OF, 10, {
    receivedAt: '2026-09-01T11:00:00.000Z',
    revision: 2,
  });

  const forward = estimate({ dailyVo2: [...otherDays, lowerRevision, higherRevision] });
  const reversed = estimate({ dailyVo2: [...otherDays, higherRevision, lowerRevision] });

  assert.deepEqual(forward, reversed);
  assert.equal(forward.age, 70);
});

test('ignores lower-priority conflicting daily VO2 revisions regardless of input order', () => {
  const otherDays = dailyVo2(6, 26.7, { latestDaysBefore: 1 });
  const lowerFirst = dailyVo2Record(AS_OF, 10, { receivedAt: '2026-09-01T10:00:00.000Z', revision: 1 });
  const lowerConflict = dailyVo2Record(AS_OF, 35, { receivedAt: '2026-09-01T10:00:00.000Z', revision: 1 });
  const winner = dailyVo2Record(AS_OF, 26.7, { receivedAt: '2026-09-01T11:00:00.000Z', revision: 1 });

  const lowerFirstResult = estimate({ dailyVo2: [...otherDays, lowerFirst, lowerConflict, winner] });
  const winnerFirstResult = estimate({ dailyVo2: [...otherDays, winner, lowerConflict, lowerFirst] });

  assert.deepEqual(lowerFirstResult, winnerFirstResult);
  assert.equal(lowerFirstResult.age, 45);
});

test('rejects highest-priority conflicting daily VO2 revisions in either input order', () => {
  const lower = dailyVo2Record(AS_OF, 10, { receivedAt: '2026-09-01T10:00:00.000Z', revision: 1 });
  const firstWinner = dailyVo2Record(AS_OF, 26.7, { receivedAt: '2026-09-01T11:00:00.000Z', revision: 1 });
  const conflictingWinner = dailyVo2Record(AS_OF, 24.4, { receivedAt: '2026-09-01T11:00:00.000Z', revision: 1 });

  for (const records of [
    [lower, firstWinner, conflictingWinner],
    [conflictingWinner, lower, firstWinner],
  ]) {
    assert.throws(
      () => estimate({ dailyVo2: records }),
      /Conflicting daily VO2 revisions for 2026-09-01/,
    );
  }
});

test('requires RFC3339 offset-bearing receivedAt values for daily VO2 and RHR', () => {
  const invalidVo2 = dailyVo2(7, 26.7, { receivedAt: '2026-09-01T12:00:00' });
  const invalidRhr = dailyRhr([60, 60, 60, 60, 60, 60, 60], { receivedAt: '2026-09-01T12:00:00' });
  const offsetVo2 = dailyVo2(7, 26.7, { receivedAt: '2026-09-01T20:00:00+08:00' });

  assert.equal(estimate({ dailyVo2: invalidVo2 }).status, 'data_accumulating');
  assert.equal(
    estimate({ profile: { ...completeProfile, observedHrPeakBpm: 100 }, dailyRhr: invalidRhr }).status,
    'data_accumulating',
  );
  assert.equal(estimate({ dailyVo2: offsetVo2 }).status, 'daily_vo2_provisional');
});

test('rejects RFC3339 receivedAt values with out-of-range clock fields', () => {
  for (const receivedAt of ['2026-09-01T24:00:00Z', '2026-09-01T12:60:00Z', '2026-09-01T12:00:60Z']) {
    assert.equal(estimate({ dailyVo2: dailyVo2(7, 26.7, { receivedAt }) }).status, 'data_accumulating');
  }

  assert.equal(
    estimate({
      profile: { ...completeProfile, observedHrPeakBpm: 100 },
      dailyRhr: dailyRhr([60, 60, 60, 60, 60, 60, 60], { receivedAt: '2026-09-01T24:00:00Z' }),
    }).status,
    'data_accumulating',
  );
});

test('updates the observed peak monotonically from only eligible minute samples', () => {
  assert.equal(
    updateObservedHrPeakBpm(undefined, [
      { sourceFamily: 'google-wearables', sampleCount: 0, coverageSeconds: 60, maxBpm: 230 },
      { sourceFamily: 'google-wearables', sampleCount: 1, coverageSeconds: 29.9, maxBpm: 230 },
      { sourceFamily: 'google-wearables', sampleCount: 1, coverageSeconds: 30, maxBpm: 99 },
      { sourceFamily: 'google-wearables', sampleCount: 1, coverageSeconds: 30, maxBpm: 231 },
    ]),
    undefined,
  );
  assert.equal(
    updateObservedHrPeakBpm(undefined, [{ sourceFamily: 'google-wearables', sampleCount: 1, coverageSeconds: 30, maxBpm: 100 }]),
    100,
  );
  assert.equal(
    updateObservedHrPeakBpm(175, [
      { sourceFamily: 'google-wearables', sampleCount: 1, coverageSeconds: 30, maxBpm: 170 },
      { sourceFamily: 'google-wearables', sampleCount: 1, coverageSeconds: 30, maxBpm: 230 },
      { sourceFamily: 'google-wearables', sampleCount: 1, coverageSeconds: 60, maxBpm: 231 },
    ]),
    230,
  );
});

test('does not update an observed peak from a non-google-wearables minute', () => {
  assert.equal(
    updateObservedHrPeakBpm(undefined, [
      { sourceFamily: 'google-fit', sampleCount: 1, coverageSeconds: 60, maxBpm: 230 },
    ]),
    undefined,
  );
});

test('maps every Wang P50 anchor through the selected male or female reference table', () => {
  for (const anchor of referenceTable.anchors) {
    const male = estimate({ dailyVo2: dailyVo2(7, anchor.maleP50) });
    const female = estimate({
      profile: { ...completeProfile, referenceSex: 'female' },
      dailyVo2: dailyVo2(7, anchor.femaleP50),
    });

    assert.equal(male.age, anchor.ageYears);
    assert.equal(female.age, anchor.ageYears);
  }
});

test('inverts linearly between reference anchors and rounds to a whole age', () => {
  const result = estimate({ dailyVo2: dailyVo2(7, 27.2) });

  assert.equal(result.age, 40);
  assert.equal(result.status, 'daily_vo2_provisional');
});

test('uses explicit lower and upper reference boundaries outside the table', () => {
  assert.equal(estimate({ dailyVo2: dailyVo2(7, 35.8) }).age, 'below_reference_min');
  assert.equal(estimate({ dailyVo2: dailyVo2(7, 19.6) }).age, 'above_reference_max');
});

test('reports daily-VO2 accumulation at six distinct days', () => {
  const result = estimate({ dailyVo2: dailyVo2(6, 26.7) });

  assert.deepEqual(result, {
    age: null,
    coverageDays: 6,
    latestInputCivilDate: AS_OF,
    route: null,
    status: 'data_accumulating',
    referenceVersion: BODY_AGE_REFERENCE_VERSION,
    disclaimer: 'non_medical_non_calibrated_estimate',
    dataGaps: {
      dailyVo2DaysNeeded: 1,
      rhrDaysNeeded: 7,
      observedHrPeakRequired: false,
    },
  });
});

test('returns a provisional daily-VO2 result at seven days', () => {
  const result = estimate({ dailyVo2: dailyVo2(7, 26.7) });

  assert.equal(result.status, 'daily_vo2_provisional');
  assert.equal(result.route, 'daily_vo2');
  assert.equal(result.coverageDays, 7);
  assert.equal(result.latestInputCivilDate, AS_OF);
  assert.equal(result.age, 45);
  assert.deepEqual(result.dataGaps, {
    dailyVo2DaysNeeded: 0,
    rhrDaysNeeded: 0,
    observedHrPeakRequired: false,
  });
});

test('returns a stable daily-VO2 result at twenty-one days', () => {
  const result = estimate({ dailyVo2: dailyVo2(21, 26.7) });

  assert.equal(result.status, 'daily_vo2_stable');
  assert.equal(result.route, 'daily_vo2');
  assert.equal(result.coverageDays, 21);
});

test('accepts estimated daily VO2 values as usable input', () => {
  const result = estimate({ dailyVo2: dailyVo2(7, 26.7, { estimated: true }) });

  assert.equal(result.status, 'daily_vo2_provisional');
  assert.equal(result.age, 45);
});

test('uses daily VO2 in preference to the observed-peak ratio and never mixes their values', () => {
  const result = estimate({
    dailyVo2: dailyVo2(7, 26.7),
    dailyRhr: dailyRhr([60, 60, 60, 60, 60, 60, 60]),
    profile: { ...completeProfile, observedHrPeakBpm: 200 },
  });

  assert.equal(result.route, 'daily_vo2');
  assert.equal(result.status, 'daily_vo2_provisional');
  assert.equal(result.age, 45);
});

test('uses the median of the latest seven valid RHR dates with the observed peak proxy only', () => {
  const result = estimate({
    dailyRhr: [
      ...dailyRhr([62, 50, 58, 54, 60, 52, 56]),
      dailyRhrRecord(civilDateDaysBefore(7), 30),
      dailyRhrRecord(civilDateDaysBefore(8), 80),
    ],
    profile: { ...completeProfile, observedHrPeakBpm: 100 },
  });

  assert.equal(result.route, 'observed_peak_ratio');
  assert.equal(result.status, 'observed_peak_ratio_provisional');
  assert.equal(result.coverageDays, 7);
  assert.equal(result.latestInputCivilDate, AS_OF);
  assert.equal(result.age, 39);
});

test('chooses the newest received RHR revision independently of input order', () => {
  const otherDays = [40, 50, 60, 70, 80, 90].map((valueBpm, index) =>
    dailyRhrRecord(civilDateDaysBefore(index + 1), valueBpm),
  );
  const olderReceipt = dailyRhrRecord(AS_OF, 100, {
    receivedAt: '2026-09-01T10:00:00.000Z',
    revision: 8,
  });
  const newerReceipt = dailyRhrRecord(AS_OF, 30, {
    receivedAt: '2026-09-01T11:00:00.000Z',
    revision: 1,
  });
  const profile = { ...completeProfile, observedHrPeakBpm: 100 };

  const forward = estimate({ profile, dailyRhr: [...otherDays, olderReceipt, newerReceipt] });
  const reversed = estimate({ profile, dailyRhr: [...otherDays, newerReceipt, olderReceipt] });

  assert.deepEqual(forward, reversed);
  assert.equal(forward.age, 50);
});

test('ignores lower-priority conflicting RHR revisions regardless of input order', () => {
  const otherDays = dailyRhr([60, 60, 60, 60, 60, 60], { latestDaysBefore: 1 });
  const lowerFirst = dailyRhrRecord(AS_OF, 30, { receivedAt: '2026-09-01T10:00:00.000Z', revision: 1 });
  const lowerConflict = dailyRhrRecord(AS_OF, 100, { receivedAt: '2026-09-01T10:00:00.000Z', revision: 1 });
  const winner = dailyRhrRecord(AS_OF, 60, { receivedAt: '2026-09-01T11:00:00.000Z', revision: 1 });
  const profile = { ...completeProfile, observedHrPeakBpm: 100 };

  const lowerFirstResult = estimate({ profile, dailyRhr: [...otherDays, lowerFirst, lowerConflict, winner] });
  const winnerFirstResult = estimate({ profile, dailyRhr: [...otherDays, winner, lowerConflict, lowerFirst] });

  assert.deepEqual(lowerFirstResult, winnerFirstResult);
  assert.equal(lowerFirstResult.age, 50);
});

test('rejects highest-priority conflicting RHR revisions in either input order', () => {
  const lower = dailyRhrRecord(AS_OF, 30, { receivedAt: '2026-09-01T10:00:00.000Z', revision: 1 });
  const firstWinner = dailyRhrRecord(AS_OF, 60, { receivedAt: '2026-09-01T11:00:00.000Z', revision: 1 });
  const conflictingWinner = dailyRhrRecord(AS_OF, 70, { receivedAt: '2026-09-01T11:00:00.000Z', revision: 1 });
  const profile = { ...completeProfile, observedHrPeakBpm: 100 };

  for (const records of [
    [lower, firstWinner, conflictingWinner],
    [conflictingWinner, lower, firstWinner],
  ]) {
    assert.throws(
      () => estimate({ profile, dailyRhr: records }),
      /Conflicting daily RHR revisions for 2026-09-01/,
    );
  }
});

test('rejects conflicting RHR values with the same civil date, receipt time, and revision', () => {
  const first = dailyRhrRecord(AS_OF, 60, { receivedAt: '2026-09-01T11:00:00.000Z', revision: 2 });
  const conflict = dailyRhrRecord(AS_OF, 70, { receivedAt: '2026-09-01T11:00:00.000Z', revision: 2 });

  assert.throws(
    () => estimate({ profile: { ...completeProfile, observedHrPeakBpm: 100 }, dailyRhr: [first, conflict] }),
    /Conflicting daily RHR revisions for 2026-09-01/,
  );
});

test('does not allow non-google-wearables RHR to trigger or change the observed-peak proxy', () => {
  const untrustedRhr = dailyRhr([30, 30, 30, 30, 30, 30, 30], { sourceFamily: 'google-fit' });
  const trustedRhr = dailyRhr([60, 60, 60, 60, 60, 60, 60]);
  const profile = { ...completeProfile, observedHrPeakBpm: 100 };

  const untrustedOnly = estimate({ profile, dailyRhr: untrustedRhr });
  const trustedOnly = estimate({ profile, dailyRhr: trustedRhr });
  const mixed = estimate({ profile, dailyRhr: [...trustedRhr, ...untrustedRhr] });

  assert.equal(untrustedOnly.status, 'data_accumulating');
  assert.equal(untrustedOnly.route, null);
  assert.deepEqual(mixed, trustedOnly);
  assert.equal(mixed.route, 'observed_peak_ratio');
});

test('returns profile_missing before inspecting input coverage when a required profile field is absent', () => {
  const result = estimate({
    profile: { birthDate: '1981-02-03', profileRevision: 4, observedHrPeakBpm: 180 },
    dailyVo2: dailyVo2(21, 26.7),
  });

  assert.equal(result.status, 'profile_missing');
  assert.equal(result.route, null);
  assert.equal(result.age, null);
  assert.equal(result.coverageDays, 0);
  assert.equal(result.latestInputCivilDate, null);
});

test('ignores invalid, future, duplicate-day, and out-of-window measurements', () => {
  const result = estimate({
    profile: { ...completeProfile, observedHrPeakBpm: 99 },
    dailyVo2: [
      dailyVo2Record(AS_OF, 0),
      dailyVo2Record(AS_OF, Number.NaN),
      dailyVo2Record('invalid-date', 26.7),
      dailyVo2Record('2026-09-02', 26.7),
      dailyVo2Record(civilDateDaysBefore(28), 26.7),
      dailyVo2Record(civilDateDaysBefore(1), 26.7),
      dailyVo2Record(civilDateDaysBefore(1), 30, { revision: 2 }),
    ],
    dailyRhr: [
      dailyRhrRecord(AS_OF, 29),
      dailyRhrRecord(civilDateDaysBefore(1), 121),
      dailyRhrRecord('invalid-date', 55),
      dailyRhrRecord('2026-09-02', 55),
      dailyRhrRecord(civilDateDaysBefore(28), 55),
      dailyRhrRecord(civilDateDaysBefore(2), Number.NaN),
    ],
  });

  assert.equal(result.status, 'data_accumulating');
  assert.equal(result.age, null);
  assert.equal(result.coverageDays, 1);
  assert.deepEqual(result.dataGaps, {
    dailyVo2DaysNeeded: 6,
    rhrDaysNeeded: 7,
    observedHrPeakRequired: true,
  });
});

test('marks an otherwise sufficient daily-VO2 route stale after seven days without falling back', () => {
  const result = estimate({
    dailyVo2: dailyVo2(7, 26.7, { latestDaysBefore: 8 }),
    dailyRhr: dailyRhr([60, 60, 60, 60, 60, 60, 60]),
  });

  assert.equal(result.status, 'stale');
  assert.equal(result.route, 'daily_vo2');
  assert.equal(result.coverageDays, 7);
  assert.equal(result.latestInputCivilDate, civilDateDaysBefore(8));
  assert.equal(result.age, null);
});

test('marks an otherwise sufficient observed-peak ratio route stale after seven days', () => {
  const result = estimate({
    dailyRhr: dailyRhr([60, 60, 60, 60, 60, 60, 60], { latestDaysBefore: 8 }),
    profile: { ...completeProfile, observedHrPeakBpm: 180 },
  });

  assert.equal(result.status, 'stale');
  assert.equal(result.route, 'observed_peak_ratio');
  assert.equal(result.coverageDays, 7);
  assert.equal(result.latestInputCivilDate, civilDateDaysBefore(8));
  assert.equal(result.age, null);
});

test('returns only the documented de-identified DTO fields', () => {
  const result = estimate({ dailyVo2: dailyVo2(7, 26.7) });

  assert.deepEqual(Object.keys(result).sort(), [
    'age',
    'coverageDays',
    'dataGaps',
    'disclaimer',
    'latestInputCivilDate',
    'referenceVersion',
    'route',
    'status',
  ]);
  assert.equal(JSON.stringify(result).includes('birthDate'), false);
  assert.equal(JSON.stringify(result).includes('vo2Max'), false);
  assert.equal(JSON.stringify(result).includes('valueBpm'), false);
  assert.equal(JSON.stringify(result).includes('observedHrPeakBpm'), false);
});
