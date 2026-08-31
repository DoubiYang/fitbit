import type { GoogleDataPoint } from './map-records';

const API_ROOT = 'https://health.googleapis.com/v4';
const DEFAULT_PAGE_SIZE = 25;

export type ReconcileDataPointsInput = {
  accessToken: string;
  dataType: string;
  filter: string;
  pageSize?: number;
};

export type HealthApiClient = {
  listDataPoints(input: ReconcileDataPointsInput): Promise<GoogleDataPoint[]>;
  iterateReconciledDataPoints?(input: ReconcileDataPointsInput): AsyncGenerator<GoogleDataPoint[], void, undefined>;
};

async function fetchPage(url: string, accessToken: string): Promise<{ dataPoints?: GoogleDataPoint[]; nextPageToken?: string }> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
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
      pageSize: String(input.pageSize ?? DEFAULT_PAGE_SIZE),
      dataSourceFamily: 'users/me/dataSourceFamilies/google-wearables',
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }
    const reconcileUrl = `${API_ROOT}/users/me/dataTypes/${input.dataType}/dataPoints:reconcile?${params.toString()}`;
    const page = await fetchPage(reconcileUrl, input.accessToken);
    yield page.dataPoints ?? [];
    pageToken = page.nextPageToken;
  } while (pageToken);
}

export function createHealthApiClient(): Required<HealthApiClient> {
  return {
    iterateReconciledDataPoints(input): AsyncGenerator<GoogleDataPoint[], void, undefined> {
      return iterateReconciledPages(input);
    },
    async listDataPoints(input) {
      const collected: GoogleDataPoint[] = [];
      for await (const page of iterateReconciledPages(input)) {
        collected.push(...page);
      }
      return collected;
    },
  };
}
