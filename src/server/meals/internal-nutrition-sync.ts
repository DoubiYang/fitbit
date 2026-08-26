import { canWriteNutrition } from '../auth/scopes';
import type { HttpDeps } from '../auth/http';
import { createGoogleTokenRefresher, resolveAccessToken } from '../health/access-token';
import { hasValidSyncBearerToken } from '../health/sync-auth';
import { createGoogleNutritionOutboxClient, runNutritionOutbox } from './nutrition-outbox';

const noStore = { 'Cache-Control': 'no-store' } as const;

function syncable(status: string): boolean {
  return status === 'active' || status === 'partial';
}

export async function handleInternalNutritionSync(request: Request, deps: HttpDeps): Promise<Response> {
  const config = deps.config;
  const store = deps.store;
  if (config.kind !== 'oauth' || !store) {
    return Response.json({ error: 'not_configured' }, { status: 503, headers: noStore });
  }
  if (!config.syncSecret) {
    return Response.json({ error: 'scheduler_disabled' }, { status: 503, headers: noStore });
  }
  if (!hasValidSyncBearerToken(request.headers.get('Authorization') ?? undefined, config.syncSecret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: noStore });
  }
  const oauthConfig = config;
  const result = await runNutritionOutbox({
    store,
    tokenForUser: async (userId) => {
      const connection = await store.connections.findByUserId(userId);
      if (!connection || !syncable(connection.status) || !canWriteNutrition(connection.grantedScopes)) {
        throw new Error('nutrition write connection unavailable');
      }
      return resolveAccessToken({
        config: oauthConfig,
        store,
        connection,
        refresher: createGoogleTokenRefresher(oauthConfig),
      });
    },
    google: createGoogleNutritionOutboxClient(),
  });
  return Response.json(result, { headers: noStore });
}
