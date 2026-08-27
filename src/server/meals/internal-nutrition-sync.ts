import { canWriteNutrition } from '../auth/scopes';
import type { AuthStore } from '../auth/types';
import type { HttpDeps } from '../auth/http';
import { createGoogleTokenRefresher, resolveAccessToken } from '../health/access-token';
import { hasValidSyncBearerToken } from '../health/sync-auth';
import { runCurrentMealSyncOutbox } from './current-meal-sync';
import {
  createGoogleNutritionOutboxClient,
  runNutritionOutbox,
  type GoogleNutritionOutboxClient,
} from './nutrition-outbox';

const noStore = { 'Cache-Control': 'no-store' } as const;

export type NutritionSyncCounts = {
  claimed: number;
  succeeded: number;
  failed: number;
  retrying: number;
  unknown: number;
};

type NutritionSyncWorkerInput = {
  store: AuthStore;
  tokenForUser(userId: string): Promise<string>;
  google: GoogleNutritionOutboxClient;
};

export type InternalNutritionSyncWorkers = {
  runLegacy(input: NutritionSyncWorkerInput): Promise<NutritionSyncCounts>;
  runCurrentMeals(input: NutritionSyncWorkerInput): Promise<NutritionSyncCounts>;
};

type InternalNutritionSyncOptions = Partial<InternalNutritionSyncWorkers> & {
  tokenForUser?: (userId: string) => Promise<string>;
  google?: GoogleNutritionOutboxClient;
};

export type InternalNutritionSyncResult = NutritionSyncCounts & {
  legacy: NutritionSyncCounts;
  currentMeals: NutritionSyncCounts;
};

function emptyCounts(): NutritionSyncCounts {
  return { claimed: 0, succeeded: 0, failed: 0, retrying: 0, unknown: 0 };
}

function addCounts(left: NutritionSyncCounts, right: NutritionSyncCounts): NutritionSyncCounts {
  return {
    claimed: left.claimed + right.claimed,
    succeeded: left.succeeded + right.succeeded,
    failed: left.failed + right.failed,
    retrying: left.retrying + right.retrying,
    unknown: left.unknown + right.unknown,
  };
}

/**
 * The scheduler must keep consuming the other independently persisted outbox
 * if one worker hits an unexpected local failure.  No success is inferred
 * from a thrown worker: it contributes exactly one controlled failure.
 */
async function runSafely(
  worker: (input: NutritionSyncWorkerInput) => Promise<NutritionSyncCounts>,
  input: NutritionSyncWorkerInput,
): Promise<NutritionSyncCounts> {
  try {
    return await worker(input);
  } catch {
    return { ...emptyCounts(), failed: 1 };
  }
}

function syncable(status: string): boolean {
  return status === 'active' || status === 'partial';
}

export async function handleInternalNutritionSync(
  request: Request,
  deps: HttpDeps,
  options: InternalNutritionSyncOptions = {},
): Promise<Response> {
  const config = deps.config;
  const store = deps.store;
  if (config.kind !== 'oauth' || !store) {
    return Response.json({ error: 'not_configured' }, { status: 503, headers: noStore });
  }
  if (!config.syncSecret) {
    return Response.json({ error: 'scheduler_disabled' }, { status: 503, headers: noStore });
  }
  if (!hasValidSyncBearerToken(request.headers.get('Authorization') ?? undefined, config.syncSecret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: noStore });
  }
  const oauthConfig = config;
  const tokenForUser = options.tokenForUser ?? (async (userId: string) => {
    const connection = await store.connections.findByUserId(userId);
    if (!connection || !syncable(connection.status) || !canWriteNutrition(connection.grantedScopes)) {
      throw new Error('nutrition write connection unavailable');
    }
    return resolveAccessToken({
      config: oauthConfig,
      store,
      connection,
      refresher: createGoogleTokenRefresher(oauthConfig),
    });
  });
  const workerInput: NutritionSyncWorkerInput = {
    store,
    tokenForUser,
    google: options.google ?? createGoogleNutritionOutboxClient(),
  };
  const legacy = await runSafely(options.runLegacy ?? runNutritionOutbox, workerInput);
  const currentMeals = await runSafely(options.runCurrentMeals ?? runCurrentMealSyncOutbox, workerInput);
  const result: InternalNutritionSyncResult = {
    ...addCounts(legacy, currentMeals),
    legacy,
    currentMeals,
  };
  return Response.json(result, { headers: noStore });
}
