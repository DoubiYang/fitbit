export const DEFAULT_CIVIL_TIME_ZONE = 'Asia/Shanghai';

export function civilDate(now: Date, timeZone = DEFAULT_CIVIL_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function utcCivilDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function resolveDashboardCivilDate(
  now: Date,
  timeZone: string | undefined,
  fallback: 'default' | 'utc' = 'utc',
): string {
  if (timeZone) {
    return civilDate(now, timeZone);
  }
  return fallback === 'default' ? civilDate(now) : utcCivilDate(now);
}

export function civilDateDaysAgo(to: string, days: number): string {
  const date = new Date(`${to}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export function civilDateRange(
  now: Date,
  rangeDays: number,
  timeZone = DEFAULT_CIVIL_TIME_ZONE,
): { from: string; to: string } {
  const to = civilDate(now, timeZone);
  return { from: civilDateDaysAgo(to, rangeDays - 1), to };
}
