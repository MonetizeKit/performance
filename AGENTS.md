# AGENTS.md

## Project overview

Nightly, public, reproducible performance measurements of the MonetizeKit
public API and the harness that produces them. `packages/api-workload/` is the
k6 workload; `packages/pipeline/` is `run -> collect -> analyze -> persist ->
dashboard -> report` (Node, TypeScript). The `perf-data` orphan branch is the
store (one immutable JSON record per run plus the rendered site), written only
by `perf:persist`. Results: <https://monetizekit.github.io/performance>.
Method: `docs/methodology.md`.

## Commands

- `pnpm install --frozen-lockfile`
- `pnpm check` (typecheck + lint + unit tests; what CI runs)
- `pnpm perf:run --smoke`, `pnpm perf:collect`, `pnpm perf:analyze`,
  `pnpm perf:persist --dry-run`, `pnpm perf:report --dry-run` (needs
  `PERF_BASE_URL` and `PERF_API_KEY`)
- Workflows: `nightly.yml` (04:00 UTC measure + report), `pages.yml` (deploy
  `perf-data`), `ci.yml`

## Conventions

- Never write to `perf-data` by hand and never edit a persisted run record.
- The workload uses only the public API with a normal customer key; nothing a
  customer could not do themselves.
- Scenario changes that break comparability get a methodology note and a new
  dataset version, never a silent change.
- This pipeline is the pattern the monorepo's SDLC metrics loop follows
  (`scripts/sdlc-metrics/` there); keep the stage names stable.

## Verifying your work

```
$ pnpm check
packages/pipeline typecheck: Done
packages/api-workload lint: Done
packages/pipeline lint: Done
packages/pipeline test:  Test Files  12 passed (12)
packages/pipeline test:       Tests  192 passed (192)
```

## SDLC and promotion chain

- Branches: `feature/*` -> PR -> `development` -> `delivery` -> `main`. Feature
  PRs target `development`. Promotion between stages is a promotion PR from
  the upstream stage branch (`development -> delivery`, `delivery -> main`);
  where this repository has `.github/workflows/promote.yml`, that workflow
  opens it when the stage gate is green, and `delivery -> main` is always
  merged by a human. Never open a feature PR against `main` or `delivery`.
- Every PR must pass the `Required Checks Gate` job in `.github/workflows/ci.yml`.
  The `Shadow Review (advisory)` job posts a model review comment; it never
  blocks. React with a thumbs-down to dismiss a finding.
- Agent roles, model IDs, tools and autonomy for the whole fleet are declared in
  [`MonetizeKit/.github/agent-policy.json`](https://github.com/MonetizeKit/.github/blob/main/agent-policy.json).
  Never hardcode a model ID in this repository.
- Conventional commits (`feat:`, `fix:`, `chore:`, ...). Position and status live
  in Linear (team `MK`); reference the issue key in the PR body when one exists.
- The fleet-wide plan is
  [`docs/engineering/ai-native-sdlc-plan.md`](https://github.com/MonetizeKit/app-monetizekit-monorepo/blob/main/docs/engineering/ai-native-sdlc-plan.md)
  in the monorepo.
