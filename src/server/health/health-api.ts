import type { GoogleDataPoint } from './map-records';

const API_ROOT = 'https://health.googleapis.com/v4';

export type HealthApiClient = {
  listDataPoints(input: { accessToken: string; dataType: string; filter: string; pageSize?: number }): Promise<GoogleDataPoint[]>;
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

export function createHealthApiClient(): HealthApiClient {
  return {
    async listDataPoints(input) {
      const collected: GoogleDataPoint[] = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({
          filter: input.filter,
          pageSize: String(input.pageSize ?? 25),
          dataSourceFamily: 'users/me/dataSourceFamilies/google-wearables',
        });
        if (pageToken) {
          params.set('pageToken', pageToken);
        }
        const reconcileUrl = `${API_ROOT}/users/me/dataTypes/${input.dataType}/dataPoints:reconcile?${params.toString()}`;
        const page = await fetchPage(reconcileUrl, input.accessToken);
        collected.push(...(page.dataPoints ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return collected;
    },
  };
}
