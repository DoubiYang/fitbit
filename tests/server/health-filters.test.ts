import assert from 'node:assert/strict';
import test from 'node:test';

import { dataPointFilter } from '../../src/server/health/filters';

test('daily metric filters use the Google Health API snake_case filter identifiers', () => {
  const hrv = dataPointFilter('daily-heart-rate-variability', '2026-05-26', '2026-08-25');
  const rhr = dataPointFilter('daily-resting-heart-rate', '2026-05-26', '2026-08-25');
  assert.equal(
    hrv,
    'daily_heart_rate_variability.date >= "2026-05-26" AND daily_heart_rate_variability.date < "2026-08-25"',
  );
  assert.equal(
    rhr,
    'daily_resting_heart_rate.date >= "2026-05-26" AND daily_resting_heart_rate.date < "2026-08-25"',
  );
});
