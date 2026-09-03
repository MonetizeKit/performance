/**
 * Attribution never reads the application's source: it has a previous build, a
 * current build, and optionally a payload the application repository chose to
 * send. Every branch of that is exercised here, including the refusal to attach
 * a payload that describes some other range.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  attribute,
  compareUrlFor,
  MAX_COMMITS,
  readChangeSetPayload,
} from "../src/lib/attribution";

const PREVIOUS = "1".repeat(40);
const CURRENT = "2".repeat(40);
const APP_REPO = "https://github.com/acme/monetizekit";

describe("attribute", () => {
  it("records why nothing can be said when the deployment reported no build", () => {
    const changeSet = attribute({ previousAppSha: PREVIOUS, appSha: null, appRepositoryUrl: APP_REPO });

    expect(changeSet.detail).toBe("unavailable");
    expect(changeSet.unavailableReason).toMatch(/did not report a build commit/);
    expect(changeSet.compareUrl).toBeNull();
  });

  it("records why nothing can be said on the first measured build", () => {
    const changeSet = attribute({ previousAppSha: null, appSha: CURRENT, appRepositoryUrl: APP_REPO });

    expect(changeSet.detail).toBe("unavailable");
    expect(changeSet.unavailableReason).toMatch(/no earlier run/);
  });

  it("says plainly when the same build was measured again", () => {
    const changeSet = attribute({ previousAppSha: CURRENT, appSha: CURRENT, appRepositoryUrl: APP_REPO });

    expect(changeSet.detail).toBe("same-build");
    expect(changeSet.unavailableReason).toBeNull();
    expect(changeSet.compareUrl).toBeNull();
  });

  it("attributes a changed build to a compare link into the application repository", () => {
    const changeSet = attribute({ previousAppSha: PREVIOUS, appSha: CURRENT, appRepositoryUrl: APP_REPO });

    expect(changeSet.detail).toBe("compare-link");
    expect(changeSet.previousAppSha).toBe(PREVIOUS);
    expect(changeSet.compareUrl).toBe(`${APP_REPO}/compare/${PREVIOUS}...${CURRENT}`);
    expect(changeSet.commits).toEqual([]);
    expect(changeSet.unavailableReason).toBeNull();
  });

  it("still records the range when the application repository is not stated", () => {
    // The shas are the attribution; the link is a convenience. Without a
    // repository to point at there is no link, but the range is not lost.
    const changeSet = attribute({ previousAppSha: PREVIOUS, appSha: CURRENT, appRepositoryUrl: null });

    expect(changeSet.detail).toBe("compare-link");
    expect(changeSet.compareUrl).toBeNull();
    expect(changeSet.previousAppSha).toBe(PREVIOUS);
  });

  it("carries commit-level detail when the application repository supplies it", () => {
    const changeSet = attribute({
      previousAppSha: PREVIOUS,
      appSha: CURRENT,
      appRepositoryUrl: APP_REPO,
      payload: {
        previousAppSha: PREVIOUS,
        appSha: CURRENT,
        commits: [{ sha: "abc1234", subject: "add an index", author: "Ada" }],
        migrations: ["20260902_b", "20260901_a"],
        dependencies: [
          { name: "zod", from: "3.0.0", to: "3.1.0" },
          { name: "@prisma/client", from: "6.0.0", to: "6.1.0" },
        ],
      },
    });

    expect(changeSet.detail).toBe("commits");
    expect(changeSet.commits).toHaveLength(1);
    expect(changeSet.migrations).toEqual(["20260901_a", "20260902_b"]);
    expect(changeSet.dependencies.map((change) => change.name)).toEqual(["@prisma/client", "zod"]);
    expect(changeSet.compareUrl).toBe(`${APP_REPO}/compare/${PREVIOUS}...${CURRENT}`);
    expect(changeSet.truncated).toBe(false);
  });

  it("truncates a long commit list and says so", () => {
    const commits = Array.from({ length: MAX_COMMITS + 5 }, (_, index) => ({
      sha: index.toString(16).padStart(7, "0"),
      subject: `change ${index}`,
      author: "Ada",
    }));
    const changeSet = attribute({
      previousAppSha: PREVIOUS,
      appSha: CURRENT,
      appRepositoryUrl: APP_REPO,
      payload: { previousAppSha: PREVIOUS, appSha: CURRENT, commits },
    });

    expect(changeSet.commits).toHaveLength(MAX_COMMITS);
    expect(changeSet.truncated).toBe(true);
  });

  it("refuses a payload that describes a different range", () => {
    expect(() =>
      attribute({
        previousAppSha: PREVIOUS,
        appSha: CURRENT,
        appRepositoryUrl: APP_REPO,
        payload: { previousAppSha: "3".repeat(40), appSha: CURRENT, commits: [] },
      }),
    ).toThrow(/refusing to attach/);
  });
});

describe("compareUrlFor", () => {
  it("tolerates a trailing slash on the repository", () => {
    expect(compareUrlFor(`${APP_REPO}/`, PREVIOUS, CURRENT)).toBe(
      `${APP_REPO}/compare/${PREVIOUS}...${CURRENT}`,
    );
    expect(compareUrlFor(null, PREVIOUS, CURRENT)).toBeNull();
  });
});

describe("readChangeSetPayload", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function file(contents: unknown): string {
    const directory = mkdtempSync(join(tmpdir(), "perf-payload-"));
    directories.push(directory);
    const path = join(directory, "change-set.json");
    writeFileSync(path, JSON.stringify(contents), "utf8");
    return path;
  }

  it("reads a payload with the two shas that identify its range", () => {
    const payload = readChangeSetPayload(file({ previousAppSha: PREVIOUS, appSha: CURRENT }));
    expect(payload.previousAppSha).toBe(PREVIOUS);
  });

  it("rejects anything that does not identify a range", () => {
    expect(() => readChangeSetPayload(file({ commits: [] }))).toThrow(/previousAppSha and appSha/);
  });
});
