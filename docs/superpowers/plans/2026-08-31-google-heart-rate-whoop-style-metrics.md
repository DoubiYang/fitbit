# Google Heart Rate WHOOP-Style Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Google-heart-rate-backed, transparent daily Strain, Recovery, and Sleep Performance metrics with hourly per-user sync and safe dashboard/coach output.

**Architecture:** Keep the existing `health_snapshots` as the low-frequency record cache for sleep, daily HRV, daily RHR, and exercise, but merge incremental results instead of replacing history. Add normalized persistence only for minute heart-rate aggregates, Google daily zones/time-in-zone, metric results, sleep-goal history, and per-type cursors. The hourly worker streams raw heart-rate data into minute aggregates, then a pure domain layer computes the three versioned metrics for the dashboard read model.

**Tech Stack:** Next.js/TypeScript, PostgreSQL (`pg`), existing Google Health REST OAuth client, Node test runner via `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-08-31-google-heart-rate-whoop-style-metrics-design.md`

---

## Locked implementation rules

- Google `daily-heart-rate-zones` are the only HR-zone thresholds. Never infer max HR from history or write hard-coded bpm thresholds.
- `time-in-heart-rate-zone` is an interval type. Persist daily totals via `dailyRollUp` or summed intervals. It is display/validation data only. Daily Strain is calculated from raw, activity-attributable minute aggregates.
- List/reconcile filters use snake_case (`heart_rate.sample_time.physical_time`, `daily_heart_rate_zones.date`, `time_in_heart_rate_zone.interval.start_time`, `activity_level.interval.start_time`). JSON bodies stay camelCase. Raw HR pages are newest-first and must be sorted ascending before hold-to-next-sample. Daily zones are inclusive `[min, max]` with a 1 bpm gap between adjacent zones; do not require `max = next.min`.
- Raw heart-rate `reconcile` uses `pageSize=10000`. Sleep/exercise stay at 25.
- Minute aggregation keeps a one-sample lookahead across page boundaries and merges coverage intervals for the same UTC minute. Do not add coverage seconds from two pages.
- This Fitbit Air account does not send `heartRate.metadata.motionContext`. Use `activity-level` 60-second intervals for known-context and activity attribution. `SEDENTARY` is rest. `LIGHTLY_ACTIVE` / `MODERATELY_ACTIVE` / `VERY_ACTIVE` are activity only when they do not overlap a sleep session. Exercise overlap can still attribute a minute. Missing `activity-level` is unknown, not rest, and cannot yield `0.0` Strain.
- Past incomplete days with attributed activity minutes may show labeled `provisional` Strain. `0.0` is only for a complete rest day.
- Recomputing Strain for date `D` must recompute Sleep Performance and Recovery for `D+1`.
- Sleep debt walks 7 calendar days and uses the longest non-nap session that day even if under 180 minutes; a day with no non-nap session counts as 0 minutes. It does not zero the whole bonus. Sleep Performance still requires a primary sleep (non-nap, `minutesAsleep >= 180`, longest session).
- A missing sleep goal blocks Sleep Performance only. HRV+RHR Recovery may still score. Never use hardcoded `sleepGoalMinutes: 480`.
- Recovery staleness uses 36 hours and at most drops quality to `provisional`; missing/out-of-range inputs make it `unavailable`. HRV MAD floor is 2 ms; RHR floor stays 3 bpm. Median of an even window is the mean of the two central values. Round only the final integer/one-decimal score, half away from zero.
- Raw heart-rate points must never be inserted into PostgreSQL or sent to the AI context; only minute aggregates may be retained.
- Missing or offset-mismatched IANA time-zone history makes a DST-sensitive day incomplete; use its raw data for display only.
- The first authenticated IANA time-zone write must locally reindex already stored matching historical minutes and recompute their days/results; it must not wait for a raw-API refetch. Later time-zone writes only affect their own history range.
- Metric version for this implementation is `whoop-style-v2`; previously stored `p1-v1` values remain legacy and are not relabeled. Do not name it `strain-v2`.
- Strain completion state (`complete` / `provisional` / `incomplete` / `timezone_ambiguous` / `unavailable`) is not the Recovery quality union (`unavailable` / `provisional` / `medium` / `high`).
- Google Health requests stay restricted to `users/me/dataSourceFamilies/google-wearables` and fail closed on auth/rate-limit errors.
- Replace `src/server/time/civil-date.ts` default `Asia/Shanghai` usage in dashboard date selection with the user's stored IANA history.

