# Editorial Homepage Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline execution selected by the user) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/rhythm` as the selected green mobile editorial homepage while retaining only truthful health-data states and the previously approved body-age position.

**Architecture:** Keep `HomepageTodayView` and all metric/provenance rules unchanged. Recompose `EditorialHomepage` into the reference's header, date/meta, recovery, strain, body-age, and action regions; `StrainTimeline` remains a sanitized observed-data view and renders nothing fabricated when the verified projection is absent. Use a project-local raster botanical asset only in the decorative advice-card slot.

**Tech Stack:** Next.js App Router, React server rendering, TypeScript, global CSS, Lucide React, Node test runner, Docker Compose.

---

### Task 1: Lock the selected source structure with a failing UI test

**Files:**
- Modify: `tests/ui/today-dashboard.test.ts`
- Modify: `src/ui/dashboard/editorial-homepage.tsx`

- [ ] **Step 1: Add a failing static-render assertion**

```ts
test('renders the selected editorial mobile hierarchy', () => {
  const html = render();
  assert.match(html, /editorial-home__tagline/);
  assert.match(html, /<time[^>]*dateTime="2026-08-22"[^>]*>2026年08月22日 · 周六<\/time>/);
  assert.match(html, /editorial-quality__summary[^>]*>.*已同步/s);
  assert.match(html, /aria-label="打开账户"/);
  assert.match(html, /editorial-recovery__meter/);
  assert.match(html, /editorial-action__art/);
  assert.match(html, /恢复分数相对你近期个人常态。这只说明趋势。/);
  assert.doesNotMatch(html, /心肺状态：平稳|一次轻松步行|20–30 分钟|预计变化/);
  assert.ok(html.indexOf('editorial-strain') < html.indexOf('body-age-card'));
});

test('derives the date-meta quality badge from live view quality instead of source sample copy', () => {
  const html = render({ metrics: { ...view.metrics, recovery: { ...view.metrics.recovery, quality: 'provisional' } } });
  assert.match(html, /临时数据/);
  assert.doesNotMatch(render(), /临时数据/);
});
```

- [ ] **Step 2: Run the focused test and confirm it fails because the reference structure is absent**

Run: `pnpm test tests/ui/today-dashboard.test.ts`

Expected: FAIL, with the new `editorial-home__tagline` assertion failing.

- [ ] **Step 3: Implement the minimal semantic page structure**

```tsx
<p className="editorial-home__tagline">让身体回到自己的节奏</p>
<a className="editorial-home__profile" href="/rhythm/account" aria-label="打开账户">…</a>
<time className="editorial-home__date-meta" dateTime={view.localDate}>…</time>
```

Use `/rhythm/account` for the reference-matched avatar (the persistent bottom navigation and body-age/data-quality links retain `/rhythm/settings` where a setting action is needed). Format the local civil date and Chinese weekday in a semantic `<time>`; derive its quality badge from `freshness` plus metric quality/status, never hard-code the reference's `临时数据`. Retain the existing `<details>` disclosure, real metric text, route targets, and the no-raw-data allowlist. The advice card must render exactly `view.primaryAction.text`; never copy the reference's sample health claim or exercise prescription into live content.

- [ ] **Step 4: Run the focused test and confirm it passes**

Run: `pnpm test tests/ui/today-dashboard.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the structural change**

```bash
git add tests/ui/today-dashboard.test.ts src/ui/dashboard/editorial-homepage.tsx
git commit -m "feat: align homepage structure with editorial reference"
```

### Task 2: Add the real decorative botanical asset and its consumption test

**Files:**
- Create: `public/images/editorial-home-botanical.png`
- Modify: `tests/ui/today-dashboard.test.ts`
- Modify: `src/ui/dashboard/editorial-homepage.tsx`

- [ ] **Step 1: Add a failing asset/markup assertion**

```ts
assert.match(html, /src="\/images\/editorial-home-botanical\.png"/);
assert.equal(existsSync(new URL('../../public/images/editorial-home-botanical.png', import.meta.url)), true);
```

- [ ] **Step 2: Run the focused test and confirm it fails because the asset is absent**

Run: `pnpm test tests/ui/today-dashboard.test.ts`

Expected: FAIL, with the asset existence assertion failing.

- [ ] **Step 3: Generate and inspect the source-matched artwork**

Use the built-in ImageGen tool for one transparent-background, right-aligned pale-sage watercolor composition: a delicate leafy sprig rising from a low, soft semitransparent sage circular base. It must have no text, logo, frame, rectangular container, or gradient background. Compare the subject's scale, right-edge crop, and whitespace at its final 426px advice-card slot against the selected source before copying the selected output into `public/images/editorial-home-botanical.png`.

- [ ] **Step 4: Place the asset inside the advice card with an empty alt**

```tsx
<img className="editorial-action__art" src="/images/editorial-home-botanical.png" alt="" />
```

- [ ] **Step 5: Run the focused test and confirm it passes**

Run: `pnpm test tests/ui/today-dashboard.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the asset and consuming component**

