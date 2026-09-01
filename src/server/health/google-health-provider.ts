import type { OAuthConfig } from '../config/env';
import type { AuthStore, ConnectionRow } from '../auth/types';
import { emptyUserHealthRecords, type HealthDateRange, type HealthProvider, type UserHealthRecords } from './provider';
import { createHealthApiClient, type HealthApiClient } from './health-api';
import { createGoogleTokenRefresher, resolveAccessToken, type TokenRefresher } from './access-token';
import { dataPointFilter, exclusiveEnd } from './filters';
import { mapDailyHrv, mapDailyRhr, mapSleepSession, mapTrainingDays } from './map-records';
import { mergeHealthRecords, type HealthSnapshot } from './snapshot-store';

export class IntegrationUnavailableError extends Error {
  readonly code = 'integration_unavailable';

  constructor(message = 'Google Health integration is not configured for this environment.') {
    super(message);
    this.name = 'IntegrationUnavailableError';
  }
}

type LiveProviderInput = {
  config: OAuthConfig;
  store: AuthStore;
  connection: ConnectionRow;
  api?: HealthApiClient;
  refresher?: TokenRefresher;
  now?: Date;
  persistSnapshot?: (records: UserHealthRecords, syncedAt: Date) => Promise<void>;
  loadSnapshot?: (userId: string) => Promise<HealthSnapshot | undefined>;
};

export type SnapshotRecordDataType = 'sleep' | 'daily-heart-rate-variability' | 'daily-resting-heart-rate';
type SnapshotQueryDataType = SnapshotRecordDataType | 'exercise';

export type SnapshotRecordSyncResult = {
  records?: UserHealthRecords;
  succeededDataTypes: SnapshotRecordDataType[];
  failures: Array<{ dataType: SnapshotQueryDataType; error: unknown }>;
};

function isSyncable(connection: ConnectionRow | undefined): connection is ConnectionRow {
  return connection?.status === 'active' || connection?.status === 'partial';
}

