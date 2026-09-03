/**
 * The store is the only durable record of what performance used to be, so the
 * properties worth protecting are that history is never lost and never silently
 * misread: one corrupt line must not hide the rest, and the index must always
 * be rebuildable from the documents themselves.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  INDEX_FILE,
  PerfStore,
  publishStore,
  appRepositoryUrl,
  repositoryUrl,
  siteUrl,
  type CommandResult,
  type Runner,
} from "../src/lib/store";
import {
  runDocumentPath,
  toRunSummary,
} from "../src/lib/run-document";

import { metrics, runDocument } from "./support/fixtures";

function emptyStore(): PerfStore {
  return new PerfStore(mkdtempSync(join(tmpdir(), "perf-store-")));
}

/** Records every git invocation and answers them as configured. */
function fakeRunner(answers: Record<string, CommandResult> = {}): {
  runner: Runner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: Runner = (command, args) => {
    calls.push([command, ...args]);
    const key = args.join(" ");
    return answers[key] ?? { status: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

describe("run document paths", () => {
  it("sorts chronologically in a directory listing and never collides", () => {
    const first = runDocumentPath(runDocument({ runId: "20260830T020000Z-aaaaaa" }));
    const second = runDocumentPath(
      runDocument({
        runId: "20260831T020000Z-bbbbbb",
        timestamp: "2026-08-31T02:00:00.000Z",
      }),
    );

    expect(first).toBe("runs/delivery/2026-08-30-1111111-20260830T020000Z-aaaaaa.json");
    expect(first < second).toBe(true);
  });

  it("keeps a run with no build commit filed rather than unnamed", () => {
    expect(runDocumentPath(runDocument({ appSha: null }))).toContain("-unknown-");
  });
});

describe("reading history", () => {
  it("treats a missing index as an empty history, not an error", () => {
    expect(emptyStore().readIndex()).toEqual([]);
  });

  it("skips an unparseable line and keeps the rest of the history", () => {
    const store = emptyStore();
    const good = toRunSummary(runDocument({ runId: "good" }));
    writeFileSync(
      join(store.root, INDEX_FILE),
      `${JSON.stringify(good)}\n{ truncated\n\n`,
      "utf8",
    );

    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(store.readIndex().map((run) => run.runId)).toEqual(["good"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("line 2"));
    warn.mockRestore();
  });

  it("returns runs oldest first whatever order the file is in", () => {
    const store = emptyStore();
    const early = toRunSummary(runDocument({ runId: "early" }));
    const late = toRunSummary(
      runDocument({ runId: "late", timestamp: "2026-09-01T02:00:00.000Z" }),
    );
    writeFileSync(
      join(store.root, INDEX_FILE),
      `${JSON.stringify(late)}\n${JSON.stringify(early)}\n`,
      "utf8",
    );

    expect(store.readIndex().map((run) => run.runId)).toEqual(["early", "late"]);
  });
});

describe("writing and indexing", () => {
  it("rebuilds the index from the documents on disk, per environment", () => {
    const store = emptyStore();
    store.writeRunDocument(runDocument({ runId: "delivery-1" }));
    store.writeRunDocument(
      runDocument({
        runId: "production-1",
        environment: "production",
        timestamp: "2026-08-31T02:00:00.000Z",
      }),
    );
    // A stray file that is not a run document must not break the rebuild.
    writeFileSync(join(store.root, "runs", "delivery", "notes.txt"), "ignore me", "utf8");

    const index = store.rebuildIndex();

    expect(index.map((run) => run.runId)).toEqual(["delivery-1", "production-1"]);
    expect(readFileSync(join(store.root, INDEX_FILE), "utf8").trimEnd().split("\n")).toHaveLength(2);
  });

  it("carries only the series fields into the index", () => {
    const store = emptyStore();
    store.writeRunDocument(
      runDocument({ scenarios: { "entitlement-check": metrics({ p95: 111, p99: 222 }) } }),
    );

    const entry = store.rebuildIndex()[0]!;

    expect(entry.scenarios["entitlement-check"]).toEqual({
      p95: 111,
      p99: 222,
      rps: 20,
      errorRate: 0,
      sloPass: true,
    });
    expect(entry.path).toBe(runDocumentPath(runDocument()));
  });

  it("regenerating the index corrects a stale one rather than appending to it", () => {
    const store = emptyStore();
    writeFileSync(join(store.root, INDEX_FILE), '{"runId":"ghost"}\n', "utf8");
    store.writeRunDocument(runDocument({ runId: "real" }));

    expect(store.rebuildIndex().map((run) => run.runId)).toEqual(["real"]);
  });

  it("finds the last measured build for one environment only", () => {
    const store = emptyStore();
    store.writeRunDocument(runDocument({ runId: "older", appSha: "aaa" }));
    store.writeRunDocument(
      runDocument({
        runId: "newer",
        appSha: "bbb",
        timestamp: "2026-08-31T02:00:00.000Z",
      }),
    );
    store.writeRunDocument(
      runDocument({
        runId: "prod",
        environment: "production",
        appSha: "ccc",
        timestamp: "2026-09-02T02:00:00.000Z",
      }),
    );
    store.rebuildIndex();

    expect(store.lastAppSha("delivery")).toBe("bbb");
    expect(store.lastAppSha("production")).toBe("ccc");
    expect(store.lastAppSha("staging")).toBeNull();
  });

  it("skips runs that recorded no build commit when looking for a comparison point", () => {
    const store = emptyStore();
    store.writeRunDocument(runDocument({ runId: "attributed", appSha: "aaa" }));
    store.writeRunDocument(
      runDocument({
        runId: "unattributed",
        appSha: null,
        timestamp: "2026-08-31T02:00:00.000Z",
      }),
    );
    store.rebuildIndex();

    expect(store.lastAppSha("delivery")).toBe("aaa");
  });
});

describe("publishing", () => {
  it("does nothing when the run is already committed", () => {
    const store = emptyStore();
    mkdirSync(join(store.root, "runs"), { recursive: true });
    // `diff --cached --quiet` exiting 0 means there is nothing staged.
    const { runner, calls } = fakeRunner();

    const outcome = publishStore({ runner, store, message: "perf: nothing new" });

    expect(outcome).toEqual({ status: "nothing-to-do" });
    expect(calls.some((call) => call.includes("push"))).toBe(false);
  });

  it("commits and pushes the branch when there is something new", () => {
    const store = emptyStore();
    const { runner, calls } = fakeRunner({
      "diff --cached --quiet": { status: 1, stdout: "", stderr: "" },
      "rev-parse HEAD": { status: 0, stdout: "deadbeef\n", stderr: "" },
    });

    const outcome = publishStore({
      runner,
      store,
      message: "perf(delivery): 2026-08-30",
      authorName: "bot",
      authorEmail: "bot@example.com",
    });

    expect(outcome).toEqual({ status: "published", commit: "deadbeef" });
    expect(calls).toContainEqual(["git", "commit", "-m", "perf(delivery): 2026-08-30"]);
    expect(calls).toContainEqual(["git", "push", "origin", "HEAD:refs/heads/perf-data"]);
  });

  it("fails loudly when the push is rejected", () => {
    const store = emptyStore();
    const { runner } = fakeRunner({
      "diff --cached --quiet": { status: 1, stdout: "", stderr: "" },
      "push origin HEAD:refs/heads/perf-data": {
        status: 1,
        stdout: "",
        stderr: "non-fast-forward",
      },
    });

    // Silently dropping a push would leave the run measured but unrecorded, and
    // the next night's baseline would never know it existed.
    expect(() => publishStore({ runner, store, message: "perf" })).toThrow(
      /non-fast-forward/,
    );
  });
});

describe("repositoryUrl", () => {
  it("prefers an explicit override", () => {
    expect(
      repositoryUrl({
        PERF_REPOSITORY_URL: "https://example.com/acme/repo/",
        GITHUB_REPOSITORY: "other/repo",
      }),
    ).toBe("https://example.com/acme/repo");
  });

  it("derives the URL from the GitHub Actions environment", () => {
    expect(
      repositoryUrl({
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "acme/monetizekit",
      }),
    ).toBe("https://github.com/acme/monetizekit");
  });

  it("returns null rather than linking somewhere wrong", () => {
    expect(repositoryUrl({})).toBeNull();
  });
});

describe("siteUrl", () => {
  it("derives the Pages address from the repository publishing the branch", () => {
    // GitHub fixes a project site's address, so in Actions there is nothing to
    // configure: the repository name is the URL.
    expect(siteUrl({ GITHUB_REPOSITORY: "MonetizeKit/performance" })).toBe(
      "https://monetizekit.github.io/performance",
    );
  });

  it("serves a user or organisation site at the host root", () => {
    expect(siteUrl({ GITHUB_REPOSITORY: "Acme/acme.github.io" })).toBe(
      "https://acme.github.io",
    );
  });

  it("lets a custom domain override the derived address", () => {
    expect(
      siteUrl({
        PERF_SITE_URL: "https://perf.example.com/",
        GITHUB_REPOSITORY: "MonetizeKit/performance",
      }),
    ).toBe("https://perf.example.com");
  });

  it("does not guess outside github.com Actions", () => {
    // A canonical URL that does not serve the page is worse than none.
    expect(siteUrl({})).toBeNull();
    expect(
      siteUrl({
        GITHUB_SERVER_URL: "https://github.example.com",
        GITHUB_REPOSITORY: "acme/performance",
      }),
    ).toBeNull();
  });
});

describe("appRepositoryUrl", () => {
  it("is stated, never derived: this harness can measure any deployment", () => {
    expect(appRepositoryUrl({ GITHUB_REPOSITORY: "acme/performance" })).toBeNull();
    expect(
      appRepositoryUrl({ PERF_APP_REPOSITORY_URL: "https://github.com/acme/app/" }),
    ).toBe("https://github.com/acme/app");
  });
});
