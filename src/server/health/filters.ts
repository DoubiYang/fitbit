export const HEALTH_HIGH_VOLUME_PAGE_SIZE = 10_000;

export const HEART_RATE_ACTIVITY_LEVEL_PAGE_SIZE = HEALTH_HIGH_VOLUME_PAGE_SIZE;

export function exclusiveEnd(date: string): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export function dataPointFilter(dataType: string, from: string, untilExclusive: string): string {
  switch (dataType) {
    case 'sleep':
      return `sleep.interval.civil_end_time >= "${from}" AND sleep.interval.civil_end_time < "${untilExclusive}"`;
    case 'daily-heart-rate-variability':
      return `daily_heart_rate_variability.date >= "${from}" AND daily_heart_rate_variability.date < "${untilExclusive}"`;
    case 'daily-resting-heart-rate':
      return `daily_resting_heart_rate.date >= "${from}" AND daily_resting_heart_rate.date < "${untilExclusive}"`;
    case 'daily-vo2-max':
      return `daily_vo2_max.date >= "${from}" AND daily_vo2_max.date < "${untilExclusive}"`;
    case 'exercise':
      return `exercise.interval.civil_start_time >= "${from}" AND exercise.interval.civil_start_time < "${untilExclusive}"`;
    case 'heart-rate':
      return `heart_rate.sample_time.physical_time >= "${from}" AND heart_rate.sample_time.physical_time < "${untilExclusive}"`;
    case 'activity-level':
      return `activity_level.interval.start_time >= "${from}" AND activity_level.interval.start_time < "${untilExclusive}"`;
    case 'daily-heart-rate-zones':
      return `daily_heart_rate_zones.date >= "${from}" AND daily_heart_rate_zones.date < "${untilExclusive}"`;
    case 'time-in-heart-rate-zone':
      return `time_in_heart_rate_zone.interval.start_time >= "${from}" AND time_in_heart_rate_zone.interval.start_time < "${untilExclusive}"`;
    default:
      throw new Error(`unsupported data type ${dataType}`);
  }
}
