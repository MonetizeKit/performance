# MonetizeKit performance

Nightly, public, reproducible performance measurements of the
[MonetizeKit](https://monetizekit.com) public API — and the harness that
produces them.

**Results:** [monetizekit.github.io/performance](https://monetizekit.github.io/performance).
Every run has a permanent page; every number on it links to the immutable record
it came from and to the build that produced it.

**Method:** [docs/methodology.md](docs/methodology.md) — what is measured, how,
what the numbers claim and what they do not.

## Why this is public

We sell an API. Its latency is part of the product, so the measurements are
published the way the API documentation is: where a customer can read them, and
where they can be quoted and checked. The harness is published alongside so the
measurements can be reproduced and the method critiqued. It exercises only the
public API with a normal customer key — there is nothing in here a customer
could not do themselves.

## Layout

```
packages/
  api-workload/     the k6 workload: scenario catalog + entrypoint (k6's runtime, plain JS)
  pipeline/         run → collect → analyze → persist → report (Node, TypeScript)
docs/methodology.md
.github/workflows/
  nightly.yml       04:00 UTC: measure, baseline, publish, report
  pages.yml         serve the perf-data branch as the site, on every push to it
  ci.yml            typecheck, lint, unit tests, k6 compile check
```

The `perf-data` branch is the store: an orphan branch holding one JSON record per
run, the regenerated index, and the rendered site. It is written only by
`perf:persist` and never by hand.

## Running it yourself

Requirements: Node 22, [pnpm](https://pnpm.io) 10, [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/)
1.4.0, and a MonetizeKit workspace to measure.

```sh
pnpm install

export PERF_BASE_URL=https://your-deployment.example.com
export PERF_API_KEY=mk_test_...          # a secret key for the workspace under test

pnpm perf:run --smoke     # two-minute version of the workload
pnpm perf:collect         # k6 summary → Run Document (.perf/run.json)
pnpm perf:analyze         # baseline verdict + attribution, from the perf-data history
pnpm perf:persist --dry-run   # stage into a local checkout of perf-data, publish nothing
pnpm perf:report --dry-run --out .perf/report.html
```

Drop `--smoke` for the full seventy-minute nightly workload. Every command
prints progress on stderr and a JSON result on stdout, and `--help` on any of
them lists its flags. `perf:run` preflights the target first and refuses to
offer load if the key is rejected or the workload would exceed the key's rate
limit.

Write scenarios create a probe customer for the run and archive it afterwards;
the usage events they record are not deleted, because on the platform they are
billing records. Point this at a tenant whose history you are willing to grow.

## Configuration

Set in the `Delivery` GitHub Environment (MonetizeKit syncs them from Phase.dev;
a fork sets them directly). Secrets:

| Secret | Purpose |
|---|---|
| `PERF_BASE_URL` (or `DEMO_TARGET_BASE_URL`, `APP_BASE_URL`, `NEXT_PUBLIC_APP_URL`, first set wins) | Origin of the deployment to measure |
| `PERF_API_KEY` (or `DEMO_WORKSPACE_API_KEY`) | Secret key of the workspace under test |
| `PERF_DATASET_VERSION` (or `DEMO_DATASET_VERSION`) | Version of the seeded dataset; a comparability key. Optional |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Deployment Protection bypass, for a target behind Vercel's login page. Optional |
| `SLACK_PERF_WEBHOOK_URL` | Slack incoming webhook for the nightly post; or |
| `SLACK_BOT_TOKEN` | A Slack bot token with `chat:write` (and `chat:write.public` to post without being invited). Posts to `SLACK_PERF_CHANNEL` |
| `PERF_REPORT_RECIPIENTS`, `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL` | Email delivery |

At least one reporting channel — Slack or email — must be configured; the
report refuses to render into the void.

### Slack

Two ways in; the webhook wins when both are present.

- **Bot token (no setup).** If the workspace already has a Slack app with
  `chat:write` and `chat:write.public`, sync its bot token as `SLACK_BOT_TOKEN`
  and the report posts to `#performance` (or `SLACK_PERF_CHANNEL`) on the first
  night. Without `chat:write.public`, invite the app to the channel once
  (`/invite @<app>`). The Web API answers `200 {"ok":false,"error":...}` on
  failure — `channel_not_found`, `not_in_channel`, `missing_scope` — and the
  report surfaces that string.
- **Incoming webhook.** In <https://api.slack.com/apps> pick the app → *Incoming
  Webhooks* → *Activate* → *Add New Webhook to Workspace* → choose the channel
  → copy the URL into `SLACK_PERF_WEBHOOK_URL`. A webhook is bound to one
  channel; changing channels means a new webhook.

Repository variables (public facts and gates, not secrets):

| Variable | Default | Purpose |
|---|---|---|
| `PERF_NIGHTLY_ENABLED` | off | Enables the schedule. A manual dispatch runs regardless. |
| `PERF_APP_REPOSITORY_URL` | the MonetizeKit application repo | Where compare and commit links point |
| `PERF_SITE_URL` | `https://<owner>.github.io/<repo>` | Canonical origin of the published site; change it only for a custom domain (see below) |
| `SLACK_PERF_CHANNEL` | `#performance` | Where the bot token posts; ignored when a webhook is set |

## Turning it on

1. Configure the `Delivery` environment secrets above.
2. Dispatch **Nightly performance run** with `smoke: true` and `dry_run: true`.
   It measures for two minutes and publishes nothing; read the artifact.
3. Dispatch again with `dry_run: false`. The first push to `perf-data` deploys
   the site.
4. Set `PERF_NIGHTLY_ENABLED=true`.
5. Wait five nights. Verdicts read `baseline-forming` until five comparable runs
   exist; the sixth is the first that can call a regression.

### GitHub Pages

The site is served from the `perf-data` branch by `.github/workflows/pages.yml`,
which deploys with `actions/deploy-pages` rather than from a branch, so Pages
must be set to build from **GitHub Actions**. The workflow does this itself on
first use (`actions/configure-pages` with `enablement: true`). If that step is
ever refused — the workflow token lacks the permission on some plans — turn it on
once by hand, either way below, and the next `perf-data` push publishes:

- **Settings → Pages → Build and deployment → Source: GitHub Actions.** Nothing
  else to pick; there is no branch or folder when the source is Actions.
- Or with the API, using a token that administers the repository:

  ```sh
  gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow
  ```

Either leaves the site at `https://<owner>.github.io/<repo>/`, which is what
`PERF_SITE_URL` defaults to. A run's permalink is `<site>/run/<runId>.html`.

### Custom domain (optional)

Nothing in the harness depends on the address; a custom domain only makes the
permalinks yours. When wanted:

1. **DNS.** For a subdomain such as `perf.example.com`, add a `CNAME` record
   pointing at `<owner>.github.io` (no repository path). For an apex domain use
   `A`/`AAAA` records to GitHub Pages' published addresses instead.
2. **Verify the domain on the organisation** (Organisation settings → Pages →
   Add a domain) so no other account can claim it. GitHub gives you a `TXT`
   record to add; wait for it to verify.
3. **Attach it to the repository:** Settings → Pages → Custom domain, or
   `gh api -X PUT repos/<owner>/<repo>/pages -f cname=perf.example.com`. Tick
   **Enforce HTTPS** once the certificate has been issued (minutes to an hour).
   Because the site is deployed from Actions, do not commit a `CNAME` file to
   `perf-data`; the setting lives in Pages configuration.
4. **Set the variable** `PERF_SITE_URL=https://perf.example.com` so the run
   pages' canonical links, the Slack post and the email cite the new origin.
   Existing permalinks under `<owner>.github.io/<repo>/` keep resolving: GitHub
   redirects them to the custom domain.

## Development

```sh
pnpm check        # typecheck + lint + unit tests, what CI runs
pnpm test         # unit tests only
```

The pipeline is what turns a k6 summary into a number someone will quote, so it
is held to the same standard as application code. Changes to the workload bump
`workloadVersion` in `scenarios.json`; changes to the Run Document shape bump
`RUN_DOCUMENT_SCHEMA_VERSION`.

## Licence

[MIT](LICENSE).
