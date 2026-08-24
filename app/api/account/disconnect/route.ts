import { handleDisconnect } from '../../../../src/server/auth/http';
import { createRequestDeps } from '../../../../src/server/auth/runtime';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleDisconnect(request, await createRequestDeps());
}
