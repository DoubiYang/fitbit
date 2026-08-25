import type { OAuthConfig } from '../config/env';
import type { AuthStore, ConnectionRow } from '../auth/types';
import { emptyUserHealthRecords, type HealthDateRange, type HealthProvider, type UserHealthRecords } from './provider';
import { createHealthApiClient, type HealthApiClient } from './health-api';
import { createGoogleTokenRefresher, resolveAccessToken, type TokenRefresher } from './access-token';
import { dataPointFilter, exclusiveEnd } from './filters';
import { mapDailyHrv, mapDailyRhr, mapSleepSession, mapTrainingDays, type GoogleDataPoint } from './map-records';

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

export class GoogleHealthProvider implements HealthProvider {
  readonly capabilities = { mode: 'oauth' as const, canSync: true };

  constructor(private readonly input: LiveProviderInput) {}

  async listRecords(userId: string, range: HealthDateRange): Promise<UserHealthRecords> {
    if (userId !== this.input.connection.userId) {
      return emptyUserHealthRecords();
    }
    const accessToken = await resolveAccessToken({
      config: this.input.config,
      store: this.input.store,
      connection: this.input.connection,
      refresher: this.input.refresher ?? createGoogleTokenRefresher(this.input.config),
      now: this.input.now,
    });
    const api = this.input.api ?? createHealthApiClient();
    const until = exclusiveEnd(range.to);
    const [sleepPoints, hrvPoints, rhrPoints, exercisePoints] = await Promise.all([
      api.listDataPoints({
        accessToken,
        dataType: 'sleep',
        filter: dataPointFilter('sleep', range.from, until),
        pageSize: 25,
      }),
      api.listDataPoints({
        accessToken,
        dataType: 'daily-heart-rate-variability',
        filter: dataPointFilter('daily-heart-rate-variability', range.from, until),
      }),
      api.listDataPoints({
        accessToken,
        dataType: 'daily-resting-heart-rate',
        filter: dataPointFilter('daily-resting-heart-rate', range.from, until),
      }),
      api.listDataPoints({
        accessToken,
        dataType: 'exercise',
        filter: dataPointFilter('exercise', range.from, until),
        pageSize: 25,
      }),
    ]);

    const records: UserHealthRecords = {
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
      trainingDays: mapTrainingDays(exercisePoints, userId, inclusiveDates(range.from, range.to)),
    };

    const syncedAt = this.input.now ?? new Date();
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
    await this.input.store.connections.update({
      ...latest,
      lastSuccessfulSyncAt: syncedAt,
      updatedAt: syncedAt,
    });
    return records;
  }
}

export function unavailableGoogleHealthRecords(): UserHealthRecords {
  return emptyUserHealthRecords();
}
