# Nutrition Runtime and Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing photo-recognition and meal-persistence foundations into a session-protected, testable flow that can recognize `test.jpg`, persist complete local nutrition provenance, write supported nutrients to Google Health, and calculate conservative DRI reminders.

**Architecture:** The photo route sends an in-memory JPEG/WebP buffer to a server-only `VisionProvider`, stores only validated candidates, and returns a draft. Confirm resolves the user's confirmed dishes through the Google Food catalog, freezes all known local nutrition and provenance, and enqueues an immutable Google payload. A separate worker claims outbox jobs. The reminder service reads only local immutable meal facts, only evaluates complete civil days, and returns `unknown`/`not_eligible` rather than inventing a low-intake result.

**Tech Stack:** Next.js App Router, TypeScript, zod, PostgreSQL/`pg`, node:test/tsx, existing Google OAuth token envelope, Compose workers.

**Specs:**
- `docs/superpowers/specs/2026-08-26-photo-nutrition-google-health-design.md`
- `docs/superpowers/specs/2026-08-26-micronutrient-intake-reminder-design.md`

**Explicit safety boundary:** Unit tests use fakes only. The one live DeepSeek call uses the user-provided `.env.local` key and `../test.jpg` only after the protected route exists. No key, token, photo bytes, base64 payload, or raw model response is logged or committed. The reminder engine ships with no invented DRI values: before a versioned, attributable target table is imported, nutrients return `not_eligible`.

---

## File map

| Path | Responsibility |
| --- | --- |
| `src/server/config/env.ts` | Optional server-only DeepSeek API-key configuration |
| `src/server/meals/http.ts` | Session/origin-protected photo, draft and confirm handlers |
| `app/api/meals/photo/route.ts` | Multipart photo entry point |
| `app/api/meals/drafts/[id]/route.ts` | Read only the caller's draft |
| `app/api/meals/drafts/[id]/confirm/route.ts` | Finalize caller-owned draft |
| `src/server/meals/google-nutrition.ts` | Canonical anonymous `nutrition-log` projection and hash |
| `src/server/meals/nutrition-outbox.ts` | Claim, create, reconcile and terminal-state policy |
| `app/api/internal/nutrition-sync/route.ts` | `SYNC_SECRET`-protected worker endpoint |
| `worker/nutrition-loop.mjs` | Dedicated nutrition tick runner |
| `src/server/nutrition/reminders.ts` | Pure DRI/coverage status calculation |
| `src/server/nutrition/http.ts` | Profile, complete-day and reminder handlers |
| `app/api/nutrition/**` | Session-protected nutrition endpoints |
| `db/migrations/006_nutrition_runtime.sql` | Payload/provenance/outbox lease fields |
| `db/migrations/007_nutrition_reminders.sql` | Profile, complete-day and versioned DRI tables |
| `tests/server/*` | Fakes and behavior-focused tests; no live credentials |

## Task 1: Protect and test the photo-draft route

**Files:**
- Modify: `src/server/config/env.ts`, `src/server/auth/runtime.ts`
- Create: `src/server/meals/http.ts`, `app/api/meals/photo/route.ts`, `app/api/meals/drafts/[id]/route.ts`
- Create: `tests/server/meal-http.test.ts`

- [x] **Step 1: Write failing tests.** Covered unauthenticated `401`, explicit consent, a valid multipart JPEG reaching an injected `VisionClient`, a missing `DEEPSEEK_APIKEY` returning a non-secret `503`, and caller-owned draft reads.
- [x] **Step 2: Run the focused test.** Observed the expected missing-handler failure.
- [x] **Step 3: Add the minimal configuration and handler.** Added optional server-only configuration, session/origin/consent checks, in-memory JPEG/WebP ingestion, EXIF stripping, validation, Vision invocation and draft persistence. The response has no image bytes or raw provider output.
- [x] **Step 4: Add thin routes and rerun focused tests.** Focused tests and full type-check are green.
- [ ] **Step 5: Commit.** `feat: add protected meal photo drafts`.

## Task 2: Confirm drafts with a real catalog and preserve complete local facts

**Files:**
- Modify: `src/server/meals/types.ts`, `src/server/meals/confirm-draft.ts`, `src/server/meals/meal-nutrients.ts`, `src/server/meals/ingredient-nutrition.ts`, `src/server/db/memory-store.ts`, `src/server/db/postgres-store.ts`, `src/server/auth/types.ts`
- Create: `app/api/meals/drafts/[id]/confirm/route.ts`, `db/migrations/006_nutrition_runtime.sql`
- Modify: `tests/server/meal-store.test.ts`, `tests/server/meal-nutrients.test.ts`, `tests/server/meal-http.test.ts`

- [ ] **Step 1: Write failing tests.** Confirm should resolve with the current user's refreshed Google token and `createGoogleFoodCatalog`; it must persist the ingredient's stable catalog ID/version, resolver version, visual confidence and known nutrient values. A dish with no Google-supported known nutrition must remain local-only and never become a pending Google write.
- [ ] **Step 2: Run focused tests and observe the expected failures.**
- [ ] **Step 3: Make migration and type changes.** Add immutable JSON payload storage, a payload hash, source/provenance columns or a narrowly-scoped provenance table, and an outbox claim lease. Do not rewrite migration `005`; add forward-only `006`.
- [ ] **Step 4: Implement the minimal confirm path.** Obtain the connection only for the current session user; resolve an access token server-side; create the read-only catalog; calculate local facts from confirmed grams; preserve absent values as unknown, not zero. Set nutrition confidence from the source/visual evidence rather than hard-coding `1`.
- [ ] **Step 5: Verify the focused suite and commit.** `feat: persist complete confirmed meal nutrition`.

