import { z } from 'zod';

import {
  WHOOP_STYLE_METRIC_VERSION,
  type HeartRateZoneId,
  type MetricCoverageState,
  type MetricEvidence,
  type MetricName,
  type MetricSourceState,
  type RecoveryQuality,
  type StrainStatus,
  type ZoneMinutes,
} from './metric-types';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const userIdSchema = z.string().trim().min(1).max(128);
const sourceFamilySchema = z.literal('google-wearables');
const civilDateSchema = z.string().regex(datePattern, 'Expected a YYYY-MM-DD date.');
const instantSchema = z.string().datetime({ offset: true });
const sourceRecordIdSchema = z.string().trim().min(1).max(256);

const activityLevelTypeSchema = z.enum(['SEDENTARY', 'LIGHTLY_ACTIVE', 'MODERATELY_ACTIVE', 'VERY_ACTIVE']);
const minuteActivityLevelSchema = z.enum(['SEDENTARY', 'LIGHTLY_ACTIVE', 'MODERATELY_ACTIVE', 'VERY_ACTIVE', 'unknown']);
const strainStatusSchema = z.enum(['complete', 'provisional', 'incomplete', 'timezone_ambiguous', 'unavailable']);
const recoveryQualitySchema = z.enum(['unavailable', 'provisional', 'medium', 'high']);
const timeZoneStateSchema = z.enum(['unambiguous', 'ambiguous', 'missing']);

const zoneBoundsSchema = z
  .object({
    minBeatsPerMinute: z.number().int().min(1).max(250),
    maxBeatsPerMinute: z.number().int().min(1).max(250),
  })
  .superRefine((value, context) => {
    if (value.maxBeatsPerMinute < value.minBeatsPerMinute) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Zone maxBeatsPerMinute must be greater than or equal to minBeatsPerMinute.',
        path: ['maxBeatsPerMinute'],
      });
    }
  });

const googleHeartRateZonesSchema = z.object({
  LIGHT: zoneBoundsSchema,
  MODERATE: zoneBoundsSchema,
  VIGOROUS: zoneBoundsSchema,
  PEAK: zoneBoundsSchema,
});

const zoneMinutesSchema = z.object({
  light: z.number().finite().min(0).max(1_500),
  moderate: z.number().finite().min(0).max(1_500),
  vigorous: z.number().finite().min(0).max(1_500),
  peak: z.number().finite().min(0).max(1_500),
});

const evidenceSchema = z.object({
  label: z.string().trim().min(1).max(128),
  date: civilDateSchema,
  value: z.union([z.number().finite(), z.string().min(1).max(256)]),
});

const sourceStateSchema = z.object({
  heartRateZones: z.boolean(),
  activityLevel: z.boolean(),
  exercise: z.boolean(),
  sleep: z.boolean(),
  hrv: z.boolean(),
  rhr: z.boolean(),
  sleepGoal: z.boolean(),
  timeZone: timeZoneStateSchema,
});

const coverageStateSchema = z.object({
  knownContextMinutes: z.number().finite().min(0).max(1_500),
  rawHeartRateMinutes: z.number().finite().min(0).max(1_500),
  attributedMinutes: z.number().finite().min(0).max(1_500),
  lastKnownContextAt: instantSchema.nullable(),
});

const dailyHeartRateZonesSchema = z
  .object({
    userId: userIdSchema,
    sourceFamily: sourceFamilySchema,
    date: civilDateSchema,
    zones: googleHeartRateZonesSchema,
  })
  .superRefine((value, context) => {
    const order = ['LIGHT', 'MODERATE', 'VIGOROUS', 'PEAK'] as const;
    for (let index = 0; index < order.length - 1; index += 1) {
      const current = value.zones[order[index]];
      const next = value.zones[order[index + 1]];
      if (next.minBeatsPerMinute !== current.maxBeatsPerMinute + 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Adjacent heart-rate zones must be ordered, inclusive, and separated by exactly 1 bpm.',
          path: ['zones', order[index + 1], 'minBeatsPerMinute'],
        });
      }
    }
  });

const heartRateMinuteAggregateSchema = z
  .object({
    userId: userIdSchema,
    sourceFamily: sourceFamilySchema,
    minuteStartUtc: instantSchema,
    civilDate: civilDateSchema,
    utcOffsetMinutes: z.number().int().min(-840).max(840),
    ianaTimeZone: z.string().trim().min(1).max(128).nullable(),
    localMinuteOfDay: z.number().int().min(0).max(1_500),
    avgBpm: z.number().finite().min(1).max(250),
    minBpm: z.number().finite().min(1).max(250),
    maxBpm: z.number().finite().min(1).max(250),
    sampleCount: z.number().int().min(0).max(10_000),
    coverageSeconds: z.number().finite().min(0).max(60),
    activityLevel: minuteActivityLevelSchema,
  })
  .superRefine((value, context) => {
    if (value.maxBpm < value.minBpm) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'maxBpm cannot be lower than minBpm.',
        path: ['maxBpm'],
      });
    }
  });

const dailyTimeInZoneSchema = z.object({
  userId: userIdSchema,
  sourceFamily: sourceFamilySchema,
  date: civilDateSchema,
  minutes: zoneMinutesSchema,
});

const exerciseIntervalSchema = z
  .object({
    userId: userIdSchema,
    sourceFamily: sourceFamilySchema,
    sourceRecordId: sourceRecordIdSchema,
    startTime: instantSchema,
    endTime: instantSchema,
    utcOffsetMinutes: z.number().int().min(-840).max(840),
    civilDate: civilDateSchema,
  })
  .superRefine((value, context) => {
    if (Date.parse(value.endTime) <= Date.parse(value.startTime)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Exercise endTime must be later than startTime.',
        path: ['endTime'],
      });
    }
  });

