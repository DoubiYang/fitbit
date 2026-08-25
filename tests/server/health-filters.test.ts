import assert from 'node:assert/strict';
import test from 'node:test';

import { dataPointFilter } from '../../src/server/health/filters';

test('daily metric filters use the list/reconcile camelCase type names', () => {
  const hrv = dataPointFilter('daily-heart-rate-variability', '2026-05-26', '2026-08-25');
  const rhr = dataPointFilter('daily-resting-heart-rate', '2026-05-26', '2026-08-25');
  assert.equal(
    hrv,
    'dailyHeartRateVariability.date >= "2026-05-26" AND dailyHeartRateVariability.date < "2026-08-25"',
  );
  assert.equal(
    rhr,
    'dailyRestingHeartRate.date >= "2026-05-26" AND dailyRestingHeartRate.date < "2026-08-25"',
  );
});
