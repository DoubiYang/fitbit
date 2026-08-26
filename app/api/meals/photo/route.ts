import { createRequestDeps } from '../../../../src/server/auth/runtime';
import { loadConfig } from '../../../../src/server/config/env';
import { handleMealPhoto } from '../../../../src/server/meals/http';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const config = loadConfig();
  const deps = await createRequestDeps();
  if (config.kind !== 'oauth' || !deps.store) {
    return Response.json({ error: 'not_configured' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  return handleMealPhoto(request, { config, store: deps.store });
}
