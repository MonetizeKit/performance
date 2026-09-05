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
| A′ (pdx1 + limiter timeout) | `1824545` | [run](https://monetizekit.github.io/performance/run/20260905T195404Z-1d7dlg.html) | 172 / 230 | 169 / 231 | 259 / 336 | 265 / 344 | 254 / 343 | 241 / 343 | 259 / 339 | 257 / 337 | 831 / 1214 |
| B (audit index + after) | `46718d2` | [run](https://monetizekit.github.io/performance/run/20260905T211614Z-ifjakq.html) | 181 / 235 | 175 / 249 | 229 / 307 | 234 / 317 | 222 / 300 | 208 / 278 | 225 / 314 | 229 / 299 | 789 / 1137 |
| C (query reduction) | `0952c11` | [run](https://monetizekit.github.io/performance/run/20260905T223944Z-a5bwna.html) | 114 / 144 | 110 / 151 | 156 / 204 | 163 / 219 | 162 / 219 | 146 / 207 | 150 / 226 | 150 / 206 | 420 / 757 |

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

### Gate A′ — pdx1 plus the bounded limiter timeout (`1824545`, 2026-09-05 19:54 UTC)

Build: Gate A plus app-monetizekit-monorepo #404 (`timeout: 1000` on the
Upstash `Ratelimit`; semantics unchanged). Re-run of Gate A on the fixed build,
so this is the row Phase B is judged against.

p95 versus Gate 0 and Gate A:

| Scenario | Gate 0 | Gate A | Gate A′ | Δ vs 0 | max at A → A′ |
| --- | --- | --- | --- | --- | --- |
| entitlement-check | 913 | 346 | 336 | −63 % | 5301 → 1594 |
| entitlement-batch | 1044 | 361 | 344 | −67 % | 643 → 1311 |
| customer-reads | 709 | 358 | 343 | −52 % | 5231 → 1325 |
| catalog-reads | 591 | 322 | 343 | −42 % | 5226 → 1273 |
| usage-ingest | 835 | 340 | 339 | −59 % | 5327 → 1230 |
| usage-ingest-backdated | 815 | 347 | 337 | −59 % | 5303 → 1278 |
| usage-ingest-batch | 2523 | 5782 | 1214 | −52 % | 5966 → 1849 |
| network-floor | 246 | 301 | 230 | −7 % | 574 → 382 |
| platform-baseline | 269 | 255 | 231 | −14 % | 676 → 630 |

- **Gate rule: passed.** Every scenario is better than Gate 0; nothing is worse
  than Gate A by more than the rule (catalog-reads +21 ms / +6 % at p95 is
  inside it).
- The maxes tell the mechanism: the ~5.2–5.3 s outliers became ~1.2–1.6 s
  ones, which is the new 1000 ms bound plus a normal request. The hang on a
  fresh connection to the us-east-1 Redis is still there; it now costs one
  second instead of five. The Upstash database moving to a us-west region
  (infrastructure, not code) removes both the hang and the ~70 ms cross-country
  round trip that is now the largest single cost in a request.
- usage-ingest-batch p90 983 ms and p99 1820 ms: the tail above p90 is the
  bounded limiter timeout on the one-request-every-6-seconds pattern, not batch
  work. The batch itself (500 events) is 831 ms p50 against 1954 at Gate 0.
- Floor scenarios came back down (network-floor 301 → 230 ms p95) — the +55 ms
  at Gate A was also partly the same hang reaching the unauthenticated path
  through shared instances, not only geometry. Read the floor across several
  nights before drawing conclusions from it.

### Gate B — audit index and bookkeeping after the response (`46718d2`, 2026-09-05 21:16 UTC)

Build: Gate A′ plus app-monetizekit-monorepo #401: a
`(workspaceId, createdAt DESC, id DESC)` index on `audit_log_entries` so the
hash-chain trigger's previous-hash lookup is an index probe, and the per-request
bookkeeping (`recordApiCall`, `lastUsedAt`, `markFirstApiCall`) moved into
`next/server`'s `after()` so it runs once the response is sent instead of on
the critical path.

The trigger query on Delivery, `EXPLAIN (ANALYZE, BUFFERS)` for the demo
workspace, before and after the index:

| | Plan | Rows scanned | Buffers | Execution |
| --- | --- | --- | --- | --- |
| before (54,978 rows in the workspace) | Seq Scan + top-N heapsort | 54,978 | 3,650 shared hits | 37.9 ms |
| after (63,992 rows) | Index Scan on `audit_log_entries_workspaceId_createdAt_id_idx` | 1 | 4 shared hits | 0.049 ms |

That cost was paid, under a per-workspace advisory lock, on every API call, and
it grew with the very traffic being measured (the table gained 9,000 rows
between the two plans, most of them public-API call records).

p95 versus Gate A′:

| Scenario | Gate 0 | Gate A′ | Gate B | Δ vs A′ | Δ vs 0 | p50 A′ → B |
| --- | --- | --- | --- | --- | --- | --- |
| entitlement-check | 913 | 336 | 307 | −9 % | −66 % | 259 → 229 |
| entitlement-batch | 1044 | 344 | 317 | −8 % | −70 % | 265 → 234 |
| customer-reads | 709 | 343 | 300 | −13 % | −58 % | 254 → 222 |
| catalog-reads | 591 | 343 | 278 | −19 % | −53 % | 241 → 208 |
| usage-ingest | 835 | 339 | 314 | −8 % | −62 % | 259 → 225 |
| usage-ingest-backdated | 815 | 337 | 299 | −11 % | −63 % | 257 → 229 |
| usage-ingest-batch | 2523 | 1214 | 1137 | −6 % | −55 % | 831 → 789 |
| network-floor | 246 | 230 | 235 | +2 % | −5 % | 172 → 181 |
| platform-baseline | 269 | 231 | 249 | +7 % | −8 % | 169 → 175 |

- **Gate rule: passed.** Every authenticated scenario improved at p95; nothing
  is worse than Gate A′ beyond the rule (platform-baseline +17 ms / +7 % is
  inside it, and it is the unauthenticated floor — the build changed nothing
  on that path).
- The two read scenarios the phase targeted moved the most, as expected:
  catalog-reads −64 ms and customer-reads −43 ms at p95. Their handlers do the
  least work of any scenario, so the fixed per-request overhead was the largest
  share of their time.
- Authenticated p50s now sit 27–53 ms above the floor (208–234 ms against a
  181 ms floor), down from 65–100 ms at Gate A′ and roughly 400–750 ms at
  Gate 0.
- Status `slo-breach`, but only one scenario: entitlement-check at 307 ms p95
  against a floor-relative target of 256 ms. Seven of eight authenticated
  scenarios now pass their SLO (Gate 0: one of eight).
- One outlier: entitlement-batch max 3518 ms on a single request (p99 534 ms).
  The other maxes are 1.2–1.8 s, the bounded limiter timeout shape described
  at Gate A′. One sample; watch for it at Gate C rather than explain it now.
- The pipeline's own attribution for this run is the compare link
  `1824545...46718d2`, which is exactly #401.

### Gate C — endpoint query reduction (`0952c11`, 2026-09-05 22:39 UTC)

Build: Gate B plus app-monetizekit-monorepo #402: `recordUsageEvent` resolves
customer, meter, entity, prior idempotency key and governing budgets in one
parallel read, reads budgets once per event (or once per group in the batch)
and writes ingestion logs after the response; `checkEntitlements` loads meters
for all limit features in one query, published plans once per batch, and drops
a redundant customer read; composite indexes on `customers (workspaceId,
archivedAt, createdAt)` and `plans (workspaceId, status)`; and the batch route
returns `eventId` per item, sending the full event only on `?include=events`.

p95 versus Gate B:

| Scenario | Gate 0 | Gate B | Gate C | Δ vs B | Δ vs 0 | p50 B → C |
| --- | --- | --- | --- | --- | --- | --- |
| entitlement-check | 913 | 307 | 204 | −34 % | −78 % | 229 → 156 |
| entitlement-batch | 1044 | 317 | 219 | −31 % | −79 % | 234 → 163 |
| customer-reads | 709 | 300 | 219 | −27 % | −69 % | 222 → 162 |
| catalog-reads | 591 | 278 | 207 | −26 % | −65 % | 208 → 146 |
| usage-ingest | 835 | 314 | 226 | −28 % | −73 % | 225 → 150 |
| usage-ingest-backdated | 815 | 299 | 206 | −31 % | −75 % | 229 → 150 |
| usage-ingest-batch | 2523 | 1137 | 757 | −33 % | −70 % | 789 → 420 |
| network-floor | 246 | 235 | 144 | −39 % | −41 % | 181 → 114 |
| platform-baseline | 269 | 249 | 151 | −39 % | −44 % | 175 → 110 |

Read this row with care: the runner's own floor fell by 67 ms at p50
(network-floor 181 → 114 ms) between Gate B and Gate C, on a build that changed
nothing on the unauthenticated path. That is the GitHub runner's network, not
the engine, and it accounts for most of the absolute movement above. The
engine's share is the distance above the floor:

| Scenario | above floor, p50: Gate 0 | A′ | B | C | Δ B→C |
| --- | --- | --- | --- | --- | --- |
| usage-ingest-batch | 1752 | 658 | 608 | 307 | −301 ms (−50 %) |
| usage-ingest-backdated | 513 | 85 | 48 | 36 | −12 ms (−25 %) |
| usage-ingest | 515 | 87 | 44 | 36 | −7 ms (−17 %) |
| entitlement-check | 613 | 87 | 48 | 42 | −5 ms |
| entitlement-batch | 744 | 92 | 53 | 49 | −3 ms |
| customer-reads | 420 | 81 | 41 | 48 | +7 ms |
| catalog-reads | 266 | 69 | 26 | 32 | +6 ms |

- **Gate rule: passed.** Every scenario improved at p95 against Gate B; nothing
  is worse. The scenarios the phase targeted are the ones that moved above the
  floor: the batch ingest halved (500 events now cost ~300 ms of engine time
  against ~1750 ms at Gate 0), and single ingest lost a further quarter of its
  engine time. The read scenarios are flat within a few milliseconds, as the
  plan expected — Phase B had already taken their fixed overhead. No C1/C2
  split is needed: nothing moved the wrong way.
- Entitlements moved least (−3 to −5 ms above floor). The remaining cost on
  that path is the awaited `evaluationLog` write, kept on the request because
  its id is returned to the caller as `evaluationId`; a contract change, not a
  query one, and out of this plan's scope.
- Status `slo-breach`, again on entitlement-check alone: 204 ms p95 against a
  floor-relative target of 189 ms (floor 114 + 75), a 15 ms miss. Seven of
  eight authenticated SLOs pass.
- Outliers: customer-reads max 2392 ms and usage-ingest p99 645 ms, single
  samples each; the Gate B entitlement-batch outlier (3518 ms) did not recur
  (max 1143 ms). The maxes otherwise sit at 1.1–1.4 s, the bounded limiter
  timeout shape.
- Probes from a VM whose own floor did not move (build-info 186 → 193 ms p50)
  agree on the size of the engine change on the single-request paths:
  customers 254 → 234 ms, usage 239 → 231 ms, products 216 → 209 ms,
  entitlement 233 → 231 ms p50.
- Attribution on the run page: compare link `46718d2...0952c11`, exactly #402.

## How to read a row

- Values are k6 p50 / p95 in ms from the GitHub Actions runner (add roughly
  190 ms of runner network floor when comparing with numbers measured from
  elsewhere).
- Gates are dispatched manually with the `label` input so the run page's notes
  name the gate.
- A gate passes when the targeted scenarios improve and no scenario is worse
  than the previous gate by more than the pipeline's own regression rule
  (ratio above 1.10 and more than 20 ms at p95).