```bash
git add public/images/editorial-home-botanical.png tests/ui/today-dashboard.test.ts src/ui/dashboard/editorial-homepage.tsx
git commit -m "feat: add editorial homepage botanical artwork"
```

### Task 3: Match the mobile composition and truthful data states

**Files:**
- Modify: `app/globals.css`
- Modify: `src/ui/dashboard/strain-timeline.tsx`
- Modify: `src/ui/dashboard/body-age-card.tsx`
- Modify: `src/ui/shell/app-shell.module.css`
- Test: `tests/ui/today-dashboard.test.ts`

- [ ] **Step 1: Add failing CSS and empty-state assertions**

```ts
assert.match(homepageCss, /\.editorial-recovery__meter\s*\{[^}]*border-radius:\s*50%/s);
assert.match(homepageCss, /\.editorial-action\s*\{[^}]*position:\s*relative/s);
assert.match(html, /覆盖不足，因此没有完整日 Strain。/);
assert.doesNotMatch(html, /预测变化/);
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `pnpm test tests/ui/today-dashboard.test.ts`

Expected: FAIL, because the reference-specific meter/action rules have not been added.

- [ ] **Step 3: Implement the measured mobile layout**

Apply the reference's 426px canvas, 24px horizontal padding, warm-white surface, generous date header, recovery meter plus right-hand copy, divider-led strain section, compact body-age section, and one integrated advice/meal CTA card. Bind the meter arc to `recovery.score / 100`: no score means a neutral track with no coloured progress, never a fixed visual arc. Keep current data unavailable states textual; do not draw a chart or forecast without `strain.timeline`.

- [ ] **Step 4: Style observed timeline and missing-timeline state without inventing health data**

Use the existing sanitized buckets only. Preserve their accessible labels and `observedThrough` caption; when absent, show the verified missing reason rather than a fake trace or a zero. Even when a verified timeline exists, render only its observed buckets—never a dotted forecast, extrapolation, target, or sample value from the visual reference. Retain test coverage for score `null` as `—` and a verified exact zero as `0.0`.

- [ ] **Step 5: Run the focused test and confirm it passes**

Run: `pnpm test tests/ui/today-dashboard.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the visual implementation**

```bash
git add app/globals.css src/ui/dashboard/strain-timeline.tsx src/ui/dashboard/body-age-card.tsx src/ui/shell/app-shell.module.css tests/ui/today-dashboard.test.ts
git commit -m "feat: reproduce editorial homepage composition"
```

### Task 4: Browser design QA and runtime verification

**Files:**
- Modify: `design-qa.md`
- Modify: `docs/superpowers/specs/2026-09-02-editorial-rhythm-homepage-design.md`

- [ ] **Step 1: Run automated verification**

Run: `pnpm test && pnpm run lint && pnpm run build && git diff --check`

Expected: all tests pass, type-check/build pass, and no whitespace errors.

- [ ] **Step 2: Rebuild the local containers and capture the authenticated Chrome homepage**

Run: `docker compose up --build --force-recreate --remove-orphans -d`

First make a read-only capture in the in-app browser when the same page state is available. The signed-in screenshot may then use the existing Chrome `/rhythm` tab because the user expressly selected and logged into Chrome earlier in this task; do not alter OAuth, synchronize health data, or submit any health record. If that prior authorization cannot be confirmed in context or Chrome cannot show the same authenticated view, mark `design-qa.md` blocked and ask the user before accessing it.

- [ ] **Step 3: Compare the actual source and rendered view at the same phone canvas**

Record typography, spacing, colors, image asset, copy, and data-state differences in `design-qa.md`. Verify the recovery arc equals the rendered score when present; verify that the desktop viewport still uses a 426px centred content and bottom-navigation canvas with no obscured content. Resolve all P0/P1/P2 mismatches before marking `final result: passed`; keep any source-versus-live-data content discrepancy explicit.

- [ ] **Step 4: Mark the spec and plan checkboxes, then commit QA artifacts**

```bash
git add design-qa.md docs/superpowers/specs/2026-09-02-editorial-rhythm-homepage-design.md docs/superpowers/plans/2026-09-03-editorial-homepage-fidelity.md
git commit -m "docs: verify editorial homepage fidelity"
```
