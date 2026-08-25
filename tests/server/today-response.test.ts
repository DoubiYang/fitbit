import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSleepSession } from '../../src/domain/health-records';
import { buildTodayResponse, buildTodayViewForUser } from '../../src/server/dashboard/today-response';

test('oauth today responses never fall back to demo_user', async () => {
  const response = await buildTodayResponse({ mode: 'oauth', id: '11111111-1111-1111-1111-111111111111' });
  const body = (await response.json()) as { userId: string };
  assert.equal(response.status, 200);
  assert.equal(body.userId, '11111111-1111-1111-1111-111111111111');
  assert.equal(JSON.stringify(body).includes('demo_user'), false);
});

test('oauth today view reads a stored snapshot and does not fetch live google records', async () => {
  let snapshotReads = 0;
  const view = await buildTodayViewForUser({ mode: 'oauth', id: 'u1' }, '2026-08-24T12:00:00.000Z', {
    config: { kind: 'demo', appOrigin: 'http://localhost:3000' },
    snapshotForUser: async (userId) => {
      snapshotReads += 1;
      assert.equal(userId, 'u1');
      return {
        syncedAt: new Date('2026-08-24T06:00:00.000Z'),
        records: {
          sleepSessions: [
            parseSleepSession({
              userId: 'u1',
              source: 'google_health',
              sourceRecordId: 'sleep-1',
              id: 'sleep-1',
              startTime: '2026-08-23T21:00:00.000Z',
              endTime: '2026-08-24T05:00:00.000Z',
              civilEndDate: '2026-08-24',
              utcOffsetMinutes: 0,
              minutesAsleep: 400,
              isNap: false,
              processed: true,
            }),
          ],
          dailyHrv: [],
          dailyRhr: [],
          trainingDays: [],
        },
      };
    },
  });

  assert.equal(snapshotReads, 1);
  assert.equal(view?.userId, 'u1');
  assert.notEqual(view?.metrics.sleep.quality, undefined);
});

test('oauth today view stays empty when no snapshot has been synced yet', async () => {
  const view = await buildTodayViewForUser({ mode: 'oauth', id: 'u1' }, '2026-08-24T12:00:00.000Z', {
    config: { kind: 'demo', appOrigin: 'http://localhost:3000' },
    snapshotForUser: async () => undefined,
  });
  assert.equal(view?.userId, 'u1');
  assert.equal(view?.metrics.recovery.score, null);
  assert.equal(view?.primaryAction.kind, 'data_state');
});

test('unauthenticated today is 401 and unconfigured is 503', async () => {
  const unauthenticated = await buildTodayResponse({ mode: 'unauthenticated' });
  const unconfigured = await buildTodayResponse({ mode: 'unconfigured' });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unconfigured.status, 503);
  assert.equal(JSON.stringify(await unauthenticated.json()).includes('demo_user'), false);
  assert.equal(JSON.stringify(await unconfigured.json()).includes('demo_user'), false);
});
