const endpoint = process.env.SYNC_ENDPOINT ?? 'http://app:3000/rhythm/api/internal/sync';
const secret = process.env.SYNC_SECRET;

if (!secret) {
  throw new Error('SYNC_SECRET is required for the sync worker');
}

async function tick() {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!response.ok) {
      console.error(`[sync] request failed with status ${response.status}`);
      return;
    }
    const result = await response.json();
    console.log(`[sync] claimed=${Number(result.claimed) || 0} succeeded=${Number(result.succeeded) || 0} failed=${Number(result.failed) || 0}`);
  } catch {
    console.error('[sync] request failed');
  }
}

await tick();
setInterval(() => {
  void tick();
}, 60_000);