## File map

| Path | Responsibility |
| --- | --- |
| `db/migrations/010_whoop_style_metrics.sql` | New normalized metric tables, goal/time-zone history, cursors, indexes, and cascades. |
| `src/domain/cardio-records.ts` | Validated minute, zone, coverage, goal, and metric-result types. |
| `src/domain/whoop-style-metrics.ts` | Pure aggregation, completeness, Strain, Sleep Performance, and Recovery calculations. |
| `src/domain/metric-types.ts` | v2 quality/status vocabulary and dashboard-facing metric types. |
| `src/server/health/health-api.ts` | Page-by-page reconciled data-point iterator; it must not collect raw HR pages. |
| `src/server/health/filters.ts` | Typed Google Health filters for raw HR, daily zones, time in zone, and legacy low-frequency records. |
| `src/server/health/cardio-map.ts` | Google API point parsing into minute spans, zones, time-in-zone, and exercise intervals. |
| `src/server/health/cardio-store.ts` | Store contract and query/read-model helpers for v2 health data. |
| `src/server/health/cardio-sync.ts` | Cursor windows, day-bounded streaming ingest, atomic writes, and metric recomputation. |
| `src/server/health/cardio-reindex.ts` | Local, offset-validated time-zone reindex and metric recomputation without a Google API request. |
| `src/server/health/google-health-provider.ts` | Low-frequency incremental record fetch/merge, replacing the all-or-nothing 14-day snapshot path. |
| `src/server/health/run-sync.ts` | Initial 35-day vs incremental sync orchestration. |
| `src/server/health/scheduled-sync.ts` | One-hour cadence and retry policy. |
| `src/server/db/{memory-store,postgres-store}.ts` and `src/server/auth/types.ts` | Implement/ expose the v2 health-metric and sleep-goal store operations. |
| `src/server/settings/{sleep-goal,time-zone}.ts` and `app/api/settings/{sleep-goal,time-zone}/route.ts` | Authenticated sleep-goal and IANA time-zone history endpoints; time-zone writes reindex matching saved historical days. |
| `src/server/time/civil-date.ts` | Stop using a hardcoded `Asia/Shanghai` default for dashboard “today”; resolve the local date from stored IANA history. |
| `src/server/dashboard/{build-today,today-response}.ts` | Compose the v2 read model and remove training-safety language. |
| `src/ui/dashboard/{today-dashboard,metric-card}.tsx` | Present Strain, Recovery, Sleep Performance, quality, coverage, and sources. |
| `tests/domain/*.test.ts`, `tests/server/*.test.ts`, `tests/ui/*.test.ts` | Unit, persistence, worker, endpoint, and view regressions. |

### Task 0: Verify the real Fitbit Air capability before production mapping

**Files:**
- Create: `scripts/probe-google-heart-rate.ts`
- Test: `tests/server/google-heart-rate-capability.test.ts`
- Modify: `docs/superpowers/specs/2026-08-31-google-heart-rate-whoop-style-metrics-design.md`

- [ ] **Step 1: Write a mocked redaction test for the capability probe.**

  The probe may report only counts, dates, data-type availability, zone labels, and whether `motionContext` is present. Assert it cannot print an access token, BPM value, raw data-point name, full response object, or raw sample timestamp.

- [ ] **Step 2: Implement the one-shot local probe.**

  Resolve the authorized connection through the existing encrypted-token path and query `heart-rate`, `daily-heart-rate-zones`, and `time-in-heart-rate-zone` over a small recent window. It is a developer-only script, not an API route; it must reuse `google-wearables` source restriction and exit nonzero on an API error.

- [ ] **Step 3: Run it against the user's authorized local Fitbit Air account.**

  Reauthorization succeeded on 2026-08-31. Record the observed capability in the spec (already captured in section 9): raw HR without `motionContext`, `activity-level` present, four zones with 1 bpm gaps, time-in-zone as 60-second intervals. Do not invent `motionContext` or shared zone boundaries.

