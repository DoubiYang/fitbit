import { handleGoogleStart } from '../../../../../src/server/auth/http';
import { createRequestDeps } from '../../../../../src/server/auth/runtime';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return new Response(null, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request): Promise<Response> {
  return handleGoogleStart(request, await createRequestDeps());
}
