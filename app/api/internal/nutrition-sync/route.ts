import { createRequestDeps } from '../../../../src/server/auth/runtime';
import { handleInternalNutritionSync } from '../../../../src/server/meals/internal-nutrition-sync';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleInternalNutritionSync(request, await createRequestDeps());
}
