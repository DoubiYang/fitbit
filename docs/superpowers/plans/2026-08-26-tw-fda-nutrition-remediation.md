# Taiwan FDA Nutrition Runtime Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Version the Taiwan FDA food-composition snapshot in Git, use it as the only V1 local nutrition authority, safely process meal photos, and deliver queued Google Health nutrition logs through an independent worker.

**Architecture:** `data/tw-fda/food-composition.json.zip` is the one current, immutable official source artifact in the repository; its sibling `manifest.json` records source URL, retrieved time, SHA-256, licence and parser version. A source refresh replaces those two files in one commit, so Git history is the only archive of earlier versions. An import command validates the committed artifact and loads normalised foods, aliases and canonical nutrient amounts into PostgreSQL. Meal confirmation uses only that local catalogue; it never asks Google Food to perform a name search. A separate nutrition worker claims leased outbox rows, obtains a server-side token for the owning user, and sends the already-stored anonymous `nutrition-log` payload exactly once unless recovery proves the request's final state.

**Tech Stack:** Next.js App Router, TypeScript, PostgreSQL/`pg`, node:test/tsx, `sharp` for server-side decoded-image validation and metadata removal, Docker Compose, Google Health REST.

**Design source:**
- `docs/superpowers/specs/2026-08-26-photo-nutrition-google-health-design.md`
- Taiwan FDA official dataset: `https://data.fda.gov.tw/data/opendata/export/20/json`

**Safety and provenance rules:** The one current Taiwan FDA source file and manifest are maintained in Git; Git history preserves prior revisions. Do not commit an OAuth token, DeepSeek key, meal photo, derived user record or third-party data. The importer verifies the raw SHA-256 before it mutates a database. A failed or ambiguous food match is `unknown`, never an estimate. The image service decodes/re-encodes in memory and does not log or persist original bytes.

---

## File map

| Path | Responsibility |
| --- | --- |
| `data/tw-fda/food-composition.json.zip` | One current, unmodified official Taiwan FDA download, maintained in Git |
| `data/tw-fda/manifest.json` | URL, licence, retrieval time, SHA-256, source-record count, parser version and Git revision |
| `data/tw-fda/README.md` | Attribution, licence and single-file Git refresh procedure |
| `scripts/import-tw-fda-food-composition.ts` | Offline, idempotent importer; it accepts an explicit committed snapshot path only |
| `src/server/nutrition/tw-fda.ts` | Normalisation, nutrient-code/unit mapping, exact alias candidate lookup and fact scaling |
| `db/migrations/007_food_composition.sql` | Food snapshot, food, nutrient and alias tables plus source-referencing columns |
| `src/server/meals/ingredient-nutrition.ts` | Resolves only local Taiwan FDA candidates; no Google API access |
| `src/server/meals/http.ts` | Confirmation path no longer creates a Google Food catalogue or accesses a token for local resolution |
| `src/server/meals/photo-ingest.ts` | Decode, enforce dimensions/pixels and re-encode JPEG/WebP without metadata |
| `src/server/meals/nutrition-outbox.ts` | Leasing, Google create/recovery and state transitions for immutable payloads |
| `src/server/meals/internal-nutrition-sync.ts` | Bearer-protected nutrition-outbox runner |
| `app/api/internal/nutrition-sync/route.ts` | Thin route for the worker endpoint |
| `worker/nutrition-loop.mjs` | Independent one-minute nutrition worker tick |
| `docker-compose.yml` | `nutrition-sync` service; no copied database password or secret in YAML |
| `tests/server/tw-fda.test.ts` | Fixture import, unit conversion, aliases, ambiguity and unknown coverage |
| `tests/server/photo-ingest.test.ts` | Metadata removal, invalid/truncated formats and decoded pixel-limit regression tests |
| `tests/server/nutrition-outbox.test.ts` | Claim, create, recovery and error-state tests |
| `tests/worker/nutrition-loop.test.ts` | Dedicated worker polling and non-secret logging tests |

## Task 1: Commit a reproducible Taiwan FDA source snapshot

**Files:**
- Create: `data/tw-fda/food-composition.json.zip`, `data/tw-fda/manifest.json`, `data/tw-fda/README.md`
- Create: `scripts/import-tw-fda-food-composition.ts`
- Create: `tests/fixtures/tw-fda-small.json`, `tests/server/tw-fda-import.test.ts`

- [ ] **Step 1: Write the failing importer tests.** Use a small checked-in fixture with multiple nutrient rows for one official food ID. Assert that an import refuses a SHA mismatch, duplicate official IDs are merged only within the same snapshot, and a second import of the same verified snapshot is idempotent.

