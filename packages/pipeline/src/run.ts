/**
 * `pnpm perf:run` — execute the k6 scenarios against a deployed tenant.
 *
 * `PERF_BASE_URL` and `PERF_API_KEY` arrive from the environment: a GitHub
 * Environment fed by Phase.dev in CI, a `.env` or the shell locally. This step
 * only runs k6 and writes its raw summary; turning that into a Run Document is
 * `perf:collect`, so a failed run still leaves a summary to collect from.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { parseFlags, progress, runCli } from "./lib/cli";
import {
  DEFAULT_CONTEXT,
  DEFAULT_SUMMARY,
  display,
  K6_ENTRYPOINT,
  SCENARIOS_PATH,
  SMOKE_SCENARIOS_PATH,
  userPathOr,
} from "./lib/paths";
import { resolveTrigger, writeRunContext } from "./lib/run-context";
import { newRunId } from "./lib/run-document";
import {
  durationSeconds,
  loadScenarioCatalog,
  peakRequestsPerMinute,
} from "./lib/scenarios";
import {
  assertRateBudgetIdle,
  assertWorkloadFitsBudget,
  healthCheck,
  RATE_BUDGET_SAMPLE_GAP_S,
  readBuildInfo,
  resolveTarget,
  sampleRateBudget,
} from "./lib/target";

const HELP = `
pnpm perf:run — run the k6 performance scenarios against a deployed tenant.

Flags:
  --summary <path>   Where k6 writes its raw summary (default ${display(DEFAULT_SUMMARY)})
  --context <path>   Where the run context is written (default ${display(DEFAULT_CONTEXT)})
  --run-id <id>      Override the generated run id
  --catalog <path>   Scenario catalog (default ${display(SCENARIOS_PATH)})
  --smoke            Shorthand for --catalog ${display(SMOKE_SCENARIOS_PATH)}, a
                     two-minute run of the whole pipeline
  --skip-health      Do not preflight the target before offering load
  --allow-shared-key Start even if another client is spending the key's rate
                     budget (the run's notes will say so)
  --help

Environment:
  PERF_BASE_URL     Origin of the deployment to load-test. Falls back to
                    DEMO_TARGET_BASE_URL, then APP_BASE_URL, then NEXT_PUBLIC_APP_URL.
  PERF_API_KEY      Secret key, mk_... Falls back to DEMO_WORKSPACE_API_KEY.
  PERF_ENVIRONMENT  Environment label recorded on the run (default: delivery)
  PERF_DATASET_VERSION  Version of the dataset the tenant holds, if published
  VERCEL_AUTOMATION_BYPASS_SECRET  Protection bypass, for a stage behind Vercel
                    Deployment Protection; sent on every request
  K6_BINARY         Path to the k6 binary (default: k6 on PATH)
`;

/**
 * Two samples of the key's window, a gap apart, and a refusal if anything else
 * is spending it. Returns a note for the run when the operator chose to go
 * ahead regardless, so the record carries the caveat rather than the reader
 * having to guess why the error rate moved.
 */
async function checkRateBudgetIdle(
  target: ReturnType<typeof resolveTarget>,
  health: { rateLimitPerMinute: number | null; rateLimitRemaining: number | null },
  allowShared: boolean,
): Promise<string | null> {
  if (health.rateLimitPerMinute === null || health.rateLimitRemaining === null) {
    process.stderr.write(
      "Note: the target did not report its remaining rate budget, so the preflight cannot "
        + "tell whether another client is using this key.\n",
    );
    return null;
  }

  const first = { limit: health.rateLimitPerMinute, remaining: health.rateLimitRemaining };
  progress(
    `Watching the key's rate budget for ${RATE_BUDGET_SAMPLE_GAP_S}s `
      + `(${first.remaining}/${first.limit} remaining)`,
  );
  await new Promise((resolve) => setTimeout(resolve, RATE_BUDGET_SAMPLE_GAP_S * 1000));
  const second = await sampleRateBudget(target);

  try {
    assertRateBudgetIdle(first, second);
    return null;
  } catch (error) {
    if (!allowShared) throw error;
    const reason = error instanceof Error ? error.message.split("\n")[0]! : String(error);
    process.stderr.write(`Warning: ${reason}\n  Continuing because --allow-shared-key was given.\n`);
    return `started with --allow-shared-key: ${reason}`;
  }
}

