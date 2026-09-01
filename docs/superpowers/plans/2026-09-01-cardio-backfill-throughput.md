# Cardio First-Backfill Throughput Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the initial 35-day Fitbit Air cardio backfill finish safely and efficiently, with no stale run able to write after its scheduled-sync lease is superseded.

**Architecture:** Add an opaque scheduled-sync lease token and a server-owned deadline, carrying both through every Google read and scheduled persistence path. Make the 60-second time-in-heart-rate-zone feed high-volume, and replace Postgres's per-row page writes with JSON-CTE set operations that preserve the existing sequential minute-merge semantics.

**Tech Stack:** Next.js/TypeScript, PostgreSQL 16, node:test/tsx, Docker Compose, Google Health API.

---

### Task 1: Fence a scheduled sync run and bound its lifetime

**Files:**
- Create: `db/migrations/011_sync_lease_fencing.sql`
- Modify: `src/server/auth/types.ts:ConnectionRow and scheduled-sync contracts`
- Modify: `src/server/db/memory-store.ts:connections scheduled-sync implementation`
- Modify: `src/server/db/postgres-store.ts:connection mapping, claim, finish, expire, clear, and lease assertion`
- Modify: `src/server/health/scheduled-sync.ts:claim token, server deadline, and finalization`
- Modify: `src/server/health/run-sync.ts:pass the bound run context`
- Modify: `src/server/health/google-health-provider.ts:propagate signal and fence snapshot persistence/success stamps`
- Modify: `src/server/health/cardio-sync.ts:check abort/fenced lease before page writes, recompute, cursor changes`
- Modify: `src/server/health/health-api.ts:forward AbortSignal to every Google page fetch`
- Modify: `src/server/health/snapshot-store.ts:token-fenced snapshot save`
- Modify: `src/server/health/access-token.ts:token-fenced refresh-envelope update`
- Modify: `src/server/health/cardio-store.ts:lease-bound write contract/helper types`
- Modify: `worker/sync-loop.mjs:deadline longer than server cleanup deadline`
- Test: `tests/server/scheduled-sync.test.ts`
- Test: `tests/server/sync-schedule-store.test.ts`
- Test: `tests/server/run-sync.test.ts`
- Test: `tests/server/health-provider.test.ts`
- Test: `tests/server/postgres-scheduled-sync-fencing.test.ts`
- Test: `tests/server/access-token.test.ts`
- Test: `tests/worker/sync-loop.test.ts`

- [ ] **Step 1: Write the failing lease-fencing tests**

Cover a claim receiving a nonempty token, a finish/expire/clear call with the wrong token being rejected, and a stale first run being unable to write page aggregates, snapshot, refreshed token envelope, success watermark, cursor, metric result, completion, or failure state after a second run has claimed the same connection. Add dedicated Postgres-query mock coverage for snapshot persistence and refreshed token-envelope updates: each successful write must include `connectionId`, `userId`, the old run token, an unexpired lease, and an unexpired server deadline in its single atomic SQL statement, and an old token or elapsed deadline must produce `rowCount = 0`. Use an abortable fake iterator and fake clock to prove that the server deadline stops later Google-page fetches and writes, advances no watermark, and schedules/releases only its own token.

- [ ] **Step 2: Run the focused scheduled-sync tests to verify RED**

Run: `npm test -- tests/server/scheduled-sync.test.ts tests/server/sync-schedule-store.test.ts tests/server/postgres-scheduled-sync-fencing.test.ts tests/server/access-token.test.ts`

Expected: FAIL because no token is stored or matched.

- [ ] **Step 3: Add the migration and store contracts**

Add nullable `sync_lease_token UUID` to `google_health_connections`. Generate a UUID per `claimDueSyncs` call, return it on `ConnectionRow`, and require the exact token as well as the existing id/user/lease expiration in all scheduled finishing and lease-clearing operations. Carry the 13-minute `deadlineAt` in the scheduled run. Add a short transaction-scoped lease assertion usable by scheduled metric writes; each successful PostgreSQL write must hold the matching unexpired token and DB-time-unexpired server deadline while it runs. Add the same predicate atomically to snapshot persistence, refresh-token-envelope updates, success watermarks, cursor/result writes, and successful completion, rather than asserting only before or after those independent SQL writes. Failure/retry and lease-release operations remain token-fenced but must still work after `deadlineAt`.