- [ ] **Step 4: Run the probe regression test and commit.**

  Run: `npm test -- tests/server/google-heart-rate-capability.test.ts`

  ```bash
  git add scripts/probe-google-heart-rate.ts tests/server/google-heart-rate-capability.test.ts docs/superpowers/specs/2026-08-31-google-heart-rate-whoop-style-metrics-design.md
  git commit -m "test: probe Google heart rate capabilities"
  ```

### Task 1: Define v2 health records and the pure metric contract

**Files:**
- Create: `src/domain/cardio-records.ts`
- Create: `src/domain/whoop-style-metrics.ts`
- Modify: `src/domain/metric-types.ts`
- Test: `tests/domain/cardio-records.test.ts`
- Test: `tests/domain/whoop-style-metrics.test.ts`

- [ ] **Step 1: Write failing domain tests for threshold validation and minute aggregation.**

  Cover exactly four ordered Google zones with a 1 bpm gap (`max + 1 = next.min`); classify every zone as inclusive `[min, max]`. Test newest-first HR pages sorted ascending, a 75-second sample hold split over minute boundaries, a page-boundary lookahead that neither double-counts nor drops coverage, 30-second minute eligibility, `activity-level` precedence, sleep overlap excluding LIGHTLY_ACTIVE from Strain, missing activity-level becoming `unknown`, and BPM in a 1 bpm gap producing no dose.

- [ ] **Step 2: Run the new test file and verify it fails because the v2 modules do not exist.**

  Run: `npm test -- tests/domain/cardio-records.test.ts`

- [ ] **Step 3: Implement immutable v2 input/output types and validation.**

  Define `HeartRateMinuteAggregate`, `DailyHeartRateZones`, `DailyTimeInZone`, `ExerciseInterval`, `DailyCardio`, `SleepGoal`, `MetricResult`, Recovery quality `unavailable | provisional | medium | high`, and a separate Strain status `complete | provisional | incomplete | timezone_ambiguous | unavailable`. Preserve legacy `MetricQuality` (`low` / `calibrating` included) until no legacy dashboard code imports it. Do not reuse `TrainingBalanceResult` as Strain.

- [ ] **Step 4: Write failing deterministic calculation tests.**

  Assert:

  ```ts
  const dose = 0.5 * light + moderate + 2 * vigorous + 3 * peak;
  const strain = Math.round(Math.min(21, 21 * (1 - Math.exp(-dose / 140))) * 10) / 10;
  ```

  Test unknown context cannot make a day complete or yield zero; a fully known sedentary day yields `0.0`; a past incomplete day with attributed activity yields labeled provisional Strain, not `0.0`. Test sleep target selection, 7 calendar-day debt that counts a missing non-nap day as 0 minutes and still includes a 179-minute non-nap night in the sum, `T + 1` behavior, Sleep Performance without a hardcoded 480-minute goal, 7/28-day HRV/RHR MAD scoring with a 2 ms HRV floor and even-n median, HRV+RHR Recovery without Sleep, Strain(D) recomputation cascading to Sleep/Recovery(D+1), and Recovery quality outcomes including 36-hour stale sync remaining provisional rather than unavailable.

- [ ] **Step 5: Implement the pure functions until the tests pass.**

  Keep date conversion and database I/O out of this module. Every result must carry `metricVersion: 'whoop-style-v2'`, evidence, source/coverage state, and an explicit unavailable reason.

- [ ] **Step 6: Run the domain suite and type-check.**

  Run: `npm test -- tests/domain/cardio-records.test.ts tests/domain/whoop-style-metrics.test.ts tests/domain/metrics.test.ts && npm run lint`

- [ ] **Step 7: Commit the isolated domain change.**

  ```bash
  git add src/domain/cardio-records.ts src/domain/whoop-style-metrics.ts src/domain/metric-types.ts tests/domain/cardio-records.test.ts tests/domain/whoop-style-metrics.test.ts
  git commit -m "feat: add transparent cardio metric calculations"
  ```

### Task 2: Add durable metric storage plus sleep-goal and time-zone history

**Files:**
- Create: `db/migrations/010_whoop_style_metrics.sql`
- Create: `src/server/health/cardio-store.ts`
- Modify: `src/server/auth/types.ts`
- Modify: `src/server/db/memory-store.ts`
- Modify: `src/server/db/postgres-store.ts`
- Modify: `src/server/auth/oauth-service.ts`
- Test: `tests/server/cardio-store.test.ts`
- Test: `tests/server/postgres-cardio-store.test.ts`
- Test: `tests/server/oauth-service.test.ts`

