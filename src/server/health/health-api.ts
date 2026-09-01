import { HEART_RATE_ACTIVITY_LEVEL_PAGE_SIZE } from './filters';
import type { GoogleDataPoint } from './map-records';

const API_ROOT = 'https://health.googleapis.com/v4';
const DEFAULT_PAGE_SIZE = 25;

export type ReconcileDataPointsInput = {
  accessToken: string;
  dataType: string;
  filter: string;
  pageSize?: number;
  signal?: AbortSignal;
};

export type HealthApiClient = {
  listDataPoints(input: ReconcileDataPointsInput): Promise<GoogleDataPoint[]>;
  iterateReconciledDataPoints(input: ReconcileDataPointsInput): AsyncGenerator<GoogleDataPoint[], void, undefined>;
};

function isHighVolumeDataType(dataType: string): boolean {
  return dataType === 'heart-rate' || dataType === 'activity-level';
}

function reconcilePageSize(input: ReconcileDataPointsInput): number {
  if (input.pageSize !== undefined) {
    return input.pageSize;
  }
  return isHighVolumeDataType(input.dataType) ? HEART_RATE_ACTIVITY_LEVEL_PAGE_SIZE : DEFAULT_PAGE_SIZE;
}

async function fetchPage(url: string, accessToken: string, signal?: AbortSignal): Promise<{ dataPoints?: GoogleDataPoint[]; nextPageToken?: string }> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(`health api ${response.status}`);
  }
  return (await response.json()) as { dataPoints?: GoogleDataPoint[]; nextPageToken?: string };
}

async function* iterateReconciledPages(input: ReconcileDataPointsInput): AsyncGenerator<GoogleDataPoint[], void, undefined> {
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      filter: input.filter,
      pageSize: String(reconcilePageSize(input)),
      dataSourceFamily: 'users/me/dataSourceFamilies/google-wearables',
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }
    const reconcileUrl = `${API_ROOT}/users/me/dataTypes/${input.dataType}/dataPoints:reconcile?${params.toString()}`;
    if (input.signal?.aborted) {
      throw new Error('scheduled sync deadline exceeded');
    }
    const page = await fetchPage(reconcileUrl, input.accessToken, input.signal);
    yield page.dataPoints ?? [];
    pageToken = page.nextPageToken;
  } while (pageToken);
}

export function createHealthApiClient(): HealthApiClient {
  return {
    iterateReconciledDataPoints(input): AsyncGenerator<GoogleDataPoint[], void, undefined> {
      return iterateReconciledPages(input);
    },
    async listDataPoints(input) {
      if (isHighVolumeDataType(input.dataType)) {
        throw new Error(`${input.dataType} must use iterateReconciledDataPoints`);
      }
      const collected: GoogleDataPoint[] = [];
      for await (const page of iterateReconciledPages(input)) {
        collected.push(...page);
      }
      return collected;
    },
  };
}
