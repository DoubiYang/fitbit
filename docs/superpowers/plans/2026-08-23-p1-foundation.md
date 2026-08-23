# P1 Foundation and Today Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a mobile-first, locally runnable PWA vertical slice that turns scoped health records into transparent Recovery, Sleep Completeness, Training Load, and evidence-bound “today” guidance for an isolated demo user.

**Architecture:** Build a strict TypeScript Next.js application. Health records first enter an immutable, user-scoped provider contract; a normalizer turns them into day-level inputs; pure metric functions calculate versioned outputs; a view-model builder exposes only these outputs and bounded evidence to the UI and future coach. The initial `DemoHealthProvider` makes the slice testable without secrets. `GoogleHealthProvider` is an adapter boundary only until OAuth credentials and Fitbit Air test accounts are available.

**Tech Stack:** Next.js App Router, React, TypeScript (strict), Vitest, React Testing Library, Zod, ESLint, modern CSS, browser-native PWA manifest. Provider and repository interfaces are storage-neutral in this slice; production persistence/OAuth are a separate plan because they require external credentials and an approved data store.

---

## Scope and sequencing

This is the first of four independent implementation slices. It deliberately makes the product usable in **demo mode** and locks the rules that must not vary between UI, AI Coach, and future Google sync.

| Slice | Result | Prerequisite outside this repository |
| --- | --- | --- |
| A — this plan | PWA shell, deterministic owned metrics, data-quality states, evidence-safe today dashboard, user-scoped demo provider | None |
| B | Google OAuth, encrypted token store, v4 backfill/webhooks, production database | Google Cloud/Health API application, verified redirect URI, test accounts, data-store choice |
| C | Photo meal confirmation, Vision provider evaluation, anonymous nutrition-log writeback state machine | DeepSeek API key, approved food-nutrition source, completed privacy/vendor review |
| D | AI Coach, habit experiments, weekly report | Approved Coach provider/key, completed prompt and safety evaluation set |

Do not add real API keys to code, browser storage, fixtures, commits, or logs. Do not make any real Google/DeepSeek request in this slice.

## Proposed file structure

```text
app/
  api/today/route.ts                  # user-scoped JSON read endpoint
  layout.tsx                          # metadata, language, PWA metadata
  page.tsx                            # server component composing dashboard
  globals.css                         # reset and app-wide variables
  manifest.ts                         # installable PWA manifest
src/
  domain/
    health-records.ts                 # raw normalized health record types and Zod guards
    metric-types.ts                   # stable public metric/evidence/view-model types
    metrics.ts                        # pure sleep, recovery, load and coach fallback calculations
  server/
    dashboard/build-today.ts          # user-scoped view-model composition
    health/provider.ts                # provider interface and explicit capability flags
    health/demo-provider.ts           # deterministic fixture-backed provider
    health/google-health-provider.ts  # unconfigured adapter which fails closed
    session/current-user.ts            # demo session; central replacement point for OAuth
  ui/
    dashboard/today-dashboard.tsx     # accessible presentational dashboard
    dashboard/metric-card.tsx         # metric + quality + evidence disclosure
    dashboard/data-state.tsx          # honest calibration/no-data state
tests/
  domain/health-records.test.ts
  domain/metrics.test.ts
  server/build-today.test.ts
  server/google-health-provider.test.ts
  ui/today-dashboard.test.tsx
  fixtures/health-records.ts
public/
  icon.svg
docs/
  superpowers/plans/2026-08-23-p1-foundation.md
  implementation/p1-foundation.md
```

### Task 1: Bootstrap a tested PWA shell

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `eslint.config.mjs`
- Create: `app/layout.tsx`, `app/page.tsx`, `app/globals.css`, `app/manifest.ts`, `public/icon.svg`
- Create: `tests/smoke.test.ts`
- Create: `.env.example`, `README.md`

- [ ] **Step 1: Add the configuration-only project files without overwriting documentation**

Create `package.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, and `vitest.config.ts` by hand in the existing repository. Use current compatible versions of `next`, `react`, `react-dom`, `typescript`, `vitest`, `@vitejs/plugin-react`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`, `zod`, and the corresponding type packages. Do not scaffold into a temporary directory or overwrite `docs/`.

