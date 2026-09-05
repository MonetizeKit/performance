# 2026-09 engine improvement gates

This ledger records one row per "gate" run measured between engine performance
changes to the MonetizeKit API on the Delivery environment. Every row links a
permanent run page. Dispatched gate runs are judged against the nightly
baseline but never enter it.

| Gate | Build | Run | network-floor | platform-baseline | entitlement-check | entitlement-batch | customer-reads | catalog-reads | usage-ingest | usage-ingest-backdated | usage-ingest-batch |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pre-0 (reference) | `f8c4477` | [run](https://monetizekit.github.io/performance/run/20260905T080237Z-2dso5p.html) | 194 / 265 | 190 / 246 | 112 / 168 | 920 / 1000 | 577 / 649 | 430 / 514 | 664 / 778 | 685 / 766 | 1770 / 2310 |
| 0 (baseline) | `962132f` | [run](https://monetizekit.github.io/performance/run/20260905T161348Z-ve1uio.html) | 202 / 246 | 201 / 269 | 815 / 913 | 946 / 1044 | 622 / 709 | 468 / 591 | 718 / 835 | 715 / 815 | 1954 / 2523 |
| A (pdx1) | `8575a1f` | [run](https://monetizekit.github.io/performance/run/20260905T175440Z-l7edxj.html) | 180 / 301 | 178 / 255 | 268 / 346 | 278 / 361 | 262 / 358 | 245 / 322 | 265 / 340 | 265 / 347 | 854 / 5782 |

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

### Gate A — functions pinned to pdx1 (`8575a1f`, 2026-09-05 17:54 UTC)

Build: Gate 0 plus `"regions": ["pdx1"]` in `apps/web/vercel.json`
(app-monetizekit-monorepo #400), so the functions run in Oregon next to the
`us-west-2` database instead of in Virginia. The single largest lever in the
plan, and it reads like one.

p95 versus Gate 0:

| Scenario | Gate 0 | Gate A | Δ |
| --- | --- | --- | --- |
| entitlement-check | 913 | 346 | −62 % |
| entitlement-batch | 1044 | 361 | −65 % |
| customer-reads | 709 | 358 | −49 % |
| catalog-reads | 591 | 322 | −46 % |
| usage-ingest | 835 | 340 | −59 % |
| usage-ingest-backdated | 815 | 347 | −57 % |
| usage-ingest-batch | 2523 | 5782 | +129 % (p50 1954 → 854, p90 1117) |
| network-floor | 246 | 301 | +22 % (p50 202 → 180) |
| platform-baseline | 269 | 255 | −5 % |

- Every authenticated scenario now sits 65–100 ms above the runner's floor
  (p50 245–278 ms against a floor of 180 ms). Probes from a VM confirm the
  shape: the API's own in-handler `latencyMs` fell to 34–81 ms per request.
- **Gate rule: not passed as measured.** `usage-ingest-batch` p95 more than
  doubled while its p50 halved, and every other authenticated scenario gained
  exactly one ~5.2 s outlier (max 5.2–5.3 s versus 1.1–2.6 s at Gate 0). The
  audit log's own `latencyMs` for the slow requests reads 5014 ms and 5020 ms:
  the stall is inside the handler and timer-shaped. The rate limiter is built
  without a `timeout`, so `@upstash/ratelimit`'s default of 5000 ms applies;
  the Upstash database is in us-east-1 (configured on Delivery at 14:47 UTC,
  before Gate 0), and from Oregon a fresh connection to it hangs on a few
  percent of requests. Warm connections (the 1 rps scenarios) see it once at
  scenario start; the batch scenario, one request every ~6 s, sees it on ~6 %
  of requests. Reproduced from a VM only with ~7 s idle gaps; not reproducible
  from us-east.
- Fix: app-monetizekit-monorepo #404 bounds the limiter's wait at 1000 ms
  (semantics unchanged — it still fails open, as before). Gate A is re-run on
  that build as "A′" below before Phase B starts. The lasting fix is
  infrastructure: an Upstash database in a us-west region, which also removes
  the ~70 ms cross-country round trip that is now the largest cost left in a
  request.
- network-floor p95 +55 ms (p50 −22 ms): the runner's request now enters at
  the `iad1` edge and hops to the `pdx1` function, so the floor's tail widens
  while the API's work shrinks by far more. This is the geometry the phase
  chose, not an engine change; Phase D makes the floor scenarios
  informational for exactly this reason.

## How to read a row

- Values are k6 p50 / p95 in ms from the GitHub Actions runner (add roughly
  190 ms of runner network floor when comparing with numbers measured from
  elsewhere).
- Gates are dispatched manually with the `label` input so the run page's notes
  name the gate.
- A gate passes when the targeted scenarios improve and no scenario is worse
  than the previous gate by more than the pipeline's own regression rule
  (ratio above 1.10 and more than 20 ms at p95).