- [ ] **Step 1: Write failing store-contract tests.**

  Cover user isolation, minute upsert by `(user, source family, UTC minute)`, zone replacement by local date, cursor update in the same transaction as a metric write, historical goal/time-zone lookup, and cascade deletion. Assert that stores accept minute aggregates but have no operation for raw sample persistence.

- [ ] **Step 2: Add migration 010.**

  Create the nine tables named in the spec, including `exercise_intervals`, `user_sleep_goal_history`, and `user_health_time_zone_history`. `heart_rate_minute_aggregates` must retain its API-derived `civil_date`, `utc_offset`, and nullable `iana_time_zone`, so reindexing can update only verified minutes. Use `users(id) ON DELETE CASCADE`, a connection foreign key with cascade for cursors, JSONB only for threshold/result/evidence payloads, and indexes on `(user_id, civil_date DESC)` and due cursor lookup. `health_sync_cursors` must include `successful_watermark`, `last_error_code`, `retry_count`, and `next_attempt_at`. Add `CHECK (goal_minutes BETWEEN 300 AND 900)`, a unique `(user_id, effective_civil_date)` key, and a time-zone-history unique `(user_id, effective_at)` key plus an `is_backfill_anchor` flag for the first IANA record.

- [ ] **Step 3: Extend the typed store contract and in-memory implementation.**

  Add a separate `healthMetrics` namespace to `AuthStore` with methods for transactional ingestion, cursor reads/update/schedule, exercise-interval upsert/query, read-model queries, metric-result upserts, sleep-goal lookup/insert, time-zone-history lookup/insert, a range query/update for local time-zone reindexing, and `deleteForUser`. Mirror exactly in `createMemoryStore` so domain/server tests need no database.

- [ ] **Step 4: Implement PostgreSQL mappings and transaction behavior.**

  Use `store.withTransaction` to write a window's aggregates, replace affected daily summaries, recompute/upsert metric results, and advance only that data-type cursor. Update the disconnect path in `oauth-service.ts` to call `healthMetrics.deleteForUser` in the same transaction as `healthSnapshots.deleteForUser` and credential clearing; do not rely on an account-delete cascade. Add a regression proving disconnect deletes minute aggregates, all daily rows, exercise intervals, cursors, results, sleep goals, and time-zone history.

- [ ] **Step 5: Verify tests and migration.**

  Run: `npm test -- tests/server/cardio-store.test.ts tests/server/postgres-cardio-store.test.ts && npm run lint`

- [ ] **Step 6: Commit the persistence layer.**

  ```bash
  git add db/migrations/010_whoop_style_metrics.sql src/server/auth/types.ts src/server/auth/oauth-service.ts src/server/db/memory-store.ts src/server/db/postgres-store.ts src/server/health/cardio-store.ts tests/server/cardio-store.test.ts tests/server/postgres-cardio-store.test.ts tests/server/oauth-service.test.ts
  git commit -m "feat: persist cardio metrics and sleep goals"
  ```

### Task 3: Stream and map Google heart-rate data safely

**Files:**
- Create: `src/server/health/cardio-map.ts`
- Modify: `src/server/health/health-api.ts`
- Modify: `src/server/health/filters.ts`
- Modify: `src/server/health/map-records.ts`
- Test: `tests/server/health-api.test.ts`
- Test: `tests/server/health-filters.test.ts`
- Test: `tests/server/cardio-map.test.ts`

- [ ] **Step 1: Write failing API-client tests for page streaming.**

  Require a new `iterateReconciledDataPoints()` async iterator/callback that sends `dataSourceFamily=google-wearables`, preserves page tokens, and exposes one page at a time. Retain the existing array-returning method only for low-volume types; raw `heart-rate` must use the iterator.

- [ ] **Step 2: Add typed filters and API point shapes.**

  Add Google filter cases for `heart-rate`, `daily-heart-rate-zones`, and `time-in-heart-rate-zone`, using snake_case identifiers consistent with `daily_heart_rate_variability.date`. Extend `GoogleDataPoint` to parse `heartRate.sampleTime.physicalTime`, required `utcOffset`, output civil time, optional `heartRate.metadata.motionContext`, daily zone entries, and time-in-zone intervals. Heart-rate reconcile `pageSize` is 10000.

