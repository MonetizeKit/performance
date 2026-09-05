# 2026-09 engine improvement gates

This ledger records one row per "gate" run measured between engine performance
changes to the MonetizeKit API on the Delivery environment. Every row links a
permanent run page. Dispatched gate runs are judged against the nightly
baseline but never enter it.

| Gate | Build | Run | network-floor | platform-baseline | entitlement-check | entitlement-batch | customer-reads | catalog-reads | usage-ingest | usage-ingest-backdated | usage-ingest-batch |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pre-0 (reference) | `f8c4477` | [run](https://monetizekit.github.io/performance/run/20260905T080237Z-2dso5p.html) | 194 / 265 | 190 / 246 | 112 / 168 | 920 / 1000 | 577 / 649 | 430 / 514 | 664 / 778 | 685 / 766 | 1770 / 2310 |
| 0 (baseline) | `962132f` | [run](https://monetizekit.github.io/performance/run/20260905T161348Z-ve1uio.html) | 202 / 246 | 201 / 269 | 815 / 913 | 946 / 1044 | 622 / 709 | 468 / 591 | 718 / 835 | 715 / 815 | 1954 / 2523 |

> entitlement-check in the pre-0 row measured the Vercel CDN, not the API: the
> route sent `Cache-Control: public, max-age=60` at the time and 59 of every 60
> requests were cache hits. Gate 0 is the first row measured after that header
> became `private`.

### Gate 0 — baseline (`962132f`, 2026-09-05 16:13 UTC)

Build: pre-0 plus the `Cache-Control: private` fix on the single entitlement
check (app-monetizekit-monorepo #403). No engine change yet; this row is the
"before" for every phase that follows.

- entitlement-check 112 → 815 ms p50 is the header fix taking effect: the
  scenario now measures the API instead of the CDN. It is not a regression of
  the engine.
- Every other scenario is within 4–15 % of pre-0 at p95; the pre-0 run was at
  08:02 UTC and this one at 16:13 UTC, so the difference is the day-versus-night
  spread of the Delivery database and the runner, not a code change (the two
  builds differ only in the header).
- catalog-reads crossed the regression rule (591 vs 514 ms p95, +15 %, +77 ms)
  on that same-code comparison, which is the first data point on how noisy a
  single run is. Gate D measures this spread properly.
- Status `slo-breach`: 7 of 8 authenticated scenarios exceed their
  floor-relative SLO. Expected — those SLOs describe where we want to be, and
  this row is where we start.

## How to read a row

- Values are k6 p50 / p95 in ms from the GitHub Actions runner (add roughly
  190 ms of runner network floor when comparing with numbers measured from
  elsewhere).
- Gates are dispatched manually with the `label` input so the run page's notes
  name the gate.
- A gate passes when the targeted scenarios improve and no scenario is worse
  than the previous gate by more than the pipeline's own regression rule
  (ratio above 1.10 and more than 20 ms at p95).
