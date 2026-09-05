# 2026-09 engine improvement gates

This ledger records one row per "gate" run measured between engine performance
changes to the MonetizeKit API on the Delivery environment. Every row links a
permanent run page. Dispatched gate runs are judged against the nightly
baseline but never enter it.

| Gate | Build | Run | network-floor | platform-baseline | entitlement-check | entitlement-batch | customer-reads | catalog-reads | usage-ingest | usage-ingest-backdated | usage-ingest-batch |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pre-0 (reference) | `f8c4477` | [run](https://monetizekit.github.io/performance/run/20260905T080237Z-2dso5p.html) | 194 / 265 | 190 / 246 | 112 / 168 | 920 / 1000 | 577 / 649 | 430 / 514 | 664 / 778 | 685 / 766 | 1770 / 2310 |

> entitlement-check in the pre-0 row measured the Vercel CDN, not the API: the
> route sent `Cache-Control: public, max-age=60` at the time and 59 of every 60
> requests were cache hits. Gate 0 is the first row measured after that header
> became `private`.

## How to read a row

- Values are k6 p50 / p95 in ms from the GitHub Actions runner (add roughly
  190 ms of runner network floor when comparing with numbers measured from
  elsewhere).
- Gates are dispatched manually with the `label` input so the run page's notes
  name the gate.
- A gate passes when the targeted scenarios improve and no scenario is worse
  than the previous gate by more than the pipeline's own regression rule
  (ratio above 1.10 and more than 20 ms at p95).
