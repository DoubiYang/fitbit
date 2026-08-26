import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FETCH_TIMEOUT_MS = 4 * 60 * 1_000;
export const TICK_INTERVAL_MS = 60_000;

export async function tick(input) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const log = input.log ?? console.log;
  const error = input.error ?? console.error;
  try {
    const response = await fetchImpl(input.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.secret}` },
      signal: AbortSignal.timeout(input.timeoutMs ?? FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      error(`[nutrition-sync] request failed with status ${response.status}`);
      return;
    }
    const result = await response.json();
    log(
      `[nutrition-sync] claimed=${Number(result.claimed) || 0} succeeded=${Number(result.succeeded) || 0} failed=${Number(result.failed) || 0} retrying=${Number(result.retrying) || 0} unknown=${Number(result.unknown) || 0}`,
    );
  } catch {
    error('[nutrition-sync] request failed');
  }
}

export async function runWorker(input) {
  const log = input.log ?? console.log;
  const error = input.error ?? console.error;
  if (!input.secret) {
    error('[nutrition-sync] SYNC_SECRET missing; scheduler disabled');
    return 'disabled';
  }
  const sleepImpl = input.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const intervalMs = input.intervalMs ?? TICK_INTERVAL_MS;
  let ticks = 0;
  for (;;) {
    await tick({ ...input, log, error });
    ticks += 1;
    if (input.maxTicks !== undefined && ticks >= input.maxTicks) {
      return 'running';
    }
    await sleepImpl(intervalMs);
  }
}

async function main() {
  const endpoint = process.env.NUTRITION_SYNC_ENDPOINT ?? 'http://app:3000/rhythm/api/internal/nutrition-sync';
  const secret = process.env.SYNC_SECRET;
  if (!secret) {
    console.error('[nutrition-sync] SYNC_SECRET missing; scheduler disabled');
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
