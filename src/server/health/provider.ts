import type { DailyHrv, DailyRhr, SleepSession, TrainingDay } from '../../domain/health-records';

export type HealthDateRange = {
  from: string;
  to: string;
};

export type UserHealthRecords = {
  sleepSessions: SleepSession[];
  dailyHrv: DailyHrv[];
  dailyRhr: DailyRhr[];
  trainingDays: TrainingDay[];
};

export type HealthProviderCapabilities = {
  mode: 'demo' | 'unavailable';
  canSync: boolean;
};

export interface HealthProvider {
  readonly capabilities: HealthProviderCapabilities;
  listRecords(userId: string, range: HealthDateRange): Promise<UserHealthRecords>;
}

export function emptyUserHealthRecords(): UserHealthRecords {
  return { sleepSessions: [], dailyHrv: [], dailyRhr: [], trainingDays: [] };
}
