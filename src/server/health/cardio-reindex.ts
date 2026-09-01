import type { AuthStore } from '../auth/types';
import { recomputeAffectedDays, timeZoneOffsetMinutes, type LoadHealthRecords, type LoadHealthSnapshot } from './cardio-sync';

const SOURCE_FAMILY = 'google-wearables' as const;

export function localAssociationFromOffset(
  minuteStartUtc: string,
  utcOffsetMinutes: number,
): { civilDate: string; localMinuteOfDay: number } {
  const local = new Date(Date.parse(minuteStartUtc) + utcOffsetMinutes * 60_000);
  return {
    civilDate: local.toISOString().slice(0, 10),
    localMinuteOfDay: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

export async function reindexStoredMinutesForTimeZone(
  store: AuthStore,
  input: {
    userId: string;
    ianaTimeZone: string;
    fromUtc: string;
    toUtcExclusive?: string;
    now: Date;
    loadRecords?: LoadHealthRecords;
    loadSnapshot?: LoadHealthSnapshot;
    lastSuccessfulSyncAt?: Date | string;
  },
): Promise<{ updatedMinutes: number; affectedDates: string[] }> {
  const minutes = await store.healthMetrics.listMinutesInRange({
    userId: input.userId,
    fromUtc: input.fromUtc,
    toUtcExclusive: input.toUtcExclusive,
  });
  const affected = new Set<string>();
  let updatedMinutes = 0;

  for (const minute of minutes) {
    affected.add(minute.civilDate);
    const expected = timeZoneOffsetMinutes(input.ianaTimeZone, new Date(minute.minuteStartUtc));
    if (expected === undefined || expected !== minute.utcOffsetMinutes) {
      continue;
    }
    const local = localAssociationFromOffset(minute.minuteStartUtc, minute.utcOffsetMinutes);
    await store.healthMetrics.updateMinuteLocalAssociation({
      userId: minute.userId,
      sourceFamily: SOURCE_FAMILY,
      minuteStartUtc: minute.minuteStartUtc,
      civilDate: local.civilDate,
      ianaTimeZone: input.ianaTimeZone,
      localMinuteOfDay: local.localMinuteOfDay,
    });
    affected.add(local.civilDate);
    updatedMinutes += 1;
  }

  if (affected.size > 0) {
    await recomputeAffectedDays(store, {
      userId: input.userId,
      dates: affected,
      now: input.now,
      loadRecords: input.loadRecords,
      loadSnapshot: input.loadSnapshot,
      lastSuccessfulSyncAt: input.lastSuccessfulSyncAt,
    });
  }

  return { updatedMinutes, affectedDates: [...affected].sort() };
}