function k6Version(binary: string): string | null {
  const result = spawnSync(binary, ["version"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  // "k6 v1.4.0 (commit/..., go1.25.4, linux/amd64)" — the version alone is what
  // makes a k6 upgrade visible as a confounder rather than a silent one.
  return /v?(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1] ?? null;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.has("help")) {
    process.stderr.write(HELP);
    return undefined;
  }

  const target = resolveTarget();
  const catalogPath = userPathOr(
    flags.value("catalog"),
    flags.has("smoke") ? SMOKE_SCENARIOS_PATH : SCENARIOS_PATH,
  );
  const catalog = loadScenarioCatalog(catalogPath);
  const binary = process.env.K6_BINARY?.trim() || "k6";
  const version = k6Version(binary);
  if (version === null) {
    throw new Error(
      `${binary} is not runnable. Install k6 (https://grafana.com/docs/k6/latest/set-up/install-k6/) `
        + "or point K6_BINARY at the binary.",
    );
  }

  if (!existsSync(K6_ENTRYPOINT)) {
    throw new Error(`${display(K6_ENTRYPOINT)} is missing; the workload package is incomplete.`);
  }

  const runId = flags.value("run-id") ?? newRunId();
  const summaryPath = userPathOr(flags.value("summary"), DEFAULT_SUMMARY);
  const contextPath = userPathOr(flags.value("context"), DEFAULT_CONTEXT);
  const startedAt = new Date().toISOString();
  mkdirSync(dirname(summaryPath), { recursive: true });

  const peak = peakRequestsPerMinute(catalog);
  let health = null;
  let sharedKeyNote: string | null = null;
  if (flags.has("skip-health")) {
    assertWorkloadFitsBudget(peak, catalog.requestsPerMinuteBudget, null);
  } else {
    progress(`Preflighting ${target.baseUrl}`);
    health = await healthCheck(target);
    assertWorkloadFitsBudget(
      peak,
      catalog.requestsPerMinuteBudget,
      health.rateLimitPerMinute,
    );
    sharedKeyNote = await checkRateBudgetIdle(target, health, flags.has("allow-shared-key"));
  }

  const build = await readBuildInfo(target);
  const wall = catalog.scenarios.reduce(
    (total, scenario) => total + durationSeconds(scenario.duration) + catalog.settleSeconds,
    0,
  );

  progress(
    `Running ${catalog.scenarios.length} scenarios (workload ${catalog.workloadVersion}) `
      + `against ${target.environment} at ${target.baseUrl} (from ${target.baseUrlSource})\n`
      + `  workspace ${health?.workspaceName ?? "unknown"}, `
      + `build ${build.appSha?.slice(0, 7) ?? "unknown"}, k6 ${version}\n`
      + `  peak ${Math.round(peak)} authenticated req/min against a `
      + `${health?.rateLimitPerMinute ?? catalog.requestsPerMinuteBudget}/min limit, `
      + `~${Math.ceil(wall / 60)} minutes of offered load`,
  );

  // Passed through the child's environment rather than `--env` flags: k6 reads
  // system environment variables into `__ENV`, and argv is world-readable in
  // the process list, which is not where a workspace secret key belongs.
  const k6 = spawnSync(binary, ["run", K6_ENTRYPOINT], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      PERF_BASE_URL: target.baseUrl,
      PERF_API_KEY: target.apiKey,
      PERF_PROTECTION_BYPASS: target.protectionBypassSecret ?? "",
      PERF_RUN_ID: runId,
      PERF_SUMMARY_PATH: summaryPath,
      // Absolute, because k6 resolves `open()` relative to the script.
      PERF_SCENARIOS: catalogPath,
    },
  });

  if (!existsSync(summaryPath)) {
    throw new Error(
      `k6 exited ${k6.status} without writing ${summaryPath}. `
        + "Nothing was measured, so there is nothing to collect.",
    );
  }

  // A non-zero k6 exit means a threshold was crossed, which is a result and not
  // an error: the run is collected, persisted and reported either way. The
  // verdict is `perf:analyze`'s to make.
  const context = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    trigger: resolveTrigger(),
    environment: target.environment,
    baseUrl: target.baseUrl,
    appSha: build.appSha,
    deploymentId: build.deploymentId,
    datasetVersion: target.datasetVersion,
    workloadVersion: catalog.workloadVersion,
    catalogPath,
    // What the platform allowed, not what the catalog hoped for: at light load
    // these numbers mean something different than at high load, and the next
    // reader cannot tell which they are looking at without this.
    rateLimitPerMinute: health?.rateLimitPerMinute ?? null,
    k6Version: version,
    k6ExitCode: k6.status,
    summaryPath,
    notes: sharedKeyNote ? [sharedKeyNote] : [],
  } as const;

  writeRunContext(contextPath, context);
  return { ...context, contextPath, thresholdsBreached: k6.status !== 0 };
}

void runCli(main);
