import type { HttpDeps } from '../auth/http';
import { DemoHealthProvider } from '../health/demo-provider';
import { emptyUserHealthRecords } from '../health/provider';
import { loadHealthSnapshot } from '../health/snapshot-store';
import { buildTodayView, toHomepageTodayView, type TodayView } from './build-today';
import type { CurrentUser } from '../session/current-user';

async function oauthSnapshot(userId: string, deps: HttpDeps) {
  if (deps.snapshotForUser) {
    return deps.snapshotForUser(userId);
  }
  if (deps.config.kind !== 'oauth') {
    return undefined;
  }
  return loadHealthSnapshot(deps.config.databaseUrl, userId);
}

export async function buildTodayViewForUser(
  user: CurrentUser,
  now = new Date().toISOString(),
  deps?: HttpDeps,
): Promise<TodayView | undefined> {
  if (user.mode === 'demo') {
    return buildTodayView({
      provider: new DemoHealthProvider(),
      userId: user.id,
      now,
      lastSuccessfulSyncAt: now,
      allowDefaultTimeZone: true,
    });
  }
  if (user.mode === 'oauth') {
    const snapshot = deps ? await oauthSnapshot(user.id, deps) : undefined;
    const [connection, zone] = deps?.store
      ? await Promise.all([
          deps.store.connections.findByUserId(user.id),
          deps.store.healthMetrics.lookupTimeZoneHistory({ userId: user.id, at: now }),
        ])
      : [undefined, undefined];
    return buildTodayView({
      provider: {
        capabilities: { mode: 'oauth', canSync: Boolean(snapshot) },
        listRecords: async () => snapshot?.records ?? emptyUserHealthRecords(),
      },
      userId: user.id,
      now,
      lastSuccessfulSyncAt: connection?.lastSuccessfulSyncAt?.toISOString(),
      timeZone: zone?.ianaTimeZone,
      healthMetrics: deps?.store?.healthMetrics,
    });
  }
  return undefined;
}

export async function buildTodayResponse(
  user: CurrentUser,
  now = new Date().toISOString(),
  deps?: HttpDeps,
): Promise<Response> {
  if (user.mode === 'unconfigured') {
    return Response.json({ error: 'unconfigured' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  if (user.mode === 'unauthenticated') {
    return Response.json({ error: 'unauthenticated' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  const view = await buildTodayViewForUser(user, now, deps);
  return Response.json(toHomepageTodayView(view!), { headers: { 'Cache-Control': 'no-store' } });
}