- [ ] **Step 3: Write failing mapping tests from realistic Google fixtures.**

  Cover offset/civil-date preservation, timezone change, unknown context, an exercise interval overlapping unknown-context HR, zone-boundary classification, and interval splitting. Include the exact Google JSON string-number forms for bpm and zone limits.

- [ ] **Step 4: Implement mappers.**

  Convert raw-HR pages to minute-span candidates without persisting the original point. Map `exercise` pages separately to `ExerciseInterval` rows. Return daily zones and display-only time-in-zone summaries separately; reject malformed timestamps/offsets rather than guessing a timezone.

- [ ] **Step 5: Run targeted tests and commit.**

  Run: `npm test -- tests/server/health-api.test.ts tests/server/health-filters.test.ts tests/server/cardio-map.test.ts`

  ```bash
  git add src/server/health/health-api.ts src/server/health/filters.ts src/server/health/map-records.ts src/server/health/cardio-map.ts tests/server/health-api.test.ts tests/server/health-filters.test.ts tests/server/cardio-map.test.ts
  git commit -m "feat: stream and map Google heart rate data"
  ```

### Task 4: Replace snapshot-only sync with hourly cursor-based ingestion

**Files:**
- Create: `src/server/health/cardio-sync.ts`
- Modify: `src/server/health/google-health-provider.ts`
- Modify: `src/server/health/run-sync.ts`
- Modify: `src/server/health/scheduled-sync.ts`
- Modify: `src/server/health/snapshot-store.ts`
- Test: `tests/server/cardio-sync.test.ts`
- Test: `tests/server/run-sync.test.ts`
- Test: `tests/server/scheduled-sync.test.ts`
- Test: `tests/server/health-provider.test.ts`

- [ ] **Step 1: Write failing sync tests for initial and incremental windows.**

  Assert initial raw HR uses `now − 37 × 24h` through `now`, and initial daily requests use the documented 36-days-before to 1-day-after UTC date window rather than `Asia/Shanghai`; after that, raw HR/`activity-level`/exercise use cursor minus two hours, and sleep/HRV/RHR/daily-zone/time-in-zone use 48 hours. Include timezone/DST and 35-local-day boundary fixtures, page-by-page raw ingestion with lookahead, duplicate overlap idempotence, a **second raw page failure** that leaves its successful watermark unchanged, Strain(D) cascading to Sleep/Recovery(D+1), and retry output with no missing/duplicate minutes, dose, or metric result. For one data-type 429 plus another successful type, assert the former writes its own retry count/error/next attempt while the latter advances; the connection becomes due at the former's earliest retry. Assert no raw point is retained after the page callback returns.

- [ ] **Step 2: Implement `cardio-sync.ts`.**

  Process raw HR by local-date segments and pages. Extract a reusable `recomputeAffectedDays()` operation that reads only persisted inputs, so the later local time-zone reindex can invoke the exact same `daily_cardio`/`whoop-style-v2` calculation. A page may idempotently flush aggregates, but its type's `successful_watermark` is advanced only after **all** pages in the requested window succeed and all affected dates have been recomputed; a late-page failure preserves the old watermark and relies on the overlap retry. For each affected day, persist aggregates/zones/time-in-zone, read persisted `exercise_intervals` plus current sleep/HRV/RHR inputs, recompute `whoop-style-v2` results, then commit the final watermark in one transaction. Exercise ingestion must upsert intervals and enqueue/recompute every date it overlaps; test both HR-before-exercise and exercise-before-HR order and require identical results. On a per-type failure, write only that cursor's retry/error state; compute connection `nextSyncAt` as the earliest cursor `next_attempt_at`.

- [ ] **Step 3: Make low-frequency snapshots incremental and merge-preserving.**

  Replace destructive snapshot overwrite with a deterministic merge keyed by source record ID/date. Retain at least the most recent 35 civil days for sleep, HRV, RHR, and exercise so a 48-hour refresh does not erase Recovery history. Preserve existing snapshot readers until the dashboard moves fully to the v2 read model.

- [ ] **Step 4: Update orchestration and scheduler.**

  Set initial `rangeDays` to 35 and normal cadence to `60 * 60 * 1000`; model 30/60/120-minute per-type retry delays, then one hour. Ensure the internal sync endpoint can be called more frequently than hourly while `nextSyncAt` (the earliest type cursor due time) prevents premature per-user work.