- [ ] **Step 2: Run the focused tests and observe failure.**

Run: `pnpm test tests/server/tw-fda-import.test.ts`

Expected: FAIL because no importer or snapshot parser exists.

- [ ] **Step 3: Obtain and validate the one official file without changing it.** Download only `https://data.fda.gov.tw/data/opendata/export/20/json`; record the final URL, SHA-256, retrieval timestamp in UTC, Open Government Data License 1.0 attribution and top-level record count. Store it at `data/tw-fda/food-composition.json.zip` with `manifest.json`; future refreshes replace those two files in the same commit. If the archive exceeds 25 MiB, stop before adding it and ask the user whether to use Git LFS; do not silently omit raw data or rewrite history.

- [ ] **Step 4: Implement the offline importer.** It must accept the snapshot path as an argument, compute SHA-256 before extraction, parse JSON without network access, validate required Taiwan FDA fields (`整合編號`, sample name, nutrient name, unit and per-100g value), and produce only parameterised inserts. Source values that cannot be parsed are reported as counters and never converted to zero.

- [ ] **Step 5: Rerun focused tests and commit.**

Run: `pnpm test tests/server/tw-fda-import.test.ts`

Expected: PASS.

Commit: `data: add versioned Taiwan FDA composition snapshot`

## Task 2: Add immutable food-composition storage and exact resolution

**Files:**
- Create: `db/migrations/007_food_composition.sql`, `src/server/nutrition/tw-fda.ts`, `tests/server/tw-fda.test.ts`
- Modify: `src/server/auth/types.ts`, `src/server/db/memory-store.ts`, `src/server/db/postgres-store.ts`, `src/server/meals/types.ts`, `src/server/meals/ingredient-nutrition.ts`, `src/server/meals/meal-nutrients.ts`, `src/server/meals/confirm-draft.ts`, `src/server/meals/http.ts`

- [ ] **Step 1: Write failing resolution tests.** Cover simplified/traditional exact alias (`西兰花` → a fixture `花椰菜` official ID), an ambiguous alias returning no match, an absent nutrient remaining `undefined`, and unit conversion from mg/µg to canonical grams. A test must show that confirmation works without an OAuth connection when local data exists.

- [ ] **Step 2: Run focused tests and observe failure.**

Run: `pnpm test tests/server/tw-fda.test.ts tests/server/meal-http.test.ts`

Expected: FAIL because confirmation currently resolves through `createGoogleFoodCatalog`.

- [ ] **Step 3: Add forward-only schema and store interfaces.** Create source-version, foods, nutrients and aliases tables. Food rows have `(source_revision, official_food_id)` uniqueness; `source_revision` is the committed file's SHA-256 and Git commit. Nutrient rows preserve the official nutrient label, raw unit and canonical code/unit. Meal ingredients record `tw_fda` plus official food ID and source revision. Do not modify migrations `005` or `006`.

- [ ] **Step 4: Implement conservative code/unit mapping.** Map only known Taiwan FDA nutrient labels to the existing Google-supported codes and explicit local extensions. Energy is stored in kcal; weight values are converted to grams only for unambiguous g/mg/µg source units. Preserve raw unit/basis for audit and omit values whose unit or basis cannot safely map.

- [ ] **Step 5: Replace the Google Food resolver.** Query local aliases and exact normalised food names only. Remove token refresh, Google Food list calls and their failure path from confirmation. Resolve all user-confirmed ingredients; facts and provenance must reference one Taiwan FDA snapshot. If no ingredient has a known value, save the meal and `local_only` outbox audit row.

- [ ] **Step 6: Rerun focused tests and commit.**

Run: `pnpm test tests/server/tw-fda.test.ts tests/server/meal-http.test.ts tests/server/meal-store.test.ts`

Expected: PASS.

Commit: `feat: resolve meal nutrition from Taiwan FDA data`

