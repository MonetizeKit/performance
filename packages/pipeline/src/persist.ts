/**
 * `pnpm perf:persist` — commit a Run Document to the `perf-data` branch.
 *
 * Append-only: a run already in the store is never rewritten, and failed runs
 * are published too. A night the suite could not complete is a fact about the
 * system, and silently dropping it would make the history claim an unbroken
 * record it does not have.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseFlags, progress, runCli } from "./lib/cli";
import { writeSite } from "./lib/dashboard";
import { DEFAULT_DOCUMENT, DEFAULT_STORE, display } from "./lib/paths";
import { runDocumentPath, type RunDocument } from "./lib/run-document";
import { runPagePath } from "./lib/run-page";
import {
  checkoutStore,
  createRunner,
  PerfStore,
  publishStore,
  siteUrl,
  PERF_DATA_BRANCH,
} from "./lib/store";

const HELP = `
pnpm perf:persist — publish a Run Document to the ${PERF_DATA_BRANCH} branch.

Flags:
  --run <path>     Run Document to publish (default ${display(DEFAULT_DOCUMENT)})
  --store <dir>    Checkout of the ${PERF_DATA_BRANCH} branch (default ${display(DEFAULT_STORE)})
  --no-fetch       Use an existing store checkout as-is, without fetching
  --dry-run        Write into the store but neither commit nor push
  --help

Environment:
  PERF_GIT_AUTHOR_NAME   Commit author (default: the checkout's git config)
  PERF_GIT_AUTHOR_EMAIL
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

  const runner = createRunner();
  const storeDirectory = flags.value("store") ?? DEFAULT_STORE;
  const store =
    flags.has("no-fetch") && existsSync(storeDirectory)
      ? new PerfStore(storeDirectory)
      : checkoutStore({ runner, directory: storeDirectory });

  const relative = runDocumentPath(document);
  if (existsSync(join(store.root, relative))) {
    // Overwriting would let a re-analysis quietly restate a measurement. A new
    // run id is the way to record a second opinion.
    throw new AlreadyPublishedError(relative);
  }

  store.writeRunDocument(document);
  const index = store.rebuildIndex();
  // Rendered here rather than in a later step so the pages and the index they
  // read are always published in the same commit.
  const site = writeSite(store);

  if (flags.has("dry-run")) {
    progress(`Dry run: ${relative} staged in ${display(store.root)}, not committed`);
    return {
      status: "dry-run",
      path: relative,
      runPage: runPagePath(document.runId),
      indexEntries: index.length,
      pages: site.pages,
    };
  }

  const outcome = publishStore({
    runner,
    store,
    message:
      `perf(${document.environment}): ${document.status} — ${document.runId}\n\n`
      + `build ${document.appSha?.slice(0, 7) ?? "unknown"}, workload ${document.workloadVersion}, `
      + `dataset ${document.datasetVersion ?? "unknown"}`,
    authorName: process.env.PERF_GIT_AUTHOR_NAME,
    authorEmail: process.env.PERF_GIT_AUTHOR_EMAIL,
  });

  progress(`Published ${relative} to ${PERF_DATA_BRANCH} (${outcome.status})`);

  return {
    status: outcome.status,
    commit: outcome.status === "published" ? outcome.commit : null,
    branch: PERF_DATA_BRANCH,
    path: relative,
    runPage: runPagePath(document.runId),
    permalink: siteUrl() ? `${siteUrl()}/${runPagePath(document.runId)}` : null,
    indexEntries: index.length,
    pages: site.pages,
  };
}

/**
 * A run that is already recorded.
 *
 * Expected rather than exceptional — a retried workflow step reaches here every
 * time — so it reports itself in a sentence instead of a stack trace. It still
 * exits non-zero: the caller asked for something that did not happen.
 */
class AlreadyPublishedError extends Error {
  constructor(readonly path: string) {
    super(
      `${path} is already in the store, so nothing was written.\n`
        + "  Runs are append-only: a measurement that has been reported is never\n"
        + "  restated in place. To record a second opinion, re-run and publish under\n"
        + "  the new run id that produces.",
    );
    this.name = "AlreadyPublishedError";
  }
}

void runCli(main, {
  describeError: (error) =>
    error instanceof AlreadyPublishedError ? error.message : null,
});
