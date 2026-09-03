/**
 * `pnpm perf:analyze` — judge a Run Document against the recent history and
 * attribute any delta to what shipped.
 *
 * Reads the `perf-data` branch but never writes it; publishing is `perf:persist`.
 * Keeping the verdict separate from the write means the verdict can be recomputed
 * — after a baseline rule changes, say — without rewriting history.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { attribute, readChangeSetPayload } from "./lib/attribution";
import { analyzeBaseline, offenders, statusFrom } from "./lib/baseline";
import { parseFlags, progress, runCli } from "./lib/cli";
import { DEFAULT_DOCUMENT, DEFAULT_STORE, display } from "./lib/paths";
import type { RunDocument } from "./lib/run-document";
import { appRepositoryUrl, checkoutStore, createRunner, PerfStore } from "./lib/store";

const HELP = `
pnpm perf:analyze — add baseline verdicts and change-set attribution to a run.

Flags:
  --run <path>         Run Document to analyze in place (default ${display(DEFAULT_DOCUMENT)})
  --store <dir>        Checkout of the perf-data branch (default ${display(DEFAULT_STORE)})
  --no-fetch           Use an existing store checkout as-is, without fetching
  --change-set <path>  Commit-level detail supplied by the application repository
                       (see docs/methodology.md, "Attribution"); without it the
                       run carries the build range and a compare link
  --help

Environment:
  PERF_APP_REPOSITORY_URL  https://github.com/<owner>/<repo> of the application
                           under test, for the compare link
`;

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.has("help")) {
    process.stderr.write(HELP);
    return undefined;
  }

  const documentPath = flags.value("run") ?? DEFAULT_DOCUMENT;
  if (!existsSync(documentPath)) {
    throw new Error(`${documentPath} does not exist; run \`pnpm perf:collect\` first.`);
  }
  const document = JSON.parse(readFileSync(documentPath, "utf8")) as RunDocument;

  const storeDirectory = flags.value("store") ?? DEFAULT_STORE;
  const store =
    flags.has("no-fetch") && existsSync(storeDirectory)
      ? new PerfStore(storeDirectory)
      : checkoutStore({ runner: createRunner(), directory: storeDirectory });

  const history = store.readIndex();
  const analysis = analyzeBaseline(document, history);

  // Attribution compares against the last build that was actually measured in
  // this environment, which is not necessarily the previous commit on the
  // branch: nightly runs skip days when nothing was deployed.
  const payloadPath = flags.value("change-set");
  const changeSet = attribute({
    previousAppSha: store.lastAppSha(document.environment),
    appSha: document.appSha,
    appRepositoryUrl: appRepositoryUrl(),
    payload: payloadPath ? readChangeSetPayload(payloadPath) : null,
  });

  document.baseline = analysis;
  document.changeSet = changeSet;
  document.status = statusFrom(analysis, document.status === "failed");
  if (analysis.forming) {
    document.notes.push(
      `baseline forming: ${analysis.baselineRuns} comparable run(s) so far, so `
        + "verdicts are informational until there are enough to take a median of.",
    );
  }
  if (changeSet.unavailableReason) {
    document.notes.push(`change set unavailable — ${changeSet.unavailableReason}`);
  }

  writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  const regressed = offenders(analysis);
  progress(
    `${document.status.toUpperCase()} — ${analysis.baselineRuns} run baseline, `
      + `${changeSet.detail} since ${changeSet.previousAppSha?.slice(0, 7) ?? "n/a"}`
      + (changeSet.detail === "commits" ? ` (${changeSet.commits.length} commit(s))` : ""),
  );
  for (const scenario of regressed) {
    progress(
      `  ${scenario.verdict}: ${scenario.scenario} p95 ${scenario.p95.toFixed(0)}ms`
        + (scenario.baselineP95 !== null
          ? ` vs baseline ${scenario.baselineP95.toFixed(0)}ms (${((scenario.ratio ?? 1) * 100 - 100).toFixed(0)}%)`
          : "")
        + ` — SLO ${scenario.sloP95Ms}ms`,
    );
  }

  return {
    runId: document.runId,
    status: document.status,
    baselineRuns: analysis.baselineRuns,
    baselineForming: analysis.forming,
    regressions: regressed.map((scenario) => ({
      scenario: scenario.scenario,
      verdict: scenario.verdict,
      p95: scenario.p95,
      baselineP95: scenario.baselineP95,
      ratio: scenario.ratio,
    })),
    changeSet: {
      detail: changeSet.detail,
      previousAppSha: changeSet.previousAppSha,
      compareUrl: changeSet.compareUrl,
      commits: changeSet.commits.length,
      migrations: changeSet.migrations,
      dependencies: changeSet.dependencies.length,
      unavailableReason: changeSet.unavailableReason,
    },
    documentPath,
    storeDirectory,
  };
}

void runCli(main);