const activityLevelIntervalSchema = z
  .object({
    userId: userIdSchema,
    sourceFamily: sourceFamilySchema,
    startTime: instantSchema,
    endTime: instantSchema,
    activityLevelType: activityLevelTypeSchema,
  })
  .superRefine((value, context) => {
    if (Date.parse(value.endTime) <= Date.parse(value.startTime)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Activity-level endTime must be later than startTime.',
        path: ['endTime'],
      });
    }
  });

const dailyCardioSchema = z
  .object({
    userId: userIdSchema,
    date: civilDateSchema,
    status: strainStatusSchema,
    strain: z.number().finite().min(0).max(21).nullable(),
    dose: z.number().finite().min(0).nullable(),
    zoneMinutes: zoneMinutesSchema,
    knownContextMinutes: z.number().int().min(0).max(1_500),
    rawCoverageMinutes: z.number().int().min(0).max(1_500),
    attributedMinutes: z.number().int().min(0).max(1_500),
    metricVersion: z.literal(WHOOP_STYLE_METRIC_VERSION),
  })
  .superRefine((value, context) => {
    if (value.status === 'complete' && value.strain === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Complete cardio days must contain a strain value, including zero.',
        path: ['strain'],
      });
    }

    if (value.status === 'unavailable' && value.strain !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Unavailable cardio days must not contain a strain value.',
        path: ['strain'],
      });
    }

    if (value.status === 'provisional' && value.strain === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provisional cardio days must contain a labeled strain value.',
        path: ['strain'],
      });
    }
  });

const sleepGoalSchema = z.object({
  userId: userIdSchema,
  goalMinutes: z.number().int().min(300).max(900),
  effectiveCivilDate: civilDateSchema,
});

const metricResultSchema = z.object({
  userId: userIdSchema,
  civilDate: civilDateSchema,
  metricName: z.enum(['strain', 'sleep_performance', 'recovery']),
  metricVersion: z.literal(WHOOP_STYLE_METRIC_VERSION),
  score: z.number().finite().nullable(),
  status: strainStatusSchema.nullable(),
  quality: recoveryQualitySchema.nullable(),
  reason: z.string().trim().min(1).max(128).nullable(),
  evidence: z.array(evidenceSchema),
  source: sourceStateSchema,
  coverage: coverageStateSchema,
});

export type ActivityLevelType = z.infer<typeof activityLevelTypeSchema>;
export type MinuteActivityLevel = z.infer<typeof minuteActivityLevelSchema>;
export type HeartRateZoneBounds = z.infer<typeof zoneBoundsSchema>;
export type DailyHeartRateZones = z.infer<typeof dailyHeartRateZonesSchema>;
export type HeartRateMinuteAggregate = z.infer<typeof heartRateMinuteAggregateSchema>;
export type DailyTimeInZone = z.infer<typeof dailyTimeInZoneSchema>;
export type ExerciseInterval = z.infer<typeof exerciseIntervalSchema>;
export type ActivityLevelInterval = z.infer<typeof activityLevelIntervalSchema>;
export type DailyCardio = z.infer<typeof dailyCardioSchema>;
export type SleepGoal = z.infer<typeof sleepGoalSchema>;
export type MetricResult = z.infer<typeof metricResultSchema>;

export type HeartRateSample = {
  physicalTime: string;
  beatsPerMinute: number;
  utcOffsetMinutes: number;
};

export function parseDailyHeartRateZones(input: unknown): DailyHeartRateZones {
  return dailyHeartRateZonesSchema.parse(input);
}

export function parseHeartRateMinuteAggregate(input: unknown): HeartRateMinuteAggregate {
  return heartRateMinuteAggregateSchema.parse(input);
}

export function parseDailyTimeInZone(input: unknown): DailyTimeInZone {
  return dailyTimeInZoneSchema.parse(input);
}

export function parseExerciseInterval(input: unknown): ExerciseInterval {
  return exerciseIntervalSchema.parse(input);
}

export function parseActivityLevelInterval(input: unknown): ActivityLevelInterval {
  return activityLevelIntervalSchema.parse(input);
}

export function parseDailyCardio(input: unknown): DailyCardio {
  return dailyCardioSchema.parse(input);
}

export function parseSleepGoal(input: unknown): SleepGoal {
  return sleepGoalSchema.parse(input);
}

export function parseMetricResult(input: unknown): MetricResult {
  return metricResultSchema.parse(input);
}

export function sleepGoalEffectiveCivilDate(settingCivilDate: string): string {
  const next = new Date(`${settingCivilDate}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export function classifyHeartRateZone(bpm: number, zones: DailyHeartRateZones): HeartRateZoneId | null {
  const ordered: Array<[HeartRateZoneId, HeartRateZoneBounds]> = [
    ['light', zones.zones.LIGHT],
    ['moderate', zones.zones.MODERATE],
    ['vigorous', zones.zones.VIGOROUS],
    ['peak', zones.zones.PEAK],
  ];

  for (const [id, bounds] of ordered) {
    if (bpm >= bounds.minBeatsPerMinute && bpm <= bounds.maxBeatsPerMinute) {
      return id;
    }
  }

  return null;
}

export type { MetricCoverageState, MetricEvidence, MetricName, MetricSourceState, RecoveryQuality, StrainStatus, ZoneMinutes };
