import { createRequestDeps } from '../../../src/server/auth/runtime';
import { loadConfig } from '../../../src/server/config/env';
import { buildTodayResponse } from '../../../src/server/dashboard/today-response';
import { getCurrentUser } from '../../../src/server/session/current-user';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const config = loadConfig();
  if (config.kind === 'demo') {
    return buildTodayResponse({ mode: 'demo', id: 'demo_user' });
  }
  const deps = await createRequestDeps();
  const user = await getCurrentUser({
    config,
    store: deps.store,
    cookieHeader: request.headers.get('Cookie'),
  });
  return buildTodayResponse(user, new Date().toISOString(), deps);
}
