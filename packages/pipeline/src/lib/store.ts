/**
 * The performance history store: an orphan `perf-data` branch in this same
 * repository.
 *
 * Chosen over a database table because the history has to outlive any single
 * environment, be readable by anything that can read the repo (the dashboard,
 * a reviewer, a script), and be diffable. An orphan branch keeps it entirely
 * out of the code history, so `perf-data` never appears in a code diff and a
 * nightly commit never touches a release branch.
 *
 * The layout is `runs/<environment>/<day>-<shortSha>-<runId>.json` plus a
 * regenerated `index.ndjson`. Writes are append-only: a run is never rewritten,
 * and failed runs are kept, because "the night the suite could not run" is
 * itself part of the record.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  runDocumentPath,
  toRunSummary,
  type RunDocument,
  type RunSummary,
} from "./run-document";

export const PERF_DATA_BRANCH = "perf-data";
export const INDEX_FILE = "index.ndjson";

type Env = Record<string, string | undefined>;

/**
 * Where the store is served to the public.
 *
 * Run pages use it for their canonical URL, which is what makes a number in a
 * blog post checkable, so it has to be right rather than plausible. In GitHub
 * Actions it is derived from the repository itself — the `perf-data` branch is
 * published by this repository's own Pages site, whose address GitHub fixes as
 * `https://<owner>.github.io/<repo>` — and `PERF_SITE_URL` overrides it for a
 * custom domain. Outside Actions there is nothing to derive from, and a
 * canonical URL pointing somewhere that does not serve the page is worse than
 * none, so it is null.
 */
export function siteUrl(env: Env = process.env): string | null {
  const explicit = env.PERF_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const repository = env.GITHUB_REPOSITORY?.trim();
  if (!repository) return null;
  const [owner, name] = repository.split("/");
  if (!owner || !name) return null;

  // Only github.com Pages have a fixed, derivable address.
  const server = env.GITHUB_SERVER_URL?.trim().replace(/\/+$/, "") || "https://github.com";
  if (server !== "https://github.com") return null;

  const host = `https://${owner.toLowerCase()}.github.io`;
  // A repository named `<owner>.github.io` is served at the host root.
  return name.toLowerCase() === `${owner.toLowerCase()}.github.io` ? host : `${host}/${name}`;
}

/**
 * This repository's web URL, for links to the record and to the workflow run.
 * Null rather than a guess: a wrong link is worse than none.
 */
export function repositoryUrl(env: Env = process.env): string | null {
  const explicit = env.PERF_REPOSITORY_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const repository = env.GITHUB_REPOSITORY?.trim();
  if (!repository) return null;
  const server = env.GITHUB_SERVER_URL?.trim() || "https://github.com";
  return `${server.replace(/\/+$/, "")}/${repository}`;
}

/**
 * The web URL of the application under test — a different repository from this
 * one. Compare links and commit links point there, because that is where the
 * change that moved a number was made. Not derivable: this harness can measure
 * any deployment, so the repository is stated, not assumed.
 */
