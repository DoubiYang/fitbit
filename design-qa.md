# Editorial homepage design QA

## Comparison target

- Source visual truth: `/Users/shenyang/.codex/generated_images/01a023a6-a1aa-7193-8795-4c3ce87f776a/exec-6be6cb84-5373-4e97-975f-db9208824f92.png`
- Intended implementation: `http://localhost:3000/rhythm`
- Browser: Codex In-app Browser (the user-selected browser)
- Intended state: authenticated homepage with an eligible recovery/Strain result and body-age estimate.

## Capture evidence

- Source pixels: 853 × 1809.
- Implementation screenshot path: unavailable.
- Implementation CSS viewport / density: unavailable from the in-app browser surface.
- Actual captured application state: unauthenticated. The browser exposed only `尚未登录` and the account link; it did not expose the editorial homepage or any health metrics.
- Primary-interaction check: the read-only navigation and account link were exposed. No login, profile, or health data was changed for QA.
- Console check: unavailable in the in-app browser surface.

## Findings

- [P1] Authenticated homepage cannot be captured in the selected browser.
  - Evidence: the local `/rhythm` route rendered the unauthenticated state after the clean container rebuild.
  - Impact: the visible surface does not match the selected editorial reference, so typography, spacing, warm-white/sage tokens, the body-age placement, timeline labels, and responsive behavior cannot be truthfully compared.
  - Fix: authenticate in the in-app browser, then capture the same authenticated route at 320px, 390 × 844px, 768px, and 1440px. Compare the 390px capture side-by-side with the source image before declaring visual QA passed.

## Required fidelity surfaces

- Fonts and typography: blocked; the intended homepage content was not available.
- Spacing and layout rhythm: blocked; the intended homepage content was not available.
- Colors and visual tokens: blocked; the intended homepage content was not available.
- Image quality and asset fidelity: no new image asset was added; the reference is still the visual target. Page comparison is blocked.
- Copy and content: the unauthenticated copy is not the target authenticated state; homepage copy comparison is blocked.

## Comparison history

1. 2026-09-03 — Clean local containers rebuilt. Opened `/rhythm` in the user-selected in-app browser. The page was unauthenticated, so no same-state source/implementation screenshot pair could be made.

## Implementation checklist

1. Sign in in the in-app browser without altering health data.
2. Capture the authenticated homepage at the required breakpoints.
3. Put the 390px capture and source image into the same comparison input; resolve P0/P1/P2 differences.
4. Update this report with screenshot paths, viewport/density, interaction checks, and `final result: passed` only after a same-state visual comparison.

final result: blocked