## Task 3: Fail closed on photo format, pixels and metadata

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`, `src/server/meals/photo-ingest.ts`, `tests/server/photo-ingest.test.ts`, `tests/server/meal-http.test.ts`

- [ ] **Step 1: Write failing regression tests.** Add a valid WebP larger than 2048 px, an image over 4,000,000 decoded pixels, truncated JPEG/WebP data carrying an EXIF marker, and ordinary JPEG/WebP with metadata. Assert the first three are rejected before the vision client and the accepted buffers have no metadata marker.

- [ ] **Step 2: Run focused tests and observe failure.**

Run: `pnpm test tests/server/photo-ingest.test.ts tests/server/meal-http.test.ts`

Expected: FAIL because the current lightweight parser accepts malformed WebP and does not inspect WebP dimensions.

- [ ] **Step 3: Add the minimal decoder-backed implementation.** Add `sharp`, configure a 4,000,000-pixel decoder limit, read decoded metadata for both permitted formats, reject dimensions above 2048 before model invocation, and re-encode JPEG/WebP in memory without `withMetadata`. Fail parsing, unsupported MIME and transformation errors as `invalid_photo`; do not return original bytes after an error.

- [ ] **Step 4: Verify no raw photo is surfaced.** The handler test checks that 400 is returned and the injected vision client remains uncalled for every invalid fixture.

- [ ] **Step 5: Rerun focused tests and commit.**

Run: `pnpm test tests/server/photo-ingest.test.ts tests/server/meal-http.test.ts`

Expected: PASS.

Commit: `fix: validate meal photos with decoded limits`

## Task 4: Implement leased Google nutrition writeback

**Files:**
- Create: `db/migrations/008_nutrition_outbox_worker.sql`, `src/server/meals/nutrition-outbox.ts`, `src/server/meals/internal-nutrition-sync.ts`, `app/api/internal/nutrition-sync/route.ts`, `worker/nutrition-loop.mjs`, `tests/server/nutrition-outbox.test.ts`, `tests/worker/nutrition-loop.test.ts`
- Modify: `src/server/auth/types.ts`, `src/server/db/memory-store.ts`, `src/server/db/postgres-store.ts`, `docker-compose.yml`

- [ ] **Step 1: Write failing worker tests.** Cover `SKIP LOCKED`-equivalent claims, one create POST per claimed row, completed Operation creating `google_nutrition_links` and marking `synced`, 401/403 becoming `failed_action_required`, 429/5xx scheduling 1m/5m/30m retry, and timeout/invalid response using exact-name GET reconciliation. A missing resource after an indeterminate create becomes `unknown`; it is never automatically recreated.

- [ ] **Step 2: Run focused tests and observe failure.**

Run: `pnpm test tests/server/nutrition-outbox.test.ts tests/worker/nutrition-loop.test.ts`

Expected: FAIL because no nutrition-outbox worker exists.

- [ ] **Step 3: Add forward-only outbox lease storage.** Add `lease_until`, `last_attempt_at` and a unique active link constraint as needed. Claim only due `write_pending`/`retrying` rows with a bounded batch and lease, and release/finish only when the worker still owns the row.

- [ ] **Step 4: Implement the typed client and state machine.** Retrieve the owning connection and refresh its token only within the worker. `POST /v4/users/me/dataTypes/nutrition-log/dataPoints` sends the stored payload unchanged. Treat `done: true` as success; retain asynchronous operation name for `operation_pending`; reconcile only `users/me/.../<client-short-id>` with canonical hash. Emit error codes and counts, never tokens, photo data or payload bodies.

- [ ] **Step 5: Add endpoint, worker and Compose service.** `nutrition-sync` posts once per minute to `/rhythm/api/internal/nutrition-sync` with `SYNC_SECRET`. It has an independent task lease and does not alter the six-hour health-data sync schedule.

- [ ] **Step 6: Rerun focused tests and commit.**

Run: `pnpm test tests/server/nutrition-outbox.test.ts tests/worker/nutrition-loop.test.ts`

Expected: PASS.

Commit: `feat: run Google nutrition writeback outbox`

## Task 5: Full verification, import and controlled live check

**Files:**
- Modify only if verification exposes a defect.

- [ ] **Step 1: Run the committed importer against the committed source artifact.** Verify manifest SHA, record count and transaction success. Do not use a network URL at runtime.

- [ ] **Step 2: Run full static and automated verification.**

Run: `pnpm lint && pnpm test && pnpm build && docker compose config --quiet`

Expected: exit 0 with no test failures.

- [ ] **Step 3: Build and start the Compose stack.**

Run: `docker compose up --build -d`

Expected: `db`, `app`, `sync` and `nutrition-sync` healthy. Inspect only health and status; never print `.env.local`.

- [ ] **Step 4: Complete the existing OAuth sign-in and test exactly one confirmed meal.** Confirm that the requested meal stores local Taiwan FDA provenance and, only if the user enables account and per-meal writeback, the nutrition worker changes the matching outbox record to `synced`. Record only IDs, status and timing.

- [ ] **Step 5: Review the diff, commit any verification fixes, then push.** Include the raw source archive, manifest, importer and migration in the review; reject a commit containing `.env.local`, source photos, tokens or generated PostgreSQL files.