## Task 3: Build and queue the complete Google nutrition projection

**Files:**
- Create: `src/server/meals/google-nutrition.ts`
- Modify: `src/server/meals/confirm-draft.ts`, `src/server/db/memory-store.ts`, `src/server/db/postgres-store.ts`
- Create: `tests/server/google-nutrition.test.ts`

- [ ] **Step 1: Write failing payload tests.** A confirmed dish maps top-level energy/carbohydrate/fat; `CARBOHYDRATES` is excluded from `nutrients[]`; every other supported and known local code, including vitamins/minerals/fiber/fat subtypes, is included; unsupported extensions are excluded; hash is stable across key order.
- [ ] **Step 2: Run focused tests and observe the expected failures.**
- [ ] **Step 3: Implement the canonical builder.** Use grams as canonical storage, include `userProvidedUnit` for display where needed, use a full client-supplied data-point name, and store exactly the payload that will be sent. The builder must not emit an empty nutrition log.
- [ ] **Step 4: Enqueue only after the account switch, per-meal confirmation, granted write scope, syncable connection and a nonempty payload all hold.** Otherwise retain a local-only audit record.
- [ ] **Step 5: Verify focused tests and commit.** `feat: queue complete Google nutrition payloads`.

## Task 4: Execute writeback through a dedicated outbox worker

**Files:**
- Create: `src/server/meals/nutrition-outbox.ts`, `src/server/meals/internal-nutrition-sync.ts`, `app/api/internal/nutrition-sync/route.ts`, `worker/nutrition-loop.mjs`
- Modify: `src/server/auth/types.ts`, `src/server/db/memory-store.ts`, `src/server/db/postgres-store.ts`, `docker-compose.yml`
- Create: `tests/server/nutrition-outbox.test.ts`, `tests/worker/nutrition-loop.test.ts`

- [ ] **Step 1: Write failing tests.** Concurrent claims do not duplicate a job; successful create records a Google link; 401/403 becomes `failed_action_required`; 429/5xx retries with bounded backoff; a timeout with a failed GET reconciliation becomes `unknown` and never auto-recreates.
- [ ] **Step 2: Run focused tests and observe failures.**
- [ ] **Step 3: Implement a typed REST client and store claim/finish primitives.** Refresh the current job's user token only in the worker. Create is `POST nutrition-log/dataPoints`; reconcile only by the exact client name and canonical hash. Never match by nutrition values/time and never retry `unknown` automatically.
- [ ] **Step 4: Add the internal endpoint and Compose service.** It must use the existing `SYNC_SECRET`, emit counts only, and use an independent lease from health sync.
- [ ] **Step 5: Verify focused worker tests and commit.** `feat: run nutrition writeback outbox`.

## Task 5: Add conservative DRI reminder primitives and endpoints

**Files:**
- Create: `src/server/nutrition/reminders.ts`, `src/server/nutrition/http.ts`, `app/api/nutrition/reminders/route.ts`, `app/api/nutrition/days/[date]/route.ts`, `app/api/account/profile/route.ts`
- Modify: `src/server/auth/types.ts`, `src/server/db/memory-store.ts`, `src/server/db/postgres-store.ts`
- Create: `db/migrations/007_nutrition_reminders.sql`, `tests/server/nutrition-reminders.test.ts`, `tests/server/nutrition-http.test.ts`

- [ ] **Step 1: Write failing pure-calculation tests.** Missing profile, fewer than three completed days, incomplete days, <80% coverage, or absent versioned DRI target must never produce `below_reference`; sodium never produces a low-sodium prompt; sex/age target selection differs for iron.
- [ ] **Step 2: Run focused tests and observe failures.**
- [ ] **Step 3: Implement schema and pure calculator.** Add `birth_date`, `sex`, `nutrition_day_records`, and a versioned DRI reference table. Until an attributable 2023 reference dataset is supplied, ship zero target rows and return `not_eligible`; do not guess numeric values.
- [ ] **Step 4: Implement protected handlers.** A user may mark only a completed civil day as complete; a meal mutation reopens its day; endpoints return no photo, token or raw provider data.
- [ ] **Step 5: Verify focused tests and commit.** `feat: add conservative nutrition reminders`.

## Task 6: Full verification and controlled live photo validation

**Files:**
- Modify only if evidence exposes a defect in Tasks 1–5.

- [ ] **Step 1: Run static and unit verification.** `pnpm lint` and `pnpm test` must exit zero.
- [ ] **Step 2: Build and start the Compose stack.** `docker compose up --build -d`; check health without exposing secrets.
- [ ] **Step 3: Complete the existing OAuth sign-in in the browser.** This is required before the session-protected photo route can store a user draft or query that user's Food catalog.
- [ ] **Step 4: Send `../test.jpg` once through the protected photo route.** Record only response metadata, schema validity, candidate count and latency. Do not log image bytes, data URL, API key or raw Vision response.
- [ ] **Step 5: Report the real result and any live API contract discrepancy before enabling repeated or automatic uploads.**
