import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGoogleNutritionOutboxClient,
  GoogleNutritionWriteError,
} from '../../src/server/meals/nutrition-outbox';

const firstName = 'users/me/dataTypes/nutrition-log/dataPoints/d-first';
const secondName = 'users/me/dataTypes/nutrition-log/dataPoints/d-second';

test('batchDelete posts unique names and returns its pending operation', async () => {
  let request: Request | undefined;
  const client = createGoogleNutritionOutboxClient(async (input, init) => {
    request = new Request(input, init);
    return Response.json({ done: false, name: 'operations/delete-1' });
  });

  const operation = await client.batchDelete('access-token', [firstName, firstName, secondName]);

  assert.equal(request?.url, 'https://health.googleapis.com/v4/users/me/dataTypes/nutrition-log/dataPoints:batchDelete');
  assert.equal(request?.method, 'POST');
  assert.equal(request?.headers.get('authorization'), 'Bearer access-token');
  assert.equal(request?.headers.get('content-type'), 'application/json');
  assert.deepEqual(await request?.json(), { names: [firstName, secondName] });
  assert.deepEqual(operation, { done: false, name: 'operations/delete-1', error: undefined });
});

test('batchDelete rejects an empty point-name list before making a request', async () => {
  let calls = 0;
  const client = createGoogleNutritionOutboxClient(async () => {
    calls += 1;
    return Response.json({ done: true });
  });

  await assert.rejects(
    () => client.batchDelete('access-token', []),
    /at least one data point name/i,
  );
  assert.equal(calls, 0);
});

test('batchDelete maps a non-success response to GoogleNutritionWriteError', async () => {
  const client = createGoogleNutritionOutboxClient(async () => new Response('forbidden', { status: 403 }));

  await assert.rejects(
    () => client.batchDelete('access-token', [firstName]),
    (error: unknown) => error instanceof GoogleNutritionWriteError && error.status === 403,
  );
});

test('batchDelete preserves a completed operation error for the worker to reject', async () => {
  const error = { code: 13, message: 'backend failure' };
  const client = createGoogleNutritionOutboxClient(async () => Response.json({ done: true, error }));

  assert.deepEqual(
    await client.batchDelete('access-token', [firstName]),
    { done: true, name: undefined, error },
  );
});

test('batchDelete does not accept a response without an operation body', async () => {
  const client = createGoogleNutritionOutboxClient(async () => new Response(null, { status: 204 }));

  await assert.rejects(() => client.batchDelete('access-token', [firstName]));
});

test('single-point GET still maps a 404 to undefined', async () => {
  const client = createGoogleNutritionOutboxClient(async () => new Response(null, { status: 404 }));

  assert.equal(await client.getDataPoint('access-token', firstName), undefined);
});