- [ ] **Step 2: Add a failing PWA metadata test**

```ts
import { expect, test } from 'vitest';
import manifest from '@/app/manifest';

test('declares an installable Chinese PWA', () => {
  expect(manifest.name).toBe('节律');
  expect(manifest.display).toBe('standalone');
  expect(manifest.lang).toBe('zh-CN');
});
```

- [ ] **Step 3: Run the test and confirm RED**

Run: `npm run test -- tests/smoke.test.ts`

Expected: module/configuration failure because the test runner and manifest are not configured yet.

- [ ] **Step 4: Configure Vitest and implement the minimal manifest**

Use a `defineConfig` Vitest configuration with the same `@/` alias as TypeScript. `app/manifest.ts` returns exactly `name`, `short_name`, `description`, `lang: 'zh-CN'`, `display: 'standalone'`, `start_url: '/'`, `theme_color`, `background_color`, and one local SVG icon. Set package scripts `dev`, `build`, `lint`, `test`, and `test:watch`.

- [ ] **Step 5: Run the focused test, lint, and production build**

Run: `npm run test -- tests/smoke.test.ts`, `npm run lint`, `npm run build`

Expected: all commands exit 0.

- [ ] **Step 6: Commit the shell**

```bash
git add package.json package-lock.json tsconfig.json next.config.ts vitest.config.ts eslint.config.mjs app src public tests .env.example README.md
git commit -m "feat: bootstrap P1 PWA shell"
```

### Task 2: Define validated health records and user boundaries

**Files:**
- Create: `src/domain/health-records.ts`
- Create: `src/domain/metric-types.ts`
- Create: `tests/domain/health-records.test.ts`
- Create: `tests/fixtures/health-records.ts`

- [ ] **Step 1: Write failing normalization tests**

Cover each behavior separately: a valid sleep session preserves `civilEndDate` and `utcOffset`; a nap never qualifies as a primary-sleep candidate; out-of-range HRV/RHR is rejected; all records require an opaque `userId` and source identity; unknown training days are represented as `unknown`, never `0`.

```ts
test('rejects a HRV record outside the accepted physiological range', () => {
  expect(() => parseDailyHrv({ ...validHrv, valueMs: 0 })).toThrow();
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npm run test -- tests/domain/health-records.test.ts`

Expected: imports fail because parsers and types do not exist.

- [ ] **Step 3: Implement minimal Zod-backed domain guards**

Create separate discriminated record types for sleep sessions, daily HRV/RHR, exercise sessions, and day-completeness. Do not use Google API response objects outside `GoogleHealthProvider`; this domain uses only normalized physical/civil times, offsets, `source`, `sourceRecordId`, and user-scoped IDs.

- [ ] **Step 4: Re-run focused and full unit tests**

Run: `npm run test -- tests/domain/health-records.test.ts`, then `npm run test`

Expected: all tests pass; fixture data contains no real user health information.

- [ ] **Step 5: Commit the domain contract**

```bash
git add src/domain tests/domain tests/fixtures
git commit -m "feat: add validated health record domain"
```

### Task 3: Implement owned metrics as pure, versioned functions

**Files:**
- Create: `src/domain/metrics.ts`
- Modify: `src/domain/metric-types.ts`
- Create: `tests/domain/metrics.test.ts`

- [ ] **Step 1: Write failing tests for primary sleep selection and sleep score**

Include: the longest non-nap session of at least 180 minutes wins; equal sessions break by processed status then earliest start then ID; fewer than 14 sleep dates produces a `calibrating` partial sleep score without regularity; missing a user sleep goal produces no sleep score.

```ts
test('does not include regularity before 14 historical primary sleeps', () => {
  const result = computeSleepCompleteness(inputWithThirteenPriorSleeps);
  expect(result.quality).toBe('calibrating');
  expect(result.components.regularity).toBeUndefined();
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm run test -- tests/domain/metrics.test.ts`

Expected: missing exported metric functions.

- [ ] **Step 3: Implement sleep completeness and sleep debt**