- [ ] **Step 4: Propagate the run context and server deadline**

Create a run context containing `connectionId`, `userId`, `leaseToken`, `leaseUntil`, `deadlineAt`, and an abort signal that fires with at least one minute before the 15-minute lease expires (including when its parent signal was already aborted). Pass it from `runDueSyncs` through token refresh, `syncUserConnection`, snapshot persistence, the provider, and cardio ingestion. Every Google page fetch receives the signal; every loop and awaited write boundary checks it, including after snapshot persistence, during and after metric recompute, and immediately before completion. Every scheduled aggregate/snapshot/token-envelope/watermark/cursor/result/successful-completion write uses the lease assertion or a token-fenced SQL CTE with the DB-time deadline predicate. Abort schedules the existing per-user retry and only clears the matching token.

- [ ] **Step 5: Align the worker deadline and run GREEN tests**

Set the worker HTTP deadline longer than the server-owned deadline, while still finite. Run: `npm test -- tests/server/scheduled-sync.test.ts tests/server/sync-schedule-store.test.ts tests/server/run-sync.test.ts tests/server/health-provider.test.ts tests/server/postgres-scheduled-sync-fencing.test.ts tests/server/access-token.test.ts tests/worker/sync-loop.test.ts`

Expected: PASS; no stale run can persist after takeover and no cursor advances on abort.

- [ ] **Step 6: Commit Task 1**

```bash
git add db/migrations/011_sync_lease_fencing.sql src/server/auth/types.ts src/server/db/memory-store.ts src/server/db/postgres-store.ts src/server/health/scheduled-sync.ts src/server/health/run-sync.ts src/server/health/google-health-provider.ts src/server/health/cardio-sync.ts src/server/health/health-api.ts src/server/health/cardio-store.ts src/server/health/snapshot-store.ts src/server/health/access-token.ts worker/sync-loop.mjs tests/server/scheduled-sync.test.ts tests/server/sync-schedule-store.test.ts tests/server/run-sync.test.ts tests/server/health-provider.test.ts tests/server/postgres-scheduled-sync-fencing.test.ts tests/server/access-token.test.ts tests/worker/sync-loop.test.ts
git commit -m "fix: fence scheduled health sync runs"
```

### Task 2: Stream every Fitbit Air minute feed at a high-volume page size

**Files:**
- Modify: `src/server/health/filters.ts:high-volume page-size name`
- Modify: `src/server/health/health-api.ts:isHighVolumeDataType and default iterator size`
- Modify: `src/server/health/cardio-sync.ts:ingestTimeInZone request`
- Modify: `tests/server/health-api.test.ts`
- Modify: `tests/server/cardio-sync.test.ts`
- Modify: `tests/server/google-heart-rate-capability.test.ts`

- [ ] **Step 1: Write a failing high-volume time-in-zone test**

Assert that `time-in-heart-rate-zone` defaults to a 10,000-record reconciled page, accepts an explicit override, and that cardio ingestion passes that size. Keep the existing assertion that low-volume `listDataPoints` is not used for high-volume sources.

- [ ] **Step 2: Run the focused paging tests to verify RED**

Run: `npm test -- tests/server/health-api.test.ts tests/server/cardio-sync.test.ts tests/server/google-heart-rate-capability.test.ts`

Expected: FAIL because time-in-zone currently uses the 25-record default.

- [ ] **Step 3: Add time-in-zone to the high-volume classification**

Use one shared `HEALTH_HIGH_VOLUME_PAGE_SIZE = 10_000` constant for heart rate, activity level, and time in zone. Preserve reconcile, `google-wearables`, streaming iteration, and no raw-point persistence.

- [ ] **Step 4: Run the focused paging tests to verify GREEN**

Run the Step 2 command.

