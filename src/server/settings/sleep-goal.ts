import { sleepGoalEffectiveCivilDate } from '../../domain/cardio-records';
import { checkPostOrigin, type HttpDeps } from '../auth/http';
import { SleepGoalConflictError } from '../health/cardio-store';
import { getCurrentUser } from '../session/current-user';
import { civilDate } from '../time/civil-date';

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function requireOauthUser(request: Request, deps: HttpDeps, write: boolean): Promise<{ userId: string } | Response> {
  if (write) {
    const originError = checkPostOrigin(request, deps.config);
    if (originError) {
      return json({ error: originError }, 403);
    }
  }
  const user = await getCurrentUser({
    config: deps.config,
    store: deps.store,
    cookieHeader: request.headers.get('Cookie'),
    now: deps.now?.(),
  });
  if (user.mode === 'unauthenticated') {
    return json({ error: 'unauthenticated' }, 401);
  }
  if (user.mode !== 'oauth' || !deps.store) {
    return json({ error: 'unconfigured' }, 503);
  }
  return { userId: user.id };
}

function isResponse(value: { userId: string } | Response): value is Response {
  return value instanceof Response;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function parseGoalMinutes(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 300 || value > 900) {
    return undefined;
  }
  return value;
}

export async function handleGetSleepGoal(request: Request, deps: HttpDeps): Promise<Response> {
  const session = await requireOauthUser(request, deps, false);
  if (isResponse(session)) {
    return session;
  }
  const now = deps.now?.() ?? new Date();
  const zone = await deps.store!.healthMetrics.lookupTimeZoneHistory({ userId: session.userId, at: now.toISOString() });
  const civil = zone ? civilDate(now, zone.ianaTimeZone) : '9999-12-31';
  const goal = await deps.store!.healthMetrics.lookupSleepGoal({ userId: session.userId, civilDate: civil });
  return json({
    goalMinutes: goal?.goalMinutes ?? null,
    effectiveCivilDate: goal?.effectiveCivilDate ?? null,
  });
}

export async function handlePutSleepGoal(request: Request, deps: HttpDeps): Promise<Response> {
  const session = await requireOauthUser(request, deps, true);
  if (isResponse(session)) {
    return session;
  }
  const body = await readJson(request);
  const goalMinutes = parseGoalMinutes(
    typeof body === 'object' && body !== null ? (body as { goalMinutes?: unknown }).goalMinutes : undefined,
  );
  if (goalMinutes === undefined) {
    return json({ error: 'invalid_sleep_goal' }, 400);
  }

  const now = deps.now?.() ?? new Date();
  const zone = await deps.store!.healthMetrics.lookupTimeZoneHistory({ userId: session.userId, at: now.toISOString() });
  if (!zone) {
    return json({ error: 'time_zone_required' }, 400);
  }

  const settingCivilDate = civilDate(now, zone.ianaTimeZone);
  const effectiveCivilDate = sleepGoalEffectiveCivilDate(settingCivilDate);

  try {
    await deps.store!.healthMetrics.insertSleepGoal({
      userId: session.userId,
      goalMinutes,
      effectiveCivilDate,
    });
  } catch (error) {
    if (error instanceof SleepGoalConflictError) {
      return json({ error: 'SleepGoalConflictError' }, 409);
    }
    throw error;
  }

  return json({ goalMinutes, effectiveCivilDate });
}
