import { createRequestDeps } from '../../../../src/server/auth/runtime';
import { handleGetTimeZone, handlePutTimeZone } from '../../../../src/server/settings/time-zone';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleGetTimeZone(request, await createRequestDeps());
}

export async function PUT(request: Request): Promise<Response> {
  return handlePutTimeZone(request, await createRequestDeps());
}
