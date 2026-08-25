import assert from 'node:assert/strict';
import test from 'node:test';

import { dataPointFilter } from '../../src/server/health/filters';

test('daily metric filters use snake_case data type names required by Health API', () => {
  const hrv = dataPointFilter('daily-heart-rate-variability', '2026-05-26', '2026-08-25');
  const rhr = dataPointFilter('daily-resting-heart-rate', '2026-05-26', '2026-08-25');
  assert.match(hrv, /daily_heart_rate_variability\.date/);
  assert.doesNotMatch(hrv, /dailyHeartRateVariability/);
  assert.match(rhr, /daily_resting_heart_rate\.date/);
  assert.doesNotMatch(rhr, /dailyRestingHeartRate/);
});
