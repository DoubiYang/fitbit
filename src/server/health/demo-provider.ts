import { parseDailyHrv, parseDailyRhr, parseSleepSession, parseTrainingDay } from '../../domain/health-records';
import { emptyUserHealthRecords, type HealthDateRange, type HealthProvider, type UserHealthRecords } from './provider';

const DEMO_USER_ID = 'demo_user';
const DEMO_TARGET_DATE = '2026-08-22';

function dateBefore(targetDate: string, days: number): string {
  const target = new Date(`${targetDate}T00:00:00.000Z`);
  target.setUTCDate(target.getUTCDate() - days);
  return target.toISOString().slice(0, 10);
}

function createDemoRecords(): UserHealthRecords {
  return Array.from({ length: 28 }, (_, index) => {
    const date = dateBefore(DEMO_TARGET_DATE, index);
    const minutesAsleep = 405 + ((index * 13) % 60);
    const timeInBedMinutes = minutesAsleep + 28 + (index % 3) * 6;

    return {
      sleep: parseSleepSession({
        userId: DEMO_USER_ID,
        source: 'google_health',
        sourceRecordId: `demo-sleep-${date}`,
        id: `demo-sleep-${date}`,
        startTime: `${date}T15:15:00.000Z`,
        endTime: `${date}T23:00:00.000Z`,
        civilEndDate: date,
        utcOffsetMinutes: 480,
        minutesAsleep,
        timeInBedMinutes,
        awakeMinutes: timeInBedMinutes - minutesAsleep,
        awakeSegments: 1 + (index % 3),
        isNap: false,
        processed: true,
      }),
      hrv: parseDailyHrv({
        userId: DEMO_USER_ID,
        source: 'google_health',
        sourceRecordId: `demo-hrv-${date}`,
        date,
        valueMs: 48 + ((index * 7) % 10),
      }),
      rhr: parseDailyRhr({
        userId: DEMO_USER_ID,
        source: 'google_health',
        sourceRecordId: `demo-rhr-${date}`,
        date,
        valueBpm: 54 + (index % 4),
      }),
      trainingDay: parseTrainingDay({
        userId: DEMO_USER_ID,
        date,
        completeness: 'complete',
        load: index % 3 === 0 ? 56 : index % 3 === 1 ? 24 : 0,
      }),
    };
  }).reduce<UserHealthRecords>(
    (records, day) => {
      records.sleepSessions.push(day.sleep);
      records.dailyHrv.push(day.hrv);
      records.dailyRhr.push(day.rhr);
      records.trainingDays.push(day.trainingDay);
      return records;
    },
    emptyUserHealthRecords(),
  );
}

function inRange(date: string, range: HealthDateRange): boolean {
  return date >= range.from && date <= range.to;
}

function copyRecords(records: UserHealthRecords): UserHealthRecords {
  return {
    sleepSessions: records.sleepSessions.map((record) => ({ ...record })),
    dailyHrv: records.dailyHrv.map((record) => ({ ...record })),
    dailyRhr: records.dailyRhr.map((record) => ({ ...record })),
    trainingDays: records.trainingDays.map((record) => ({ ...record })),
  };
}

export class DemoHealthProvider implements HealthProvider {
  readonly capabilities = { mode: 'demo' as const, canSync: false };

  private readonly records = createDemoRecords();

  async listRecords(userId: string, range: HealthDateRange): Promise<UserHealthRecords> {
    if (userId !== DEMO_USER_ID) {
      return emptyUserHealthRecords();
    }

    return copyRecords({
      sleepSessions: this.records.sleepSessions.filter((record) => inRange(record.civilEndDate, range)),
      dailyHrv: this.records.dailyHrv.filter((record) => inRange(record.date, range)),
      dailyRhr: this.records.dailyRhr.filter((record) => inRange(record.date, range)),
      trainingDays: this.records.trainingDays.filter((record) => inRange(record.date, range)),
    });
  }
}
