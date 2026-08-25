import { createRequestDeps } from '../../../../src/server/auth/runtime';
import { runDueSyncs } from '../../../../src/server/health/scheduled-sync';
import { hasValidSyncBearerToken } from '../../../../src/server/health/sync-auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const deps = await createRequestDeps();
  if (deps.config.kind !== 'oauth' || !deps.store) {
    return Response.json({ error: 'not_configured' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  if (!hasValidSyncBearerToken(request.headers.get('Authorization') ?? undefined, deps.config.syncSecret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  const result = await runDueSyncs({ config: deps.config, store: deps.store });
  return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