function inclusiveDates(from: string, to: string): string[] {
  const dates: string[] = [];
  const current = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (current.getTime() <= end.getTime()) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function fortyEightHourRange(now: Date): HealthDateRange {
  return {
    from: new Date(now.getTime() - 48 * 60 * 60 * 1_000).toISOString().slice(0, 10),
    to: now.toISOString().slice(0, 10),
  };
}

export class GoogleHealthProvider implements HealthProvider {
  readonly capabilities = { mode: 'oauth' as const, canSync: true };

  constructor(private readonly input: LiveProviderInput) {}

  private async collectRecords(userId: string, range: HealthDateRange): Promise<{
    records: UserHealthRecords;
    hasSuccessfulQuery: boolean;
    succeededDataTypes: SnapshotRecordDataType[];
    failures: Array<{ dataType: SnapshotQueryDataType; error: unknown }>;
    syncedAt: Date;
  }> {
    if (userId !== this.input.connection.userId) {
      return {
        records: emptyUserHealthRecords(),
        hasSuccessfulQuery: false,
        succeededDataTypes: [],
        failures: [],
        syncedAt: this.input.now ?? new Date(),
      };
    }
    const accessToken = await resolveAccessToken({
      config: this.input.config,
      store: this.input.store,
      connection: this.input.connection,
      refresher: this.input.refresher ?? createGoogleTokenRefresher(this.input.config),
      now: this.input.now,
    });
    const api = this.input.api ?? createHealthApiClient();
    const syncedAt = this.input.now ?? new Date();
    const previous = this.input.loadSnapshot ? await this.input.loadSnapshot(userId) : undefined;
    const queryRange = previous ? fortyEightHourRange(syncedAt) : range;
    const until = exclusiveEnd(queryRange.to);
    const queries: Array<{ dataType: SnapshotQueryDataType; request: Promise<import('./map-records').GoogleDataPoint[]> }> = [
      {
        dataType: 'sleep',
        request: api.listDataPoints({
          accessToken,
          dataType: 'sleep',
          filter: dataPointFilter('sleep', queryRange.from, until),
          pageSize: 25,
        }),
      },
      {
        dataType: 'daily-heart-rate-variability',
        request: api.listDataPoints({
          accessToken,
          dataType: 'daily-heart-rate-variability',
          filter: dataPointFilter('daily-heart-rate-variability', queryRange.from, until),
        }),
      },
      {
        dataType: 'daily-resting-heart-rate',
        request: api.listDataPoints({
          accessToken,
          dataType: 'daily-resting-heart-rate',
          filter: dataPointFilter('daily-resting-heart-rate', queryRange.from, until),
        }),
      },
      {
        dataType: 'exercise',
        request: api.listDataPoints({
          accessToken,
          dataType: 'exercise',
          filter: dataPointFilter('exercise', queryRange.from, until),
          pageSize: 25,
        }),
      },
    ];
    const settled = await Promise.allSettled(queries.map((query) => query.request));
    const pointsByType = new Map<SnapshotQueryDataType, import('./map-records').GoogleDataPoint[]>();
    const failures: SnapshotRecordSyncResult['failures'] = [];
    for (const [index, result] of settled.entries()) {
      const query = queries[index]!;
      if (result.status === 'fulfilled') {
        pointsByType.set(query.dataType, result.value);
      } else {
        failures.push({ dataType: query.dataType, error: result.reason });
      }
    }
    const sleepPoints = pointsByType.get('sleep') ?? [];
    const hrvPoints = pointsByType.get('daily-heart-rate-variability') ?? [];
    const rhrPoints = pointsByType.get('daily-resting-heart-rate') ?? [];
    const exercisePoints = pointsByType.get('exercise') ?? [];

    const incoming: UserHealthRecords = {
      sleepSessions: sleepPoints.flatMap((point) => {
        const mapped = mapSleepSession(point, userId);
        return mapped ? [mapped] : [];
      }),
      dailyHrv: hrvPoints.flatMap((point) => {
        const mapped = mapDailyHrv(point, userId);
        return mapped ? [mapped] : [];
      }),
      dailyRhr: rhrPoints.flatMap((point) => {
        const mapped = mapDailyRhr(point, userId);
        return mapped ? [mapped] : [];
      }),
      trainingDays: pointsByType.has('exercise')
        ? mapTrainingDays(exercisePoints, userId, inclusiveDates(queryRange.from, queryRange.to))
        : [],
    };
    const records = mergeHealthRecords(previous?.records, incoming, { retainCivilDays: 35, now: syncedAt });
    const succeededDataTypes = (['sleep', 'daily-heart-rate-variability', 'daily-resting-heart-rate'] as const).filter((dataType) =>
      pointsByType.has(dataType),
    );
    return {
      records,
      hasSuccessfulQuery: pointsByType.size > 0,
      succeededDataTypes,
      failures,
      syncedAt,
    };
  }

  private async persistRecords(
    userId: string,
    records: UserHealthRecords,
    syncedAt: Date,
    markSnapshotSuccessful: boolean,
  ): Promise<void> {
    const beforePersist = await this.input.store.connections.findByUserId(userId);
    if (!isSyncable(beforePersist)) {
      throw new Error('connection no longer syncable');
    }
    if (this.input.persistSnapshot) {
      await this.input.persistSnapshot(records, syncedAt);
    }
    const latest = await this.input.store.connections.findByUserId(userId);
    if (!isSyncable(latest)) {
      throw new Error('connection no longer syncable');
    }
    if (!markSnapshotSuccessful) {
      return;
    }
    const stamped = await this.input.store.connections.markLastSuccessfulSyncIfSyncable({
      id: latest.id,
      userId: latest.userId,
      syncedAt,
    });
    if (!stamped) {
      throw new Error('connection no longer syncable');
    }
  }

  async syncRecords(userId: string, range: HealthDateRange): Promise<SnapshotRecordSyncResult> {
    const collected = await this.collectRecords(userId, range);
    if (collected.hasSuccessfulQuery) {
      await this.persistRecords(
        userId,
        collected.records,
        collected.syncedAt,
        collected.succeededDataTypes.length === 3,
      );
    }
    return {
      records: collected.hasSuccessfulQuery ? collected.records : undefined,
      succeededDataTypes: collected.succeededDataTypes,
      failures: collected.failures,
    };
  }

  async listRecords(userId: string, range: HealthDateRange): Promise<UserHealthRecords> {
    const collected = await this.collectRecords(userId, range);
    const firstFailure = collected.failures[0];
    if (firstFailure) {
      throw firstFailure.error;
    }
    if (collected.hasSuccessfulQuery) {
      await this.persistRecords(userId, collected.records, collected.syncedAt, true);
    }
    return collected.records;
  }
}

export function unavailableGoogleHealthRecords(): UserHealthRecords {
  return emptyUserHealthRecords();
}