Implement the documented duration, efficiency, wake-interruption, and cross-midnight regularity equations. Return `{ score, quality, components, evidence, missingInputs, metricVersion }`; no function returns a numeric score if its documented minimum inputs are absent.

- [ ] **Step 4: Add failing tests for recovery baseline behavior**

Cover: target day never enters its own baseline; fewer than 14 same-field days disables HRV/RHR components; fewer than two valid components returns `no_score`; a stale sync caps quality at `low`; MAD floors are `5 ms` and `3 bpm`.

- [ ] **Step 5: Implement recovery and verify GREEN**

Implement median/MAD baselines and normalized available-weight aggregation exactly as the metric design specifies. Ensure output language uses non-medical labels only.

Run: `npm run test -- tests/domain/metrics.test.ts`

Expected: all metric tests pass.

- [ ] **Step 6: Add failing tests for training load safeguards**

Cover: zone summaries use weights `1/3/4/5`; minute heart rate is used only when `HRmax` and recent RHR validation pass; unknown day cannot be zero; load ratio is withheld before 8 non-zero and 24 complete days.

- [ ] **Step 7: Implement training load and run the full suite**

Run: `npm run test`

Expected: all domain tests pass with deterministic outputs for the fixed fixtures.

- [ ] **Step 8: Commit the metric engine**

```bash
git add src/domain tests/domain
git commit -m "feat: calculate transparent P1 metrics"
```

### Task 4: Create safe provider and session seams

**Files:**
- Create: `src/server/health/provider.ts`
- Create: `src/server/health/demo-provider.ts`
- Create: `src/server/health/google-health-provider.ts`
- Create: `src/server/session/current-user.ts`
- Create: `tests/server/google-health-provider.test.ts`

- [ ] **Step 1: Write a failing fail-closed provider test**

```ts
test('refuses Google Health access when the integration is unconfigured', async () => {
  const provider = new GoogleHealthProvider({ clientId: undefined, clientSecret: undefined });
  await expect(provider.listRecords('user_a', range)).rejects.toMatchObject({ code: 'integration_unavailable' });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm run test -- tests/server/google-health-provider.test.ts`

Expected: provider module is absent.

- [ ] **Step 3: Implement the provider boundary**

`HealthProvider` accepts a `userId` on every method and exposes immutable normalized records plus a capability object. `DemoHealthProvider` returns only copied fixtures for `demo_user`; another user gets no records. `GoogleHealthProvider` must not fabricate data or make requests without complete server-only configuration; it returns a typed unavailable error. `current-user.ts` is the sole demo-session implementation and never accepts a client-supplied user ID.

- [ ] **Step 4: Verify focused tests and full suite**

Run: `npm run test -- tests/server/google-health-provider.test.ts`, then `npm run test`

Expected: no real network request; test proves configurations fail closed.

- [ ] **Step 5: Commit the seams**

```bash
git add src/server tests/server
git commit -m "feat: add user-scoped health provider boundary"
```

### Task 5: Build the evidence-safe today view model and endpoint

**Files:**
- Create: `src/server/dashboard/build-today.ts`
- Create: `app/api/today/route.ts`
- Create: `tests/server/build-today.test.ts`

- [ ] **Step 1: Write failing view-model tests**

Cover: only records belonging to the resolved session user reach the response; every recommendation has two dated evidence entries or is replaced by a data-state message; `low` or `calibrating` data cannot produce a higher-intensity action; raw health records and provider tokens are absent from serialized JSON.

```ts
test('returns a calibration message rather than a training instruction with insufficient recovery inputs', async () => {
  const view = await buildTodayView(calibratingContext);
  expect(view.primaryAction.kind).toBe('data_state');
  expect(view.primaryAction).not.toHaveProperty('trainingPrescription');
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm run test -- tests/server/build-today.test.ts`

Expected: `buildTodayView` cannot be imported.

- [ ] **Step 3: Implement the smallest view model**

Compose provider data and metric results into a stable `TodayView`: three metric cards, freshness, quality, a non-medical primary action, maximum three evidence items, and an explicit no-data/calibrating state. Add an HTTP `GET` route that resolves the server session first, returns `Cache-Control: no-store`, and maps unavailable integrations to a non-sensitive 503 response.

