import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FETCH_TIMEOUT_MS = 4 * 60 * 1_000;
export const TICK_INTERVAL_MS = 60_000;

export async function tick(input) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const log = input.log ?? console.log;
  const error = input.error ?? console.error;
  const timeoutMs = input.timeoutMs ?? FETCH_TIMEOUT_MS;
  try {
    const response = await fetchImpl(input.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.secret}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      error(`[sync] request failed with status ${response.status}`);
      return;
    }
    const result = await response.json();
    log(`[sync] claimed=${Number(result.claimed) || 0} succeeded=${Number(result.succeeded) || 0} failed=${Number(result.failed) || 0}`);
  } catch {
    error('[sync] request failed');
  }
}

export async function runWorker(input) {
  const log = input.log ?? console.log;
  const error = input.error ?? console.error;
  if (!input.secret) {
    error('[sync] SYNC_SECRET missing; scheduler disabled');
    return 'disabled';
  }
  const intervalMs = input.intervalMs ?? TICK_INTERVAL_MS;
  const sleepImpl = input.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let ticks = 0;
  for (;;) {
    await tick({
      endpoint: input.endpoint,
      secret: input.secret,
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs,
      log,
      error,
    });
    ticks += 1;
    if (input.maxTicks !== undefined && ticks >= input.maxTicks) {
      return 'running';
    }
    await sleepImpl(intervalMs);
  }
}

async function main() {
  const endpoint = process.env.SYNC_ENDPOINT ?? 'http://app:3000/rhythm/api/internal/sync';
  const secret = process.env.SYNC_SECRET;
  if (!secret) {
    console.error('[sync] SYNC_SECRET missing; scheduler disabled');
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, TICK_INTERVAL_MS));
    }
  }
  await runWorker({ endpoint, secret, log: console.log, error: console.error });
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  void main();
}
