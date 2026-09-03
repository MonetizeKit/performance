# Methodology

How the numbers on [monetizekit.github.io/performance](https://monetizekit.github.io/performance)
are produced, what they claim, and what they do not. This document is the
contract behind every run page: if a number is quoted from this site, this is
what it means.

## 1. What is measured

The [MonetizeKit](https://monetizekit.com) public REST API, as deployed to a
non-production Vercel environment (`delivery`), serving a seeded showcase tenant:
one workspace holding ~5,200 customers, a SaaS product and an AI product, and
about ninety days of subscription, usage and credit history, all created through
the same public API a customer would use. The tenant is refreshed nightly by the
application repository's own automation so that it always includes yesterday;
this repository only measures it.

Never production. Load-testing a customer-serving deployment would degrade it,
and seeding it with a synthetic population would be indistinguishable from a
data-integrity incident. The environment is recorded on every run and runs are
only ever compared within one.

## 2. The workload

`packages/api-workload/scenarios.json` is the single definition of the workload,
read by the k6 entrypoint and by every pipeline step, so the SLOs a run records
are provably the SLOs k6 enforced. Eight scenarios:

| Scenario | Path under test | SLO p95 |
|---|---|---|
| `platform-baseline` | Unauthenticated `/api/build-info` | 400ms |
| `entitlement-check` | Single feature check | 120ms |
| `entitlement-batch` | Multi-feature check, one round trip | 200ms |
| `customer-reads` | Paginated list over the full population | 250ms |
| `catalog-reads` | Published products and plans | 200ms |
| `usage-ingest` | Single event stamped at ingest | 150ms |
| `usage-ingest-backdated` | Single event carrying its own `occurredAt` | 150ms |
| `usage-ingest-batch` | Bulk ingest at the 500-item ceiling | 1500ms |

### SLO hypotheses

The SLO values are hypotheses to be confirmed against the first baselines, not
settled contracts. They were chosen from what the paths do — an entitlement
check is one indexed lookup and should be fast; a 500-item batch does 500 inserts
and cannot be — and they will be revised, with a `workloadVersion` bump, once
the history says what the platform actually does.

### Properties that make one night comparable to the next

**Offered load is fixed.** Every scenario is a k6 `constant-arrival-rate`
executor: k6 offers a set request rate regardless of how fast the system
answers, so a slow night shows up as latency rather than as reduced throughput.

**Scenarios run one at a time.** Run together they would contend for the same
database, and each scenario's latency would depend on the others' workloads.
`startTime` offsets and a settling gap between scenarios cost about seventy
minutes of wall time and buy clean attribution.

**Load is capped by the API's own rate limit.** The target key is allowed 100
authenticated requests per rolling minute. The limiter's window does not reset
between scenarios, so the constraint applies to the run as a whole. Authenticated
scenarios therefore run at one request per second and earn their sample counts
from duration: each runs for ten minutes, so a scenario yields 600 samples and
its p95 rests on the slowest thirty of them rather than the slowest six a
two-minute run would offer. Before offering any load, `perf:run` reads the key's
actual `X-RateLimit-Limit` and refuses to start if the workload would exceed it,
because a run full of 429s measures the limiter, not the platform.

This is worth stating plainly: **these numbers measure latency under light
load.** They will catch an added query, a lost index, or a payload that grew.
They will not catch lock contention or a capacity cliff. Raising the ceiling is
a product change on the application side; when it lands the scenarios will be
retuned and `workloadVersion` bumped.

**Writes go to a probe customer created for the run.** Write scenarios only
touch a customer created in k6's `setup()` and archived in `teardown()`, so the
ingest path always writes into an empty event history and its latency is not
quietly inflated by however many earlier runs have accumulated.

**`workloadVersion` guards comparability.** Any change to a scenario's rate,
duration, or the budget changes what is being measured. The version is bumped
and the analyzer starts a fresh baseline population rather than comparing across
incomparable runs. The smoke catalog (`scenarios.smoke.json`) declares its own
version for the same reason: smoke runs can never be averaged into a nightly.

## 3. The pipeline

Five steps, deliberately separate, so a run that dies partway still leaves a
record:

```
perf:run  →  perf:collect  →  perf:analyze  →  perf:persist  →  perf:report
  k6          Run Document     baseline +       perf-data       Slack, email,
  summary                      attribution      branch          exit code
```

| Command | What it does |
|---|---|
| `pnpm perf:run` | Preflight the target and its rate limit, then run k6. Writes the raw summary and a run context. |
| `pnpm perf:collect` | Normalize the k6 summary into a Run Document. |
| `pnpm perf:analyze` | Compare against the baseline, attribute the build range, decide the verdict. |
| `pnpm perf:persist` | Append the Run Document to the `perf-data` branch and re-render the site. |
| `pnpm perf:dashboard` | Render the trends page on its own, without a run. |
| `pnpm perf:report` | Render and deliver the report. `--fail-on-regression` carries the verdict in the exit code. |

The secret key reaches k6 through the child process environment, not `--env`
flags: k6 reads environment variables into `__ENV`, and argv is world-readable
in the process list.

### Re-running steps

| Step | Re-running it |
|---|---|
| `perf:run` | **Not** idempotent, by design. Every invocation is a new measurement with a new run id. |
| `perf:collect` | Idempotent. Same k6 summary in, byte-identical Run Document out. |
| `perf:analyze` | Idempotent for a given store state, and re-runnable: a verdict can be recomputed after a rule changes without rewriting history. |
| `perf:persist` | Idempotent in effect: publishing a run already in the store writes nothing and exits non-zero with an explanation. |
| `perf:dashboard` | Idempotent. Pages are a pure function of immutable documents. |

## 4. The Run Document

One immutable JSON record per run (`packages/pipeline/src/lib/run-document.ts`),
and the only thing downstream steps read. The analyzer compares Run Documents,
the report renders one, the dashboard plots a series of them — so the numbers a
report claims are the numbers that were persisted, not a second derivation from
raw k6 output.

Beyond the per-scenario metrics (avg, min, p50, p90, p95, p99, max, request
count, achieved rps, error rate, SLO result) it records the conditions the
numbers hold under: `environment`, `baseUrl`, `appSha` (the commit the
deployment reported it was built from, read from `/api/build-info`, not from any
checkout), `deploymentId`, `datasetVersion`, `workloadVersion`,
`rateLimitPerMinute`, `k6Version`, `trigger`, the baseline analysis, the change
set, and free-text notes.

## 5. Baselines

A single run's p95 says almost nothing — a cold start, a noisy database
neighbour or one unlucky GC pause all move it. The reference is the **median of
the recent comparable runs**, which is robust to a bad night in a way a mean or
a previous-run comparison is not.

- **Comparable** means same `environment`, `workloadVersion`, `datasetVersion`,
  `trigger === "schedule"`, and not failed. A laptop run over home broadband
  must never move the nightly's reference.
- **Window**: the 14 most recent comparable runs. **Minimum**: 5 — below that,
  verdicts are informational and labelled `baseline-forming`.
- **Regressed**: p95 exceeds the baseline median by more than 1.2× **and** by at
  least 20ms in absolute terms.
- An SLO breach is `slo-breach` regardless of the baseline; a run that could not
  complete stays `failed` whatever the analysis says.

The absolute floor matters. A ratio alone cannot tell a regression from noise on
a fast scenario: a 12ms median moving to 17ms is +48% by ratio and five
milliseconds in reality. A nightly that reports that teaches its readers to
ignore it inside a week, which costs far more than the occasional missed 15ms.

## 6. Attribution

The first question after "something got slower" is "what shipped". Each Run
Document records the build measured by the previous comparable run and the
build measured now, and — when the application repository is stated in
`PERF_APP_REPOSITORY_URL` — a compare link between them. The change set's
`detail` field says how much the run can tell you:

| `detail` | Meaning |
|---|---|
| `same-build` | The deployment is the build measured last time; any movement is environmental. |
| `compare-link` | The build changed. The commits live in the application repository; the compare link is the attribution. |
| `commits` | The application repository supplied commit-level detail (subjects, migrations, dependency moves) via `perf:analyze --change-set <payload>`. |
| `unavailable` | Not even the range is known; `unavailableReason` says why (first run, or the deployment reported no build). |

This harness holds no application source, and the attribution never pretends
otherwise: nothing is inferred from a checkout, and the range is taken from what
the deployment reported about itself.

## 7. The store

An **orphan `perf-data` branch** in this repository, served as the site. Chosen
over a database because the history has to outlive any single environment, be
readable by anything that can read a repository, and be diffable. Being orphan
means a nightly commit never touches the code.

```
perf-data
├── README.md
├── .nojekyll
├── index.html                    # trends dashboard, and the site's landing page
├── index.ndjson                  # compact projection, one line per run
├── run/<runId>.html              # one permalink page per run
└── runs/<environment>/<day>-<shortSha>-<runId>.json
```

Writes are append-only. A run already in the store is never rewritten, and
failed runs are kept, because "the night the suite could not run" is itself part
of the record. `index.ndjson` is regenerated from the documents on every publish
so it can never drift from what it indexes.

A consequence worth internalising: **improving the analyzer does not
retroactively change published verdicts.** A run recorded as regressed under an
older rule keeps saying so, because that is what was reported at the time.

## 8. Permalinks

**Every run has a permanent URL.** Run ids are `<UTC timestamp>-<random
suffix>`, generated once and never reused, so `run/20260901T184518Z-bd9oxc.html`
identifies one measurement for good.

| | |
|---|---|
| Trends dashboard | `<site>/` |
| One run | `<site>/run/<runId>.html` |
| Raw record | `<site>/runs/<environment>/<day>-<sha>-<runId>.json` |
| Whole history | `<site>/index.ndjson` |

Each run page carries a citation block naming the environment, the date, the
build commit, the figure, the dataset version, the workload version and the
rate limit in force; then the full scenario table with the baseline it was
judged against; then what shipped since the last measured build; then a link to
the raw JSON. Quoting "our p95 entitlement check is 42ms" is an assertion.
Linking it to that page is evidence.

The site address is derived from the repository (`https://<owner>.github.io/<repo>`)
so the canonical URL on every page is right without configuration; `PERF_SITE_URL`
overrides it for a custom domain.

## 9. The report

Sent on every outcome — pass, regression, and run failure. A report that only
arrives when something is wrong teaches its readers that silence means nothing
happened, and silence is exactly what a broken cron looks like.

Two channels, independent of each other: Slack for the hour it happens in, email
as the durable record. A revoked webhook must not cost the email and a bounced
sender must not cost the Slack post, so both are attempted, both outcomes are
recorded, and only losing every configured channel is an error — one distinct
from a performance verdict, because "the run regressed" and "nobody was told"
call for different responses.

The report goes out **before** the job is allowed to fail: `--fail-on-regression`
exits non-zero afterwards, so a regression both reaches a person and turns the
check red.

## 10. The dashboard

A **single self-contained HTML file** — inline SVG, no scripts, no external
requests — so it can be opened from a workflow artifact, committed beside the
data, or served from anywhere without the placement decision changing any code.

Small multiples, one chart per scenario, because the scenarios span an order of
magnitude and shared axes would flatten every line that matters into the floor.
Charts start at zero so ordinary jitter reads as jitter. Gaps are drawn as gaps
rather than bridged, since bridging would invent a measurement. Dashed verticals
mark where `workloadVersion` changed.

## 11. The tenant

The showcase tenant is provisioned, seeded and kept current by the
[application repository](https://github.com/MonetizeKit/app-monetizekit-monorepo),
which owns the dataset generator and the seeder and publishes three facts to the
secret store this repository reads from: the target origin, the workspace's API
key, and the dataset version. Runs are only comparable within one dataset
version — a re-seed with a different population is a different thing to measure
— so the seeder's version is a comparability key here, not a label.

When the key is rejected, `perf:run` stops before offering load and the report
says so. Re-keying is the application repository's job; this one measures.

## 12. Known limits

- Light load only, for the reason given in §2. Concurrency behaviour is not
  characterised.
- A single region and a single runner network path (GitHub-hosted Ubuntu). The
  unauthenticated `platform-baseline` scenario carries no query cost, so a move
  there is the network, a cold start or the runner rather than the application;
  read it first when every scenario moves at once.
- Percentiles are k6's, over the scenario's own window; p99 on 600 samples
  rests on six observations and is reported but not judged.
