import { checkPostOrigin, type HttpDeps } from '../auth/http';
import { TimeZoneHistoryConflictError } from '../health/cardio-store';
import { reindexStoredMinutesForTimeZone } from '../health/cardio-reindex';
import { loadHealthSnapshot } from '../health/snapshot-store';
import { getCurrentUser } from '../session/current-user';

export const TIME_ZONE_BACKFILL_EPOCH = '1970-01-01T00:00:00.000Z';

export function isValidIanaTimeZone(value: string): boolean {
  if (!value || value.length > 128 || value !== value.trim()) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

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

export async function handleGetTimeZone(request: Request, deps: HttpDeps): Promise<Response> {
  const session = await requireOauthUser(request, deps, false);
  if (isResponse(session)) {
    return session;
  }
  const now = deps.now?.() ?? new Date();
  const current = await deps.store!.healthMetrics.lookupTimeZoneHistory({ userId: session.userId, at: now.toISOString() });
  const history = await deps.store!.healthMetrics.listTimeZoneHistory(session.userId);
  return json({
    ianaTimeZone: current?.ianaTimeZone ?? null,
    effectiveAt: current?.effectiveAt ?? null,
    isBackfillAnchor: current?.isBackfillAnchor ?? null,
    history: history.map((row) => ({
      ianaTimeZone: row.ianaTimeZone,
      effectiveAt: row.effectiveAt,
      isBackfillAnchor: row.isBackfillAnchor,
    })),
  });
}

export async function handlePutTimeZone(request: Request, deps: HttpDeps): Promise<Response> {
  const session = await requireOauthUser(request, deps, true);
  if (isResponse(session)) {
    return session;
  }
  const body = await readJson(request);
  const ianaTimeZone = typeof body === 'object' && body !== null ? (body as { ianaTimeZone?: unknown }).ianaTimeZone : undefined;
  if (typeof ianaTimeZone !== 'string' || !isValidIanaTimeZone(ianaTimeZone)) {
    return json({ error: 'invalid_time_zone' }, 400);
  }

  const store = deps.store!;
  const now = deps.now?.() ?? new Date();
  const connection = await store.connections.findByUserId(session.userId);
  const databaseUrl = deps.config.kind === 'oauth' ? deps.config.databaseUrl : undefined;
  const loadSnapshot =
    deps.snapshotForUser ??
    (databaseUrl ? (userId: string) => loadHealthSnapshot(databaseUrl, userId) : undefined);

  let written: { ianaTimeZone: string; effectiveAt: string; isBackfillAnchor: boolean } | undefined;
  try {
    await store.withTransaction(async (inner) => {
      const existing = await inner.healthMetrics.listTimeZoneHistory(session.userId);
      const current = existing.reduce<typeof existing[number] | undefined>((latest, row) => {
        if (!latest || Date.parse(row.effectiveAt) > Date.parse(latest.effectiveAt)) {
          return row;
        }
        return latest;
      }, undefined);
      if (current?.ianaTimeZone === ianaTimeZone) {
        written = {
          ianaTimeZone: current.ianaTimeZone,
          effectiveAt: current.effectiveAt,
          isBackfillAnchor: current.isBackfillAnchor,
        };
        return;
      }

      const isBackfillAnchor = existing.length === 0;
      let effectiveAt = now.toISOString();
      if (isBackfillAnchor) {
        const stored = await inner.healthMetrics.listMinutesInRange({
          userId: session.userId,
          fromUtc: TIME_ZONE_BACKFILL_EPOCH,
        });
        effectiveAt = stored[0]?.minuteStartUtc ?? TIME_ZONE_BACKFILL_EPOCH;
      }

      await inner.healthMetrics.insertTimeZoneHistory({
        userId: session.userId,
        ianaTimeZone,
        effectiveAt,
        isBackfillAnchor,
      });
      const history = await inner.healthMetrics.listTimeZoneHistory(session.userId);
      const next = history.find((row) => Date.parse(row.effectiveAt) > Date.parse(effectiveAt));
      await reindexStoredMinutesForTimeZone(inner, {
        userId: session.userId,
        ianaTimeZone,
        fromUtc: isBackfillAnchor ? TIME_ZONE_BACKFILL_EPOCH : effectiveAt,
        toUtcExclusive: next?.effectiveAt,
        now,
        loadSnapshot,
        lastSuccessfulSyncAt: connection?.lastSuccessfulSyncAt,
      });
      written = { ianaTimeZone, effectiveAt, isBackfillAnchor };
    });
  } catch (error) {
    if (error instanceof TimeZoneHistoryConflictError) {
      return json({ error: error.name }, 409);
    }
    throw error;
  }

  return json(written);
}
