'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

export const TIME_ZONE_ENDPOINT = '/rhythm/api/settings/time-zone';
export const TIME_ZONE_READY_EVENT = 'rhythm:timezone-ready';

export async function submitBrowserTimeZone(fetchImpl: typeof fetch = fetch): Promise<'submitted' | 'failed'> {
  const ianaTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const response = await fetchImpl(TIME_ZONE_ENDPOINT, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ianaTimeZone }),
      credentials: 'same-origin',
    });
    return response.ok ? 'submitted' : 'failed';
  } catch {
    return 'failed';
  }
}

export async function submitBrowserTimeZoneAndRefresh(
  refreshReadModel: () => void,
  fetchImpl: typeof fetch = fetch,
): Promise<'submitted' | 'failed'> {
  const result = await submitBrowserTimeZone(fetchImpl);
  if (result === 'submitted') {
    refreshReadModel();
  }
  return result;
}

export function TimeZoneBootstrap({ refreshReadModel }: { refreshReadModel?: () => void } = {}) {
  const [status, setStatus] = useState<'idle' | 'submitted' | 'failed'>('idle');

  useEffect(() => {
    let cancelled = false;
    void (refreshReadModel ? submitBrowserTimeZoneAndRefresh(refreshReadModel) : submitBrowserTimeZone()).then((result) => {
      if (cancelled) {
        return;
      }
      setStatus(result);
      if (result === 'submitted' && typeof window !== 'undefined') {
        window.dispatchEvent(new Event(TIME_ZONE_READY_EVENT));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [refreshReadModel]);

  return <span hidden data-timezone-bootstrap={status} />;
}

export function DashboardTimeZoneBootstrap() {
  const router = useRouter();
  const refreshReadModel = useCallback(() => router.refresh(), [router]);
  return <TimeZoneBootstrap refreshReadModel={refreshReadModel} />;
}
