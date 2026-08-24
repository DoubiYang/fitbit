import { emptyUserHealthRecords, type HealthProvider } from '../health/provider';
import { DemoHealthProvider } from '../health/demo-provider';
import { buildTodayView, type TodayView } from './build-today';
import type { CurrentUser } from '../session/current-user';

class WaitingSyncProvider implements HealthProvider {
  readonly capabilities = { mode: 'oauth' as const, canSync: false };

  async listRecords(): Promise<ReturnType<typeof emptyUserHealthRecords>> {
    return emptyUserHealthRecords();
  }
}

export async function buildTodayViewForUser(user: CurrentUser, now = new Date().toISOString()): Promise<TodayView | undefined> {
  if (user.mode === 'demo') {
    return buildTodayView({
      provider: new DemoHealthProvider(),
      userId: user.id,
      now,
      lastSuccessfulSyncAt: now,
    });
  }
  if (user.mode === 'oauth') {
    return buildTodayView({
      provider: new WaitingSyncProvider(),
      userId: user.id,
      now,
      lastSuccessfulSyncAt: undefined,
    });
  }
  return undefined;
}

export async function buildTodayResponse(user: CurrentUser, now = new Date().toISOString()): Promise<Response> {
  if (user.mode === 'unconfigured') {
    return Response.json({ error: 'unconfigured' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  if (user.mode === 'unauthenticated') {
    return Response.json({ error: 'unauthenticated' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  const view = await buildTodayViewForUser(user, now);
  return Response.json(view, { headers: { 'Cache-Control': 'no-store' } });
}
