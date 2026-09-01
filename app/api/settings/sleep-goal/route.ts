import { createRequestDeps } from '../../../../src/server/auth/runtime';
import { handleGetSleepGoal, handlePutSleepGoal } from '../../../../src/server/settings/sleep-goal';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleGetSleepGoal(request, await createRequestDeps());
}

export async function PUT(request: Request): Promise<Response> {
  return handlePutSleepGoal(request, await createRequestDeps());
}