Expected: PASS; a Fitbit Air 60-second zone feed cannot silently fall back to 25-record pages.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/server/health/filters.ts src/server/health/health-api.ts src/server/health/cardio-sync.ts tests/server/health-api.test.ts tests/server/cardio-sync.test.ts tests/server/google-heart-rate-capability.test.ts
git commit -m "fix: stream high-volume time in zone pages"
```

### Task 3: Make Postgres page writes set-based without changing metric semantics

**Files:**
- Modify: `src/server/db/postgres-store.ts:upsertMinutes and upsertActivityLevelIntervals`
- Modify: `src/server/health/cardio-sync.ts:activity-level affected-date collection`
- Test: `tests/server/postgres-cardio-store.test.ts`
- Test: `tests/server/cardio-sync.test.ts`
- Test: `tests/domain/cardio-records.test.ts`

- [ ] **Step 1: Write failing batch-persistence tests**

Add a 10,000-row minute page test that expects exactly one matching-existing read plus exactly one batch upsert, each with a single JSON parameter decoded via `jsonb_to_recordset`, and no parameter-expanded `VALUES` list. Include one repeated key whose offset changes `0 → +60 → 0`: when the stored row has `IANA=UTC`, the final result must match repeated calls to `mergeHeartRateMinuteUpsert` and must not restore `UTC`. Add an activity page test that expects exactly one JSON-CTE batch upsert and no per-interval `listMinutesInRange` call while its conservative four-date envelope still reaches recompute.

- [ ] **Step 2: Run focused batch tests to verify RED**

Run: `npm test -- tests/server/postgres-cardio-store.test.ts tests/server/cardio-sync.test.ts tests/domain/cardio-records.test.ts`

Expected: FAIL because current Postgres code performs a read/write per minute and an activity-range read per interval.

- [ ] **Step 3: Implement the minute JSON-CTE pipeline**

Parse the page first. Use one `jsonb_to_recordset($1::jsonb)` CTE to fetch matching minute rows. For each composite key, start from the stored row if present and apply duplicate incoming rows in original arrival order through `mergeHeartRateMinuteUpsert`. Send the resulting unique rows through one JSON-CTE `INSERT … ON CONFLICT` statement. Do not log the JSON payload.

- [ ] **Step 4: Implement set-based activity intervals and conservative dates**

Use one JSON-CTE upsert for a page of activity intervals. Delete the per-interval stored-minute lookup in `ingestActivityLevel`; add `civilDatesForInterval(start, end)` for each interval to the affected set. Do not change activity assignment: it remains in `recomputeAffectedDays`.

- [ ] **Step 5: Run focused batch tests to verify GREEN**

Run the Step 2 command.

Expected: PASS; duplicate minute association semantics, input-size safety, and affected-day coverage match the former behavior.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/server/db/postgres-store.ts src/server/health/cardio-sync.ts tests/server/postgres-cardio-store.test.ts tests/server/cardio-sync.test.ts tests/domain/cardio-records.test.ts
git commit -m "perf: batch cardio backfill persistence"
```

### Task 4: Verify the full product path and resume the authorized local backfill

**Files:**
- Modify: `docs/superpowers/specs/2026-09-01-cardio-backfill-throughput-design.md:live-validation note`
- Test: full repository suite

- [ ] **Step 1: Run final static and behavioral verification**

Run: `npm test`, `npm run lint`, `npm run build`, and `git diff --check main...HEAD`.

Expected: all tests pass; no TypeScript errors; production build succeeds; no whitespace defects.

- [ ] **Step 2: Review the migration and Compose startup path**

Confirm migration `011` is copied into the production image and automatic startup migration remains idempotent. Confirm the 13-minute server deadline is below the 15-minute lease and worker timeout is longer than 13 minutes.

- [ ] **Step 3: Merge and rebuild local services**

Merge only after the prior tasks' two-stage reviews pass. Rebuild `main` with `docker compose up --build -d`; do not reset or delete the existing Postgres volume.

- [ ] **Step 4: Resume safely and validate anonymous state**

Let the stale pre-fix lease expire or clear it through the token-aware failure transition; do not overwrite it directly. Trigger the existing internal sync endpoint once. Verify only connection lease state, per-type cursor success/next attempt state, aggregate row counts, metric-result count, and dashboard freshness/quality labels. Do not print credentials, raw BPM, data-point names, or timestamps.

- [ ] **Step 5: Record the validation result and commit**

Append an anonymized outcome to the design document, commit it with `git commit -m "docs: record cardio backfill validation"`, and report the final evidence.
