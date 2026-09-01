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

- minute aggregate upserts validate all rows, read matching existing rows in one set operation, retain the established merge rule in TypeScript, then issue one set-based upsert per page;
- activity-level interval upserts validate all rows and issue one set-based upsert per page;
- activity ingestion marks conservative affected civil dates from each interval's UTC start/end envelope. It no longer queries stored minutes once per interval merely to find dates already covered by that envelope.

The envelope includes the UTC day before the start and the day after the end, so it covers every possible local date for offsets from UTC-14 through UTC+14. Recompute remains the single place that assigns an activity level to stored minutes.

### 3. Align worker request lifetime with the sync lease

The worker request deadline becomes shorter than, but close to, the 15-minute connection lease. This avoids a false four-minute failure while a bounded first backfill is still working. A genuinely stalled request will release or naturally expire its lease and follow the existing retry schedule; success watermarks are still written only after the full cardio transaction completes.

## Data and failure guarantees

- A canceled, failed, or unsyncable run never advances a cardio cursor or produces a completed score.
- Existing heart-rate minute merge behavior, per-type cursors, overlap windows, source isolation, and time-zone/DST safeguards do not change.
- If a worker request outlives its deadline, a future run cannot claim the connection until its lease has been released or expired; it does not overlap the active run.
- The dashboard continues to show unavailable/provisional state until stored metric results are committed.

## Tests and live validation

Add failing tests before implementation for:

1. high-volume default and explicit page size for `time-in-heart-rate-zone`;
2. one activity-level page uses a bounded number of store range reads while preserving all potentially affected local dates;
3. Postgres page-sized minute/activity writes issue set-based operations instead of per-row read/write pairs;
4. the worker deadline remains below the lease duration.

Then run focused tests, the full suite, lint, and production build. Rebuild the local Docker services, wait for the abandoned pre-fix lease to become claimable (or safely expire it using the existing state transition), and validate only anonymous row counts, cursor state, result count, and freshness/quality labels from the authorized account.
