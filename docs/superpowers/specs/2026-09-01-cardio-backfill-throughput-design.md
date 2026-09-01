# Cardio First-Backfill Throughput Design

## Goal

Make the first 35-day Google Health cardio backfill complete reliably within the scheduled-sync lease, without changing metric semantics, persisting raw heart-rate samples, or turning partial data into a completed score.

## Observed failure

On the authorized Fitbit Air account, the first backfill wrote heart-rate-minute and activity-level aggregates, then did not reach cardio results before the worker's four-minute HTTP deadline. The connection lease remained held and no metric result was written, which is safe for presentation but delays completion.

The concrete cause is `time-in-heart-rate-zone`: Fitbit Air emits 60-second intervals, but the client classified it as low volume and requested the API default of 25 records per page. A 35-day backfill therefore needs thousands of serial API pages. The existing Postgres implementation also turns many minute and activity interval rows into individual database round trips.

## Selected design

### 1. Treat time-in-heart-rate-zone as a high-volume stream

`time-in-heart-rate-zone` joins `heart-rate` and `activity-level` in the health API's high-volume classification. Its reconciled iterator defaults to 10,000 points per page, and its cardio ingestion explicitly requests the same page size. It remains streaming: pages are consumed in order and raw Google points are never written to storage or returned by the sync state.

### 2. Bound Postgres work per page

The public `HealthMetricsStore` interface and the in-memory test store stay unchanged.

For Postgres only:

- minute aggregate upserts validate all rows, read matching stored rows in one set operation, then use each stored row (when present) as the accumulator and apply duplicate `(userId, sourceFamily, minuteStartUtc)` inputs strictly in arrival order using the existing merge rule before issuing one set-based upsert per page;
- activity-level interval upserts validate all rows and issue one set-based upsert per page;
- activity ingestion marks conservative affected civil dates from each interval's UTC start/end envelope. It no longer queries stored minutes once per interval merely to find dates already covered by that envelope.

The envelope includes the UTC day before the start and the day after the end, so it covers every possible local date for offsets from UTC-14 through UTC+14. Recompute remains the single place that assigns an activity level to stored minutes.

Both Postgres operations use a single JSON parameter decoded through `jsonb_to_recordset` in an input CTE, rather than a parameterized `VALUES` list. This keeps a 10,000-row page below the PostgreSQL extended-protocol parameter limit. The matching-existing read and the final upsert are each one set operation; the JSON payload is not logged.

### 3. Fence each scheduled run with lease ownership

Claiming a scheduled sync generates an opaque lease token as well as an expiry. The token travels through snapshot persistence, cardio ingestion, recompute, cursor updates, and scheduled completion. Every write is fenced in the database by the connection id, user id, token, and an unexpired lease; a stale run therefore cannot write pages, results, cursors, or completion state after a newer run has claimed the connection.

The server creates its own abort deadline with at least one minute of cleanup headroom before the 15-minute lease expires. It propagates that signal into Google fetches and checks it between streamed pages and before writes. The worker HTTP timeout is longer than the server deadline. An aborted run uses the existing failure schedule and clears its matching lease token; it never advances success watermarks. Lease expiry alone is not treated as proof that the prior server request stopped.

## Data and failure guarantees

- A canceled, failed, stale-token, or unsyncable run never advances a cardio cursor or produces a completed score.
- Existing heart-rate minute merge behavior, per-type cursors, overlap windows, source isolation, and time-zone/DST safeguards do not change.
- A future run may claim only after the prior token has been released or expired, and every pending write from the old token is then rejected by its database fence.
- The dashboard continues to show unavailable/provisional state until stored metric results are committed.

## Tests and live validation

Add failing tests before implementation for:

1. high-volume default and explicit page size for `time-in-heart-rate-zone`;
2. one activity-level page uses a bounded number of store range reads while preserving all potentially affected local dates;
3. Postgres page-sized minute/activity writes use a JSON CTE and issue set-based operations instead of per-row read/write pairs, including a 10,000-row page without parameter overflow and repeated-minute offset changes that preserve the existing sequential merge semantics;
4. an old run that is aborted or whose lease token is superseded cannot write a page, cursor, result, or completion state after a new run claims the connection;
5. the server deadline provides cleanup headroom below the lease and the worker deadline is longer than the server deadline.

Then run focused tests, the full suite, lint, and production build. Rebuild the local Docker services, wait for the abandoned pre-fix lease to become claimable (or safely expire it using the existing state transition), and validate only anonymous row counts, cursor state, result count, and freshness/quality labels from the authorized account.

## Local validation outcome — 2026-09-01

- Migration `011_sync_lease_fencing.sql` applied successfully while retaining the existing PostgreSQL volume.
- The rebuilt application and both sync workers became healthy; the food import completed successfully.
- The authorized local account has a completed sync and a future hourly schedule, with no active lease or retained lease token.
- All eight sync cursors have success watermarks and no recorded error. The local database contains minute and activity aggregates, daily cardio rows, and metric results; no raw heart-rate samples were inspected or logged.
- A manually authenticated internal-sync request returned `claimed: 0`, confirming that the account was not stuck in a stale lease and was already scheduled for its next run.
- Some metric results remain deliberately withheld while the required history or coverage matures; only eligible results receive a score.
