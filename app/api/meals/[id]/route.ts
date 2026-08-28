import { createRequestDeps } from '../../../../src/server/auth/runtime';
import { loadConfig } from '../../../../src/server/config/env';
import { handleCurrentMeal } from '../../../../src/server/meals/http';

export const dynamic = 'force-dynamic';

async function depsOrError() {
  const config = loadConfig();
  const deps = await createRequestDeps();
  return { config, store: config.kind === 'oauth' ? deps.store : undefined };
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { config, store } = await depsOrError();
  if (config.kind !== 'oauth' || !store) {
    return Response.json({ error: 'not_configured' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  return handleCurrentMeal(request, (await context.params).id, { config, store });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { config, store } = await depsOrError();
  if (config.kind !== 'oauth' || !store) {
    return Response.json({ error: 'not_configured' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  return handleCurrentMeal(request, (await context.params).id, { config, store });
}
