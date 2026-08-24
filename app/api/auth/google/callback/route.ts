import { handleGoogleCallback } from '../../../../../src/server/auth/http';
import { createRequestDeps } from '../../../../../src/server/auth/runtime';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleGoogleCallback(request, await createRequestDeps());
}
