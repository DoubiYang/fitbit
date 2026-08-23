import { buildTodayView } from '../../../src/server/dashboard/build-today';
import { DemoHealthProvider } from '../../../src/server/health/demo-provider';
import { getCurrentUser } from '../../../src/server/session/current-user';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const user = await getCurrentUser();
  const now = new Date().toISOString();
  const view = await buildTodayView({
    provider: new DemoHealthProvider(),
    userId: user.id,
    now,
    lastSuccessfulSyncAt: now,
  });

  return Response.json(view, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