export function appRepositoryUrl(env: Env = process.env): string | null {
  return env.PERF_APP_REPOSITORY_URL?.trim().replace(/\/+$/, "") || null;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface Runner {
  (command: string, args: readonly string[], cwd?: string): CommandResult;
}

export function createRunner(): Runner {
  return (command, args, cwd) => {
    const result = spawnSync(command, [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: [result.stderr ?? "", result.error?.message ?? ""].join("").trim(),
    };
  };
}

/**
 * A checked-out copy of the store.
 *
 * Deliberately a plain directory rather than a git abstraction: reading the
 * history is by far the most common operation and it should not need git at
 * all. Publishing is a separate, explicit step.
 */
export class PerfStore {
  constructor(readonly root: string) {}

  /** Every run in the index, oldest first. Absent index means empty history. */
  readIndex(): RunSummary[] {
    const path = join(this.root, INDEX_FILE);
    if (!existsSync(path)) return [];

    const runs: RunSummary[] = [];
    for (const [position, line] of readFileSync(path, "utf8").split("\n").entries()) {
      if (line.trim() === "") continue;
      try {
        runs.push(JSON.parse(line) as RunSummary);
      } catch {
        // One malformed line must not make the whole history unreadable; the
        // full documents on disk remain the source of truth for a rebuild.
        process.stderr.write(`${INDEX_FILE}: skipping unparseable line ${position + 1}\n`);
      }
    }
    return runs.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  readRunDocument(path: string): RunDocument {
    return JSON.parse(readFileSync(join(this.root, path), "utf8")) as RunDocument;
  }

  /** The most recent comparable run that recorded a build commit. */
  lastAppSha(environment: string): string | null {
    const runs = this.readIndex()
      .filter((run) => run.environment === environment && run.appSha)
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
    return runs[0]?.appSha ?? null;
  }

  writeRunDocument(document: RunDocument): string {
    const relative = runDocumentPath(document);
    const absolute = join(this.root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    return relative;
  }

  /**
   * Rebuild `index.ndjson` from the documents on disk.
   *
   * Regenerated rather than appended to so that the index can never drift from
   * the records it indexes — a half-written append, or a run restored by hand,
   * is corrected by the next publish.
   */
  rebuildIndex(): RunSummary[] {
    const runsRoot = join(this.root, "runs");
    const documents: RunDocument[] = [];

    if (existsSync(runsRoot)) {
      for (const environment of readdirSync(runsRoot)) {
        const directory = join(runsRoot, environment);
        if (!statSync(directory).isDirectory()) continue;
        for (const file of readdirSync(directory)) {
          if (!file.endsWith(".json")) continue;
          documents.push(
            JSON.parse(readFileSync(join(directory, file), "utf8")) as RunDocument,
          );
        }
      }
    }

    const summaries = documents
      .map(toRunSummary)
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));

    writeFileSync(
      join(this.root, INDEX_FILE),
      summaries.map((summary) => JSON.stringify(summary)).join("\n") + (summaries.length ? "\n" : ""),
      "utf8",
    );
    return summaries;
  }
}

export interface CheckoutOptions {
  runner: Runner;
  /** Working tree to check the branch out into. */
  directory: string;
  repositoryDirectory?: string;
  branch?: string;
  remote?: string;
}

const README = `# Performance history

Machine-written. Every file under \`runs/\` is one performance run, and
\`index.ndjson\` is a regenerated projection of them for time-series readers.

Produced by \`packages/pipeline/src/persist.ts\`; do not edit by hand. This is an
orphan branch and shares no history with the code, so nothing here is ever part
of a code diff. How the numbers are produced: docs/methodology.md on \`main\`.
`;

/**
 * Check the store out into `directory`, creating the branch if this is the
 * first run.
 *
 * A worktree is used rather than switching branches in place so a workflow can
 * publish results without disturbing the checkout its build came from.
 */
export function checkoutStore(options: CheckoutOptions): PerfStore {
  const {
    runner,
    directory,
    repositoryDirectory = process.cwd(),
    branch = PERF_DATA_BRANCH,
    remote = "origin",
  } = options;

  const git = (args: readonly string[], cwd = repositoryDirectory) =>
    runner("git", args, cwd);

  const fetched = git(["fetch", remote, `${branch}:refs/remotes/${remote}/${branch}`]);
  const exists = fetched.status === 0 || git(["rev-parse", "--verify", `${remote}/${branch}`]).status === 0;

  // Remove a worktree left behind by an interrupted run, so a retry is not
  // blocked by its own debris.
  git(["worktree", "remove", "--force", directory]);

  const added = exists
    ? git(["worktree", "add", "--force", "-B", branch, directory, `${remote}/${branch}`])
    : git(["worktree", "add", "--force", "--detach", directory]);

  if (added.status !== 0) {
    throw new Error(`could not check out ${branch} into ${directory}: ${added.stderr}`);
  }

  if (!exists) {
    // First run: an orphan branch, so the history starts clean rather than
    // carrying every code commit.
    const orphan = git(["checkout", "--orphan", branch], directory);
    if (orphan.status !== 0) {
      throw new Error(`could not create the ${branch} branch: ${orphan.stderr}`);
    }
    git(["rm", "-rf", "--quiet", "."], directory);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "README.md"), README, "utf8");
  }

  return new PerfStore(directory);
}

export interface PublishOptions {
  runner: Runner;
  store: PerfStore;
  message: string;
  branch?: string;
  remote?: string;
  authorName?: string;
  authorEmail?: string;
}

export type PublishOutcome =
  | { status: "published"; commit: string }
  | { status: "nothing-to-do" };

export function publishStore(options: PublishOptions): PublishOutcome {
  const {
    runner,
    store,
    message,
    branch = PERF_DATA_BRANCH,
    remote = "origin",
    authorName,
    authorEmail,
  } = options;

  const git = (args: readonly string[]) => runner("git", args, store.root);

  if (authorName) git(["config", "user.name", authorName]);
  if (authorEmail) git(["config", "user.email", authorEmail]);

  git(["add", "-A"]);
  if (git(["diff", "--cached", "--quiet"]).status === 0) {
    return { status: "nothing-to-do" };
  }

  const committed = git(["commit", "-m", message]);
  if (committed.status !== 0) {
    throw new Error(`could not commit performance results: ${committed.stderr}`);
  }

  // The branch is append-only and only ever written by this step, so a
  // straightforward push is enough; a concurrency guard in the workflow keeps
  // two runs from racing.
  const pushed = git(["push", remote, `HEAD:refs/heads/${branch}`]);
  if (pushed.status !== 0) {
    throw new Error(`could not push ${branch}: ${pushed.stderr}`);
  }

  return {
    status: "published",
    commit: git(["rev-parse", "HEAD"]).stdout.trim(),
  };
}
