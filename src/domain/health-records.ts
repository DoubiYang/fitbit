import { z } from 'zod';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const userIdSchema = z.string().trim().min(1).max(128);
const sourceRecordIdSchema = z.string().trim().min(1).max(256);
const sourceSchema = z.enum(['google_health', 'manual']);

const sourceRecordSchema = z.object({
  userId: userIdSchema,
  source: sourceSchema,
  sourceRecordId: sourceRecordIdSchema,
});

const civilDateSchema = z.string().regex(datePattern, 'Expected a YYYY-MM-DD date.');
const instantSchema = z.string().datetime({ offset: true });

const sleepSessionSchema = sourceRecordSchema
  .extend({
    id: z.string().trim().min(1).max(128),
    startTime: instantSchema,
    endTime: instantSchema,
    civilEndDate: civilDateSchema,
    utcOffsetMinutes: z.number().int().min(-840).max(840),
    minutesAsleep: z.number().int().min(0).max(1_440),
    timeInBedMinutes: z.number().int().min(0).max(1_440).optional(),
    awakeMinutes: z.number().int().min(0).max(1_440).optional(),
    awakeSegments: z.number().int().min(0).max(120).optional(),
    isNap: z.boolean(),
    processed: z.boolean(),
  })
  .superRefine((value, context) => {
    if (Date.parse(value.endTime) <= Date.parse(value.startTime)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Sleep endTime must be later than startTime.',
        path: ['endTime'],
      });
    }

    if (value.timeInBedMinutes !== undefined && value.timeInBedMinutes < value.minutesAsleep) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'timeInBedMinutes cannot be lower than minutesAsleep.',
        path: ['timeInBedMinutes'],
      });
    }
  });

const dailyHrvSchema = sourceRecordSchema.extend({
  date: civilDateSchema,
  valueMs: z.number().finite().min(5).max(250),
});

const dailyRhrSchema = sourceRecordSchema.extend({
  date: civilDateSchema,
  valueBpm: z.number().finite().min(25).max(130),
});

const trainingDaySchema = z
  .object({
    userId: userIdSchema,
    date: civilDateSchema,
    completeness: z.enum(['complete', 'unknown']),
    load: z.number().finite().min(0).max(100_000).nullable(),
  })
  .superRefine((value, context) => {
    if (value.completeness === 'unknown' && value.load !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Unknown training days must not contain a load value.',
        path: ['load'],
      });
    }

    if (value.completeness === 'complete' && value.load === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Complete training days must contain a confirmed load, including zero.',
        path: ['load'],
      });
    }
  });

export type HealthSource = z.infer<typeof sourceSchema>;
export type SleepSession = z.infer<typeof sleepSessionSchema>;
export type DailyHrv = z.infer<typeof dailyHrvSchema>;
export type DailyRhr = z.infer<typeof dailyRhrSchema>;
export type TrainingDay = z.infer<typeof trainingDaySchema>;

export function parseSleepSession(input: unknown): SleepSession {
  return sleepSessionSchema.parse(input);
}

export function parseDailyHrv(input: unknown): DailyHrv {
  return dailyHrvSchema.parse(input);
}

export function parseDailyRhr(input: unknown): DailyRhr {
  return dailyRhrSchema.parse(input);
}

export function parseTrainingDay(input: unknown): TrainingDay {
  return trainingDaySchema.parse(input);
}

export function isPrimarySleepCandidate(session: SleepSession): boolean {
  return !session.isNap && session.minutesAsleep >= 180;
}
