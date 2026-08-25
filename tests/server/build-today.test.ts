import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSleepSession, type SleepSession } from '../../src/domain/health-records';
import { DemoHealthProvider } from '../../src/server/health/demo-provider';
import { emptyUserHealthRecords, type HealthProvider, type UserHealthRecords } from '../../src/server/health/provider';
import { buildTodayView } from '../../src/server/dashboard/build-today';

test('builds an evidence-complete view scoped to the requested user', async () => {
  const provider = new DemoHealthProvider();
  const view = await buildTodayView({
    provider,
    userId: 'demo_user',
    now: '2026-08-22T08:00:00.000Z',
    lastSuccessfulSyncAt: '2026-08-22T07:00:00.000Z',
  });

  assert.equal(view.userId, 'demo_user');
  assert.equal(view.primaryAction.kind, 'recommendation');
  assert.ok(view.primaryAction.evidence.length >= 2);
  assert.ok(view.primaryAction.evidence.every((evidence) => evidence.date.length === 10));
  assert.equal(JSON.stringify(view).includes('sourceRecordId'), false);
});

test('returns a data state instead of a training instruction with insufficient records', async () => {
  const provider: HealthProvider = {
    capabilities: { mode: 'demo', canSync: false },
    async listRecords(): Promise<UserHealthRecords> {
      return emptyUserHealthRecords();
    },
  };
  const view = await buildTodayView({
    provider,
    userId: 'demo_user',
    now: '2026-08-22T08:00:00.000Z',
    lastSuccessfulSyncAt: '2026-08-22T07:00:00.000Z',
  });

  assert.equal(view.primaryAction.kind, 'data_state');
  assert.equal('trainingPrescription' in view.primaryAction, false);
  assert.equal(view.metrics.recovery.score, null);
});

test('today range uses the Asia/Shanghai civil date before UTC midnight', async () => {
  let to: string | undefined;
  const provider: HealthProvider = {
    capabilities: { mode: 'oauth', canSync: true },
    async listRecords(_userId, range): Promise<UserHealthRecords> {
      to = range.to;
      return emptyUserHealthRecords();
    },
  };
  await buildTodayView({
    provider,
    userId: 'u1',
    now: '2026-08-23T23:00:00.000Z',
    lastSuccessfulSyncAt: '2026-08-23T22:00:00.000Z',
  });
  assert.equal(to, '2026-08-24');
});

test('does not allow provider records for another user into the view', async () => {
  const otherUserSleep = parseSleepSession({
    userId: 'another_user',
    source: 'google_health',
    sourceRecordId: 'other-sleep',
    id: 'other-sleep',
    startTime: '2026-08-21T15:00:00.000Z',
    endTime: '2026-08-21T23:00:00.000Z',
    civilEndDate: '2026-08-22',
    utcOffsetMinutes: 480,
    minutesAsleep: 480,
    isNap: false,
    processed: true,
  });
  const provider = recordsForOtherUser(otherUserSleep);
  const view = await buildTodayView({
    provider,
    userId: 'demo_user',
    now: '2026-08-22T08:00:00.000Z',
    lastSuccessfulSyncAt: '2026-08-22T07:00:00.000Z',
  });

  assert.equal(view.primaryAction.kind, 'data_state');
  assert.equal(view.metrics.sleep.score, null);
});

function recordsForOtherUser(sleepSession: SleepSession): HealthProvider {
  return {
    capabilities: { mode: 'demo', canSync: false },
    async listRecords(): Promise<UserHealthRecords> {
      return {
        sleepSessions: [sleepSession],
        dailyHrv: [],
        dailyRhr: [],
        trainingDays: [],
      };
    },
  };
}
