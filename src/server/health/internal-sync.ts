import type { HttpDeps } from '../auth/http';
import { runDueSyncs } from './scheduled-sync';
import { hasValidSyncBearerToken } from './sync-auth';

const noStore = { 'Cache-Control': 'no-store' } as const;

export async function handleInternalSync(request: Request, deps: HttpDeps): Promise<Response> {
  if (deps.config.kind !== 'oauth' || !deps.store) {
    return Response.json({ error: 'not_configured' }, { status: 503, headers: noStore });
  }
  if (!deps.config.syncSecret) {
    return Response.json({ error: 'scheduler_disabled' }, { status: 503, headers: noStore });
  }
  if (!hasValidSyncBearerToken(request.headers.get('Authorization') ?? undefined, deps.config.syncSecret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: noStore });
  }
  const result = await runDueSyncs({ config: deps.config, store: deps.store });
  return Response.json(result, { headers: noStore });
}