- [ ] **Step 5: Run worker regression tests and commit.**

  Run: `npm test -- tests/server/cardio-sync.test.ts tests/server/run-sync.test.ts tests/server/scheduled-sync.test.ts tests/server/health-provider.test.ts`

  ```bash
  git add src/server/health/cardio-sync.ts src/server/health/google-health-provider.ts src/server/health/run-sync.ts src/server/health/scheduled-sync.ts src/server/health/snapshot-store.ts tests/server/cardio-sync.test.ts tests/server/run-sync.test.ts tests/server/scheduled-sync.test.ts tests/server/health-provider.test.ts
  git commit -m "feat: sync per-user cardio metrics hourly"
  ```

### Task 5: Add sleep-goal settings and server-side metric read model

**Files:**
- Create: `src/server/settings/sleep-goal.ts`
- Create: `src/server/settings/time-zone.ts`
- Create: `src/server/health/cardio-reindex.ts`
- Modify: `src/server/health/cardio-store.ts`
- Modify: `src/server/health/cardio-sync.ts`
- Create: `app/api/settings/sleep-goal/route.ts`
- Create: `app/api/settings/time-zone/route.ts`
- Modify: `src/server/time/civil-date.ts`
- Modify: `src/server/dashboard/build-today.ts`
- Modify: `src/server/dashboard/today-response.ts`
- Modify: `app/api/today/route.ts`
- Test: `tests/server/sleep-goal.test.ts`
- Test: `tests/server/today-response.test.ts`
- Test: `tests/server/build-today.test.ts`

- [ ] **Step 1: Write failing endpoint tests.**

  Assert unauthenticated requests get 401; GET never returns another user's goal/time-zone history; time-zone PUT accepts only a valid IANA zone and writes an effective instant; its first write has the earliest saved-minute instant and `is_backfill_anchor=true`, while later writes use the received instant; sleep-goal PUT rejects non-integers and values outside 300–900; a successful PUT dated local day `T` writes only `T+1`; repeated requests for the same effective date use a defined conflict response rather than silently changing history. Seed a 35-day sync without IANA data, then assert that a first matching IANA write makes eligible historical days complete without another Health API call, while a stored offset mismatch remains `timezone_ambiguous`.

- [ ] **Step 2: Implement the small settings service and route.**

  Implement the time-zone service first: browser-provided IANA zone is validated and appended to history. If history is empty, set `effective_at` to the earliest saved minute (or received instant when no minute exists) and mark it `is_backfill_anchor`; later writes use the received instant. In the **same database transaction**, call `cardio-reindex.ts` to locally reindex saved minute aggregates: the anchor covers existing stored history, while later entries only affect `[effective_at, next_effective_at)`. For every candidate minute, derive the IANA offset at its UTC instant and accept it only when it equals the stored API offset; update the matched minute's local date/IANA association, then invoke Task 4's `recomputeAffectedDays()` to rebuild `daily_cardio` and `whoop-style-v2` results. Do not fetch raw Health data and never force an offset-mismatched minute into the IANA zone. Resolve sleep-goal local `T` from the matching historical IANA zone; if none exists, reject the goal request until the client writes one. Return settings/effective dates, never medical recommendations.

- [ ] **Step 3: Replace dashboard's legacy metric construction.**

  Read v2 Strain/Recovery/Sleep Performance through `healthMetrics`, use the goal history service, and expose `strain`, `recovery`, `sleepPerformance`, coverage/source/status/evidence in `TodayView`. Remove fixed `sleepGoalMinutes: 480`, old training-balance card as the primary WHOOP metric, and all primary actions that say a user may train as planned.

- [ ] **Step 4: Implement neutral safety wording tests.**

  Assert `high` Recovery produces a factual trend explanation, not permission to train; `provisional`/`unavailable` produce a data-quality explanation; all evidence belongs to the user/date range.

