ALTER TABLE daily_load_capacities
  DROP CONSTRAINT IF EXISTS daily_load_capacities_utilization_check;

ALTER TABLE daily_load_capacities
  ADD CONSTRAINT daily_load_capacities_utilization_check
  CHECK (utilization IS NULL OR utilization >= 0);
