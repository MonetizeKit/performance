/**
 * `pnpm perf:dashboard` — render the trends page from the store.
 *
 * Runs as part of `perf:persist` so the page can never disagree with the index
 * beside it, and standalone so a regression can be looked at without waiting
 * for a nightly.
 */

import { join } from "node:path";

import { parseFlags, progress, runCli } from "./lib/cli";
import { DASHBOARD_PATH, writeSite } from "./lib/dashboard";
import { DEFAULT_STORE, display, userPathOr } from "./lib/paths";
import { checkoutStore, createRunner, PerfStore, PERF_DATA_BRANCH } from "./lib/store";

const HELP = `
pnpm perf:dashboard — render the performance trends page.

Flags:
  --store <dir>    Checkout of the ${PERF_DATA_BRANCH} branch (default ${display(DEFAULT_STORE)})
  --out <path>     Where to write the page (default <store>/${DASHBOARD_PATH})
  --no-fetch       Use an existing store checkout as-is, without fetching
  --max-runs <n>   Runs to plot per scenario (default 90)
  --help

Environment:
  PERF_SITE_URL             Where results are served (default: derived in Actions)
  PERF_APP_REPOSITORY_URL   Application repository, for commit links
`;

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.has("help")) {
    process.stderr.write(HELP);
    return undefined;
  }

  const storeDirectory = userPathOr(flags.value("store"), DEFAULT_STORE);
  const store = flags.has("no-fetch")
    ? new PerfStore(storeDirectory)
    : checkoutStore({ runner: createRunner(), directory: storeDirectory });

  const outPath = userPathOr(flags.value("out"), join(store.root, DASHBOARD_PATH));
  const result = writeSite(store, { outPath, maxRuns: flags.int("max-runs") });

  progress(`Rendered ${outPath} from ${result.runs} run(s)`);

  return { path: outPath, runs: result.runs };
}

void runCli(main);