- [ ] **Step 4: Verify API behavior**

Run: `npm run test -- tests/server/build-today.test.ts`, then `npm run test`

Expected: all responses are user-scoped and evidence-complete.

- [ ] **Step 5: Commit the server read path**

```bash
git add app/api src/server/dashboard tests/server
git commit -m "feat: expose evidence-safe today view"
```

### Task 6: Render a mobile-first, accessible dashboard without medical claims

**Files:**
- Create: `src/ui/dashboard/today-dashboard.tsx`
- Create: `src/ui/dashboard/metric-card.tsx`
- Create: `src/ui/dashboard/data-state.tsx`
- Modify: `app/page.tsx`, `app/globals.css`, `app/layout.tsx`
- Create: `tests/ui/today-dashboard.test.tsx`

- [ ] **Step 1: Write a failing rendering test**

```tsx
test('shows evidence dates and quality for the primary action', () => {
  render(<TodayDashboard view={completeView} />);
  expect(screen.getByText('依据')).toBeVisible();
  expect(screen.getByText(/2026-08-22/)).toBeVisible();
  expect(screen.getByText('数据质量：高')).toBeVisible();
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm run test -- tests/ui/today-dashboard.test.tsx`

Expected: component module is absent.

- [ ] **Step 3: Implement the presentational components**

Use semantic headings, an ordered evidence list, text labels in addition to color, visible `calibrating`/`low` states, and responsive single-column layout. The page calls the server builder directly; it does not read health data from browser storage or call an external provider. Do not add a meal photo flow, coach chat, OAuth button, or unapproved marketing claims in this slice.

- [ ] **Step 4: Verify UI tests, lint and build**

Run: `npm run test -- tests/ui/today-dashboard.test.tsx`, `npm run test`, `npm run lint`, `npm run build`

Expected: all commands exit 0 and no accessibility-visible state depends only on color.

- [ ] **Step 5: Manually inspect the local dashboard at a mobile viewport**

Run: `npm run dev`

Confirm: the header, primary action, evidence, three metrics, freshness and quality are visible without horizontal scroll at 390 px width. Stop the local server after inspection.

- [ ] **Step 6: Commit the vertical slice**

```bash
git add app src/ui tests/ui
git commit -m "feat: render P1 today dashboard"
```

### Task 7: Document local operation and hand off external integration prerequisites

**Files:**
- Modify: `README.md`, `.env.example`
- Create: `docs/implementation/p1-foundation.md`

- [ ] **Step 1: Write a failing smoke assertion for demo-mode isolation**

Add a unit assertion proving an unset integration environment selects `DemoHealthProvider` and does not disclose environment variable values through the public view.

- [ ] **Step 2: Run and confirm RED, then implement**

Document only variable names (never values): Google client ID/secret, redirect URI, token-encryption key, database URL, DeepSeek key. Explain that none are used by default and list the required Google/DeepSeek/privacy approvals before the later slices can be enabled.

- [ ] **Step 3: Run final verification**

Run: `npm run test`, `npm run lint`, `npm run build`, `git diff --check`, `git status --short`

Expected: tests/lint/build pass, diff has no whitespace errors, and only intended files are modified.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md .env.example docs/implementation tests
git commit -m "docs: add P1 foundation runbook"
```

## Completion criteria for this slice

1. `npm run test`, `npm run lint`, and `npm run build` pass on a clean clone with Node 25 and no secrets.
2. A local PWA shows transparent metrics and evidence for the fixture-backed demo user.
3. All user-derived reads are scoped through a server-side session and provider contract; raw records and credentials never reach the browser view model.
4. No score is shown when its documented minimum inputs are missing; all actions cite evidence and downgrade on low quality.
5. Unconfigured Google integration fails closed and is visibly separate from demo mode.

## Follow-on plan gates

Do not implement production OAuth, Google Health data syncing, nutrition writeback, DeepSeek Vision, AI Coach model calls, or behavioral experiments in this branch until the preceding external prerequisites and their contract tests are complete. The next plan should be Slice B, starting with Google Health OAuth/identity and storage-backed user isolation.
