# Photo nutrition writeback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users upload one meal photo, confirm per-dish grams, persist local nutrition, and asynchronously write each confirmed dish as an anonymous Google Health `nutrition-log`.

**Architecture:** Request-memory Vision call produces a structured draft (no photo persistence). `NutritionResolver.estimate` fills display ranges; `finalize` on confirm is the only persisted/writeback fact. One confirmed dish → one outbox row → one anonymous data point. Writeback runs in a Compose worker separate from health sync.

**Tech Stack:** Next.js App Router, PostgreSQL (`pg`), zod, node:test / tsx, existing session cookies and `SYNC_SECRET` bearer.

**Spec:** `docs/superpowers/specs/2026-08-26-photo-nutrition-google-health-design.md`

---

## File map

| Path | Responsibility |
| --- | --- |
| `src/domain/meal-vision.ts` | Vision JSON schema (`foods[]`) |
| `src/domain/meal-confirm.ts` | Confirm gate: every remaining dish has point grams |
| `src/domain/nutrients.ts` | Nutrient codes, grams/kcal types |
| `src/server/meals/types.ts` | Draft/version/dish/outbox rows |
| `src/server/meals/nutrition-resolver.ts` | `estimate` / `finalize` |
| `src/server/meals/food-database.ts` | Versioned food composition lookup (stub + interface) |
| `src/server/meals/photo-ingest.ts` | MIME, size, pixel, EXIF strip |
| `src/server/meals/google-nutrition.ts` | Anonymous payload + name/hash |
| `src/server/meals/http.ts` | Session meal HTTP handlers |
| `src/server/meals/outbox.ts` | Claim/finish outbox |
| `app/api/meals/**` | Routes |
| `app/api/internal/nutrition-sync/route.ts` | Worker endpoint |
| `worker/nutrition-loop.mjs` | Separate tick loop |
| `db/migrations/005_meals.sql` | Tables + `users.nutrition_writeback_enabled` |

---

### Task 1: Vision schema and confirm gate

**Files:**
- Create: `src/domain/meal-vision.ts`
- Create: `src/domain/meal-confirm.ts`
- Test: `tests/domain/meal-confirm.test.ts`

- [ ] **Step 1:** Failing tests: parse vision JSON; confirm rejected if a kept dish still has a portion range or unresolved `needsConfirmation`; confirm accepted when every kept dish has point grams and empty needsConfirmation.

- [ ] **Step 2:** Implement zod schema + `assertDishesReadyToConfirm`.

- [ ] **Step 3:** `npx tsx --test tests/domain/meal-confirm.test.ts` green. Commit `test: cover meal confirm gate`.

### Task 2: Meal tables

**Files:**
- Create: `db/migrations/005_meals.sql`
- Modify: `src/server/auth/types.ts` (`nutritionWritebackEnabled` on a user settings accessor, or meals store)

- [ ] **Step 1:** Migration: `users.nutrition_writeback_enabled BOOLEAN NOT NULL DEFAULT false`; meal_drafts, meal_versions, meal_dishes, meal_ingredients, meal_nutrients, nutrition_write_outbox, google_nutrition_links. All `user_id` FK + indexes.

- [ ] **Step 2:** Commit `feat: add meal nutrition tables`.

### Task 3: Memory meal store + confirm persistence

**Files:**
- Create: `src/server/meals/types.ts`
- Modify: `src/server/db/memory-store.ts`, `src/server/auth/types.ts`
- Test: `tests/server/meal-store.test.ts`

- [ ] **Step 1:** Failing tests: insert draft; confirm with one incomplete dish fails and writes no version; confirm with two ready dishes creates version, two dishes, two outbox rows when writeback flags true; writeback off → `local_only`.

- [ ] **Step 2:** Implement store methods.

- [ ] **Step 3:** Tests green. Commit `feat: persist confirmed meal dishes and outbox`.

### Task 4: NutritionResolver two-pass

**Files:**
- Create: `src/server/meals/food-database.ts`, `src/server/meals/nutrition-resolver.ts`
- Test: `tests/server/nutrition-resolver.test.ts`

- [ ] **Step 1:** Failing tests: estimate returns range and omits kcal when `needsConfirmation` includes 食用比例; finalize with point grams returns energy; Vision kcal numbers ignored.

- [ ] **Step 2:** Stub food DB (eggs, tomato, rice, oil) + resolver.

- [ ] **Step 3:** Tests green. Commit `feat: estimate and finalize meal nutrients`.

### Task 5: Photo ingest (no disk)

**Files:**
- Create: `src/server/meals/photo-ingest.ts`
- Test: `tests/server/photo-ingest.test.ts`

- [ ] **Step 1:** Reject non-jpeg/webp, >4 MiB, missing bytes. Accept small jpeg fixture; return buffer stripped of EXIF APP1 if present. Never write files.

- [ ] **Step 2:** Implement. Commit `feat: ingest meal photos in memory only`.

### Task 6: HTTP meal APIs

**Files:**
- Create: `src/server/meals/http.ts`
- Create: `app/api/meals/photo/route.ts`, `drafts/[id]/route.ts`, `drafts/[id]/confirm/route.ts`, `route.ts`, `[id]/route.ts`, `[id]/revise/route.ts`
- Create: `app/api/account/nutrition-writeback/route.ts`
- Test: `tests/server/meal-http.test.ts`

- [ ] **Step 1:** 401 without session; photo with mocked vision creates draft; confirm 400 if incomplete; confirm 200 creates version; writeback toggle.

- [ ] **Step 2:** Implement using existing cookie session + `checkPostOrigin`.

- [ ] **Step 3:** Tests green. Commit `feat: add meal photo and confirm HTTP`.

### Task 7: Google anonymous payload + name/hash

**Files:**
- Create: `src/server/meals/google-nutrition.ts`
- Test: `tests/server/google-nutrition.test.ts`

- [ ] **Step 1:** Payload uses full `users/me/dataTypes/nutrition-log/dataPoints/d-{uuid}`; no `food` field; no `CARBOHYDRATES` in nutrients[]; hash ignores dataSource/civil time.

- [ ] **Step 2:** Implement. Commit `feat: map dishes to anonymous nutrition-log`.

### Task 8: Outbox worker

**Files:**
- Create: `src/server/meals/outbox.ts`, `src/server/meals/internal-nutrition-sync.ts`
- Create: `app/api/internal/nutrition-sync/route.ts`
- Create: `worker/nutrition-loop.mjs`
- Modify: `docker-compose.yml`
- Test: `tests/server/nutrition-outbox.test.ts`

- [ ] **Step 1:** Timeout with GET miss → `unknown`, no second create. 401 → `failed_action_required`. Separate worker file, no health-sync lease.

- [ ] **Step 2:** Implement. Commit `feat: run nutrition writeback outbox`.

---

TDD, `npx tsx --test <file>`, `npm run lint` before each commit. Do not call live DeepSeek or Google in unit tests.
