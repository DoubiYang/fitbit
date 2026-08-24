import { handleLogout } from '../../../../src/server/auth/http';
import { createRequestDeps } from '../../../../src/server/auth/runtime';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleLogout(request, await createRequestDeps());
}
