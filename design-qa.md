# Editorial homepage design QA

## Comparison target

- Source visual truth: user-approved green mobile prototype, `/var/folders/0f/p355cr954d12xjcrf_57scqc0000gn/T/codex-clipboard-90b4257c-cb63-4f47-affa-48f4fdca4210.png` (853 × 1809 pixels, normalized at 2× to the 426 × 905 phone canvas). The subsequent typography/spacing pass uses `/var/folders/0f/p355cr954d12xjcrf_57scqc0000gn/T/codex-clipboard-d19e8bc5-0cb1-4baa-bdc6-4e2323977638.png` as its close-up source.
- Implementation: `http://localhost:3000/rhythm?design-qa=1`.
- Browser/state: the user-selected, already authenticated Chrome profile; real 2026-09-03 health state, not a sample fixture.

## Capture evidence

- Implementation screenshot path: browser-surface capture has no filesystem path; the final authenticated top-of-page capture is retained in this QA turn.
- Implementation CSS viewport / rendered pixels: 426 × 905 / 426 × 905.
- Comparison input: the approved source and the final implementation capture were rendered together in the design-QA conversation context at the normalized phone canvas.
- Runtime: `fitbit-app-1` was rebuilt from the current source and reported `healthy` before capture.
- Primary interactions: the body-age `?` opened the labelled dialog `这个估算从哪里来？`, with a working close button. Account, meal CTA, and all three bottom-navigation destinations expose their intended links; no OAuth, sync, or health record was changed.
- Console check: no warnings or errors.
- Latest visual check: after the typography build was recreated, the authenticated Chrome page was refreshed from the top. The brand, date row, meter/copy pairing, load hierarchy, observed-only trace, and action card were all visible without clipping; the console remained free of warnings and errors.

## Final comparison

- Typography and hierarchy: passed. Brand/tagline, oversized editorial date, compact recovery reading, and large `x.x / 21` load numeral retain the prototype’s ordering and contrast without copying its health claims.
- Spacing and layout rhythm: passed. The recovery/divider/load/chart/action stack now reaches the meal CTA in the first 426 × 905 view; the CTA ends above the fixed bottom navigation rather than being covered by it.
- Colors and assets: passed. Warm-white canvas, deep green controls, muted sage surfaces, thin dividers, Lucide icons, and the single right-aligned botanical asset match the selected visual language.
- Data honesty: passed. The live page shows its actual `正在校准` recovery state, actual observed 5.4/21 cumulative trajectory, and `待补充` body-age state. It does not copy the prototype’s recovery, strain, exercise advice, or forecast.
- Intentional source difference: the source’s short sample recommendation is replaced with the live data-quality action, which can wrap to several lines. This is required to avoid inventing a recommendation while the live quality is provisional.

## Comparison history

1. 2026-09-03 — Initial authenticated capture exposed a 404 botanical asset and an over-tall load chart; the CTA overlapped the fixed navigation.
2. 2026-09-03 — Asset route was corrected for the `/rhythm` base path; the chart and section spacing were reduced. A final 426 × 905 authenticated capture verified the CTA clears the navigation and no P0/P1/P2 fidelity issue remains.
3. 2026-09-03 — A live record had an in-day missing interval. The final Chrome capture shows a muted dashed bridge plus `数据缺口`; the visible text states that it was not counted as load. Console check remained free of warnings and errors.
4. 2026-09-03 — The delayed-input policy was changed to a 24-hour heart-rate/activity-level reconciliation window. One protected local sync completed (`claimed=1`, `succeeded=1`); each of the 11:30 and 11:45 UTC+8 buckets then contained 15 eligible persisted aggregate minutes. A refreshed authenticated Chrome capture showed 6.4/21, observed through 17:41, no bridge at that former in-day gap, and no console warnings/errors.
5. 2026-09-03 — Typography/spacing was compared against the close-up source. The previous display type, recovery ring, and strain numeral were too large/heavy for the selected editorial rhythm. The title/date/section scales and weights were reduced; the recovery meter is now 112px with its centre preserved; the score, divider spacing, and recovery copy inset were tuned. The rebuilt, refreshed authenticated capture has no P0/P1/P2 fidelity issue.

## Gap diagnosis

- Local aggregate evidence: 2026-09-03 11:30–11:59 (UTC+8) had no persisted eligible heart-rate minutes; 11:15–11:29 had only four.
- Read-only upstream recheck: Google Health now returned 399 raw heart-rate points for 11:30–11:44 and 386 for 11:45–11:59. All were parseable, and the existing minute mapper produced both corresponding 15-minute aggregates.
- Conclusion: the absence was local ingestion coverage, not an upstream absence. The exact historical arrival time cannot be reconstructed because raw provider payloads are intentionally never stored. The demonstrated mechanism was the former two-hour incremental heart-rate/activity-level backfill: records arriving after that horizon were not automatically reconciled into older minutes.
- Correction: heart-rate and `activity-level` now use a 24-hour UTC physical overlap after their individual successful watermarks. The one controlled correction sync persisted the missing local aggregates and recomputed the current-day Strain; raw provider payloads remain unpersisted. The dashed bridge remains available for any future verified bracketed gap that is genuinely still missing.

final result: passed
