import { checkPostOrigin, type HttpDeps } from '../auth/http';
import { getCurrentUser } from '../session/current-user';
import { utcCivilDate } from '../time/civil-date';

type ReferenceSex = 'male' | 'female' | null;

type BodyAgeProfilePayload = {
  birthDate: string | null;
  referenceSex: ReferenceSex;
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function requireOauthUser(request: Request, deps: HttpDeps, write: boolean): Promise<{ userId: string } | Response> {
  if (write) {
    const originError = checkPostOrigin(request, deps.config);
    if (originError) return json({ error: originError }, 403);
  }
  const user = await getCurrentUser({
    config: deps.config,
    store: deps.store,
    cookieHeader: request.headers.get('Cookie'),
    now: deps.now?.(),
  });
  if (user.mode === 'unauthenticated') return json({ error: 'unauthenticated' }, 401);
  if (user.mode !== 'oauth' || !deps.store) return json({ error: 'unconfigured' }, 503);
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

function isCivilDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const instant = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}

function parseProfilePayload(body: unknown, now: Date): BodyAgeProfilePayload | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(value, 'birthDate') || !Object.prototype.hasOwnProperty.call(value, 'referenceSex')) {
    return undefined;
  }
  const birthDate = value.birthDate;
  const referenceSex = value.referenceSex;
  if (birthDate !== null && (!isCivilDate(birthDate) || birthDate > utcCivilDate(now))) return undefined;
  if (referenceSex !== null && referenceSex !== 'male' && referenceSex !== 'female') return undefined;
  return { birthDate, referenceSex };
}

export async function handleGetBodyAgeProfile(request: Request, deps: HttpDeps): Promise<Response> {
  const session = await requireOauthUser(request, deps, false);
  if (isResponse(session)) return session;
  const profile = await deps.store!.healthMetrics.getBodyAgeProfile({ userId: session.userId });
  return json({
    birthDate: profile?.birthDate ?? null,
    referenceSex: profile?.referenceSex ?? null,
    profileRevision: profile?.profileRevision ?? 0,
  });
}

export async function handlePutBodyAgeProfile(request: Request, deps: HttpDeps): Promise<Response> {
  const session = await requireOauthUser(request, deps, true);
  if (isResponse(session)) return session;
  const payload = parseProfilePayload(await readJson(request), deps.now?.() ?? new Date());
  if (!payload) return json({ error: 'invalid_body_age_profile' }, 400);

  const profile = await deps.store!.healthMetrics.updateBodyAgeProfile({
    userId: session.userId,
    birthDate: payload.birthDate,
    referenceSex: payload.referenceSex,
  });
  return json({
    birthDate: profile.birthDate ?? null,
    referenceSex: profile.referenceSex ?? null,
    profileRevision: profile.profileRevision,
    recomputePending: true,
  });
}
