/**
 * `pnpm perf:collect` — turn k6's raw summary into a Run Document.
 *
 * Split from `perf:run` so that a run which crossed a threshold, or which was
 * interrupted after k6 wrote its summary, still yields a record. The bad nights
 * are the ones worth keeping.
 *
 * No baseline or attribution is added here: this step is a pure translation of
 * what was measured, and needs no access to history.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { parseFlags, progress, runCli } from "./lib/cli";
import { normalizeK6Summary, type K6Summary } from "./lib/k6-summary";
import {
  DEFAULT_CONTEXT,
  DEFAULT_DOCUMENT as DEFAULT_OUTPUT,
  DEFAULT_SUMMARY,
  display,
  userPathOr,
} from "./lib/paths";
import { readRunContext } from "./lib/run-context";
import {
  RUN_DOCUMENT_SCHEMA_VERSION,
  type RunDocument,
} from "./lib/run-document";
import { loadScenarioCatalog, SCENARIOS_PATH } from "./lib/scenarios";

const HELP = `
pnpm perf:collect — normalize a k6 summary into a Run Document.

Flags:
  --summary <path>   k6 summary to read (default: the path in the run context)
  --context <path>   Run context from \`pnpm perf:run\` (default ${display(DEFAULT_CONTEXT)})
  --catalog <path>   Scenario catalog (default: the one the run used)
  --out <path>       Where the Run Document is written (default ${display(DEFAULT_OUTPUT)})
  --help
`;

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.has("help")) {
    process.stderr.write(HELP);
    return undefined;
  }

  const contextPath = userPathOr(flags.value("context"), DEFAULT_CONTEXT);
  if (!existsSync(contextPath)) {
    throw new Error(
      `${contextPath} does not exist. Run \`pnpm perf:run\` first — the run context `
        + "records which build was serving, which k6 measured it, and whether a "
        + "threshold was crossed, none of which can be recovered afterwards.",
    );
  }
  const context = readRunContext(contextPath);

  const summaryPath = userPathOr(flags.value("summary"), context.summaryPath ?? DEFAULT_SUMMARY);
  if (!existsSync(summaryPath)) {
    throw new Error(`${summaryPath} does not exist; k6 wrote no summary to collect.`);
  }

  // The run records which catalog it offered load from, so the collector reads
  // the SLOs that were actually enforced instead of whichever catalog happens
  // to be the default by the time it runs.
  const catalogPath = userPathOr(flags.value("catalog"), context.catalogPath ?? SCENARIOS_PATH);
  const catalog = loadScenarioCatalog(catalogPath);
  if (catalog.workloadVersion !== context.workloadVersion) {
    throw new Error(
      `the workload changed since the run: k6 measured "${context.workloadVersion}" `
        + `but ${catalogPath} declares "${catalog.workloadVersion}". Collect against `
        + "the catalog the run used, or the SLOs recorded would not be the ones enforced.",
    );
  }

  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as K6Summary;
  const normalized = normalizeK6Summary(summary, catalog);

  const notes: string[] = [];
  if (normalized.missing.length > 0) {
    notes.push(
      `k6 produced no data for ${normalized.missing.join(", ")}; `
        + "those scenarios did not run and are absent rather than recorded as zero.",
    );
  }
  if (context.appSha === null) {
    notes.push(
      "the deployment reported no build commit, so this run cannot be attributed "
        + "to a change set.",
    );
  }

  // The run is incomplete if any declared scenario produced nothing. Threshold
  // breaches are a verdict, not a failure, and are left to `perf:analyze`.
  const failed = normalized.missing.length > 0;

  const document: RunDocument = {
    schemaVersion: RUN_DOCUMENT_SCHEMA_VERSION,
    runId: context.runId,
    timestamp: context.startedAt,
    status: failed ? "failed" : "passed",
    trigger: context.trigger,
    environment: context.environment,
    baseUrl: context.baseUrl,
    appSha: context.appSha,
    deploymentId: context.deploymentId,
    datasetVersion: context.datasetVersion,
    workloadVersion: context.workloadVersion,
    rateLimitPerMinute: context.rateLimitPerMinute ?? null,
    k6Version: context.k6Version,
    durationMs: normalized.durationMs,
    thresholdsBreached: normalized.thresholdsBreached || context.k6ExitCode !== 0,
    scenarios: normalized.scenarios,
    baseline: null,
    changeSet: null,
    notes,
  };

  const outputPath = userPathOr(flags.value("out"), DEFAULT_OUTPUT);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  progress(
    `Collected ${Object.keys(document.scenarios).length} scenarios into ${display(outputPath)}`,
  );

  return {
    runId: document.runId,
    status: document.status,
    thresholdsBreached: document.thresholdsBreached,
    scenarios: Object.fromEntries(
      Object.entries(document.scenarios).map(([name, metrics]) => [
        name,
        { p95: metrics.p95, rps: metrics.rps, errorRate: metrics.errorRate, sloPass: metrics.sloPass },
      ]),
    ),
    missing: normalized.missing,
    documentPath: outputPath,
  };
}

void runCli(main);
