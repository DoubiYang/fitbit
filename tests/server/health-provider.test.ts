import assert from 'node:assert/strict';
import test from 'node:test';

import { DemoHealthProvider } from '../../src/server/health/demo-provider';
import { GoogleHealthProvider, IntegrationUnavailableError } from '../../src/server/health/google-health-provider';
import { getCurrentUser } from '../../src/server/session/current-user';

const range = { from: '2026-07-24', to: '2026-08-22' };

test('fails closed when Google Health is not configured', async () => {
  const provider = new GoogleHealthProvider({ clientId: undefined, clientSecret: undefined });

  await assert.rejects(
    () => provider.listRecords('user_a', range),
    (error: unknown) => error instanceof IntegrationUnavailableError && error.code === 'integration_unavailable',
  );
});

test('returns copied demo records only for the resolved demo user', async () => {
  const provider = new DemoHealthProvider();
  const first = await provider.listRecords('demo_user', range);
  const second = await provider.listRecords('demo_user', range);
  const otherUser = await provider.listRecords('user_b', range);

  assert.ok(first.sleepSessions.length >= 14);
  assert.notEqual(first.sleepSessions, second.sleepSessions);
  assert.deepEqual(otherUser, { sleepSessions: [], dailyHrv: [], dailyRhr: [], trainingDays: [] });
});

test('uses a server-owned demo session rather than a client-supplied health user ID', async () => {
  const user = await getCurrentUser();

  assert.deepEqual(user, { id: 'demo_user', mode: 'demo' });
});