- [ ] **Step 5: Run server tests and commit.**

  Run: `npm test -- tests/server/sleep-goal.test.ts tests/server/today-response.test.ts tests/server/build-today.test.ts`

  ```bash
  git add src/server/settings/sleep-goal.ts src/server/settings/time-zone.ts src/server/health/cardio-reindex.ts src/server/health/cardio-store.ts src/server/health/cardio-sync.ts src/server/time/civil-date.ts app/api/settings/sleep-goal/route.ts app/api/settings/time-zone/route.ts src/server/dashboard/build-today.ts src/server/dashboard/today-response.ts app/api/today/route.ts tests/server/sleep-goal.test.ts tests/server/today-response.test.ts tests/server/build-today.test.ts
  git commit -m "feat: expose sleep goals and WHOOP-style metrics"
  ```

### Task 6: Present the new metrics and sleep-goal control in the mobile dashboard

**Files:**
- Create: `app/settings/page.tsx`
- Create: `src/ui/settings/sleep-goal-settings.tsx`
- Create: `src/ui/settings/time-zone-bootstrap.tsx`
- Modify: `src/ui/dashboard/metric-card.tsx`
- Modify: `src/ui/dashboard/today-dashboard.tsx`
- Modify: `app/page.tsx`
- Test: `tests/ui/today-dashboard.test.ts`
- Test: `tests/ui/sleep-goal-settings.test.ts`

- [ ] **Step 1: Write failing view tests.**

  Cover 0.0 vs unavailable Strain, provisional labels, coverage/source disclosure, `timezone_ambiguous` state, Sleep Performance dynamic-target explanation, missing-goal/time-zone CTA, and no “can train” language. Assert first authenticated dashboard load submits the browser IANA zone (not only Settings), and that the refreshed read model can show reindexed historical results. Verify mobile controls meet existing green Sage design conventions.

- [ ] **Step 2: Implement dashboard cards and the settings page.**

  Create an idempotent `time-zone-bootstrap` client component and mount it on the first authenticated dashboard/app load, as well as preserving the Settings flow. It submits `Intl.DateTimeFormat().resolvedOptions().timeZone` before a sleep-goal save is enabled; if OAuth's initial sync already ran, the server-side write reindexes the stored history immediately. Keep the established visual system. Show Strain as “全天心肺负荷”, display Google zone thresholds and separate all-day zone time from activity-attributed dose, and let the user set a sleep goal through the authenticated endpoint. Do not render raw minute heart-rate samples or tokens.

- [ ] **Step 3: Run UI tests and full static checks.**

  Run: `npm test -- tests/ui/today-dashboard.test.ts tests/ui/sleep-goal-settings.test.ts && npm run lint && npm run build`

- [ ] **Step 4: Commit UI work.**

  ```bash
  git add app/settings/page.tsx src/ui/settings/sleep-goal-settings.tsx src/ui/settings/time-zone-bootstrap.tsx src/ui/dashboard/metric-card.tsx src/ui/dashboard/today-dashboard.tsx app/page.tsx tests/ui/today-dashboard.test.ts tests/ui/sleep-goal-settings.test.ts
  git commit -m "feat: show cardio metrics and sleep goal settings"
  ```

### Task 7: Verify real Fitbit Air responses, migration, and end-to-end behavior

**Files:**
- Modify: `docs/superpowers/specs/2026-08-31-google-heart-rate-whoop-style-metrics-design.md`
- Modify: `README.md`
- Test: `tests/server/cardio-sync.test.ts`

- [ ] **Step 1: Add a redacted live-API smoke path.**

  The smoke test/command must use the authorized local connection, log only counts/dates/available field names (never access tokens, heart-rate samples, or Health API bodies), and separately report availability of raw HR, `motionContext`, all four daily zones, and time-in-zone.

- [ ] **Step 2: Run migration and one forced local sync against the real account.**

  Confirm the migration applies, the initial backfill covers 35 local days with the UTC wide-window strategy, data is upserted, no raw HR *sample* is persisted, and unavailable fields lead to explicit unavailable/provisional UI rather than a low score.

- [ ] **Step 3: Document observed Fitbit Air capability without recording private values.**

  Mark the verification item complete only when the documented API assumptions are confirmed or the applicable fallback is exercised.

- [ ] **Step 4: Run the complete verification suite.**

  Run: `npm test && npm run lint && npm run build`

- [ ] **Step 5: Commit verification/documentation.**

  ```bash
  git add docs/superpowers/specs/2026-08-31-google-heart-rate-whoop-style-metrics-design.md README.md tests/server/cardio-sync.test.ts
  git commit -m "test: verify Fitbit Air cardio metric sync"
  ```
