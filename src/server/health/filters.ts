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
    case 'exercise':
      return `exercise.interval.civil_start_time >= "${from}" AND exercise.interval.civil_start_time < "${untilExclusive}"`;
    default:
      throw new Error(`unsupported data type ${dataType}`);
  }
}
