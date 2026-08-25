import { createRequestDeps } from '../../../../src/server/auth/runtime';
import { handleInternalSync } from '../../../../src/server/health/internal-sync';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleInternalSync(request, await createRequestDeps());
}
