/**
 * Where things live, anchored to the repository root rather than to the working
 * directory, so every command finds the same catalog, entrypoint and scratch
 * space whether it is run from the root, from inside a package, or from a
 * workflow step.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** The k6 workload package: catalog, smoke catalog and entrypoint. */
export const WORKLOAD_DIR = join(REPO_ROOT, "packages", "api-workload");
export const SCENARIOS_PATH = join(WORKLOAD_DIR, "scenarios.json");
export const SMOKE_SCENARIOS_PATH = join(WORKLOAD_DIR, "scenarios.smoke.json");
export const K6_ENTRYPOINT = join(WORKLOAD_DIR, "main.js");

/** Scratch output of one run: k6 summary, run context, Run Document, report. */
export const WORK_DIR = join(REPO_ROOT, ".perf");
export const DEFAULT_SUMMARY = join(WORK_DIR, "summary.json");
export const DEFAULT_CONTEXT = join(WORK_DIR, "run-context.json");
export const DEFAULT_DOCUMENT = join(WORK_DIR, "run.json");

/** Worktree the `perf-data` branch is checked out into. */
export const DEFAULT_STORE = join(REPO_ROOT, ".perf-data");

/** A path relative to the repository root, for messages and JSON output. */
export function display(path: string): string {
  return path.startsWith(REPO_ROOT) ? path.slice(REPO_ROOT.length + 1) : path;
}

/**
 * Resolve a path the user typed on the command line.
 *
 * `pnpm --filter` runs a package's scripts with the package directory as the
 * working directory, so `--out .perf/report.html` typed at the repository root
 * would otherwise land in `packages/pipeline/.perf/`. pnpm records where it
 * was invoked in `INIT_CWD`; that is the directory the user meant.
 */
export function userPath(path: string, env: Record<string, string | undefined> = process.env): string {
  return resolve(env.INIT_CWD?.trim() || process.cwd(), path);
}

/** `userPath` for an optional flag. */
export function userPathOr(path: string | undefined, fallback: string): string {
  return path === undefined ? fallback : userPath(path);
}
