export function protoDurationSeconds(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^(-?\d+(?:\.\d+)?)s$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  return Number(match[1]);
}

export function protoDurationMinutes(value: string | undefined): number | undefined {
  const seconds = protoDurationSeconds(value);
  return seconds === undefined ? undefined : seconds / 60;
}

export function protoOffsetMinutes(value: string | undefined): number {
  return Math.round(protoDurationMinutes(value) ?? 0);
}

export function civilDateFrom(date: { year?: number; month?: number; day?: number } | undefined): string | undefined {
  if (!date?.year || !date.month || !date.day) {
    return undefined;
  }
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

export function parseNumeric(value: string | number | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
