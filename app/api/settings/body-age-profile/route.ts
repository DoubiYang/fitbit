import { createRequestDeps } from '../../../../src/server/auth/runtime';
import { handleGetBodyAgeProfile, handlePutBodyAgeProfile } from '../../../../src/server/settings/body-age-profile';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleGetBodyAgeProfile(request, await createRequestDeps());
}

export async function PUT(request: Request): Promise<Response> {
  return handlePutBodyAgeProfile(request, await createRequestDeps());
}
