import assert from 'node:assert/strict';
import test from 'node:test';

import { dataPointFilter, HEART_RATE_ACTIVITY_LEVEL_PAGE_SIZE } from '../../src/server/health/filters';

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

test('heart-rate and activity-level filters use snake_case identifiers on RFC3339 instants', () => {
  const from = '2026-08-30T00:00:00.000Z';
  const until = '2026-08-31T00:00:00.000Z';
  const heartRate = dataPointFilter('heart-rate', from, until);
  const activityLevel = dataPointFilter('activity-level', from, until);

  assert.equal(
    heartRate,
    'heart_rate.sample_time.physical_time >= "2026-08-30T00:00:00.000Z" AND heart_rate.sample_time.physical_time < "2026-08-31T00:00:00.000Z"',
  );
  assert.equal(
    activityLevel,
    'activity_level.interval.start_time >= "2026-08-30T00:00:00.000Z" AND activity_level.interval.start_time < "2026-08-31T00:00:00.000Z"',
  );
  assert.equal(heartRate.includes('heartRate'), false);
  assert.equal(heartRate.includes('sampleTime'), false);
  assert.equal(heartRate.includes('physicalTime'), false);
  assert.equal(activityLevel.includes('activityLevel'), false);
  assert.equal(activityLevel.includes('startTime'), false);
});

test('daily heart-rate zone filters use snake_case date identifiers', () => {
  const zones = dataPointFilter('daily-heart-rate-zones', '2026-08-01', '2026-09-01');
  const timeInZone = dataPointFilter('time-in-heart-rate-zone', '2026-08-30T00:00:00.000Z', '2026-08-31T00:00:00.000Z');

  assert.equal(
    zones,
    'daily_heart_rate_zones.date >= "2026-08-01" AND daily_heart_rate_zones.date < "2026-09-01"',
  );
  assert.equal(
    timeInZone,
    'time_in_heart_rate_zone.interval.start_time >= "2026-08-30T00:00:00.000Z" AND time_in_heart_rate_zone.interval.start_time < "2026-08-31T00:00:00.000Z"',
  );
  assert.equal(zones.includes('dailyHeartRateZones'), false);
  assert.equal(timeInZone.includes('timeInHeartRateZone'), false);
  assert.equal(timeInZone.includes('startTime'), false);
});

test('heart-rate and activity-level reconcile page size is the API maximum of 10000', () => {
  assert.equal(HEART_RATE_ACTIVITY_LEVEL_PAGE_SIZE, 10_000);
});
