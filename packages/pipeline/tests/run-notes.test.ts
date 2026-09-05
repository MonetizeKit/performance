/**
 * `collectNotes` is the seam between the CLI flags `perf:run` accepts and the
 * notes that end up on the run context (and, from there, the run document).
 * It is imported from lib/, not from the perf:run entrypoint, which starts a
 * run on load.
 */

import { describe, expect, it } from "vitest";

import { parseFlags } from "../src/lib/cli";
import { collectNotes } from "../src/lib/run-notes";

describe("collectNotes", () => {
  it("is empty when nothing was said", () => {
    expect(collectNotes(parseFlags([]), null)).toEqual([]);
  });

  it("carries a --note value into the notes array", () => {
    const flags = parseFlags(["--note", "gate-a-pdx1"]);
    expect(collectNotes(flags, null)).toEqual(["gate-a-pdx1"]);
  });

  it("puts the shared-key warning before an operator note", () => {
    const flags = parseFlags(["--note", "gate-a-pdx1"]);
    expect(collectNotes(flags, "started with --allow-shared-key: ...")).toEqual([
      "started with --allow-shared-key: ...",
      "gate-a-pdx1",
    ]);
  });

  it("ignores an empty --note", () => {
    const flags = parseFlags(["--note", ""]);
    expect(collectNotes(flags, null)).toEqual([]);
  });
});
