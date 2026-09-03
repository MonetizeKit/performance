/**
 * The harness reads the target's facts from Phase at run time because the
 * GitHub mirror of a stage silently drops anything past its 100-secret cap.
 * These tests pin the contract: Phase wins, the mirror is the fallback, only the
 * catalogued keys are taken, secrets are masked, and the `GITHUB_ENV` output is
 * exactly what a following step will read back.
 */

import { describe, expect, it } from "vitest";

import {
  describeResolution,
  githubEnvLines,
  maskCommands,
  parsePhaseExport,
  resolveTargetKeys,
  TARGET_KEYS,
} from "../src/lib/phase";

const PHASE = {
  DEMO_WORKSPACE_API_KEY: "mk_live_from_phase",
  DEMO_DATASET_VERSION: "v2",
  NEXT_PUBLIC_APP_URL: "https://app.example.delivery",
  DATABASE_URL: "postgres://never-read",
  SLACK_BOT_TOKEN: "  xoxb-padded  ",
};

const MIRROR = {
  DEMO_WORKSPACE_API_KEY: "mk_live_stale_mirror",
  VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-from-mirror",
  SENDGRID_FROM_EMAIL: "",
  PATH: "/usr/bin",
};

describe("resolveTargetKeys", () => {
  it("prefers Phase, falls back to the environment, and reports what is unset", () => {
    const { resolved, unset } = resolveTargetKeys(PHASE, MIRROR);
    const byName = Object.fromEntries(resolved.map((key) => [key.name, key]));

    expect(byName.DEMO_WORKSPACE_API_KEY).toMatchObject({ value: "mk_live_from_phase", source: "phase" });
    expect(byName.VERCEL_AUTOMATION_BYPASS_SECRET).toMatchObject({
      value: "bypass-from-mirror",
      source: "fallback",
    });
    expect(byName.SLACK_BOT_TOKEN?.value).toBe("xoxb-padded");
    expect(unset).toContain("PERF_API_KEY");
    expect(unset).toContain("SENDGRID_FROM_EMAIL");
  });

  it("takes only the catalogued keys, never the rest of the stage", () => {
    const names = resolveTargetKeys(PHASE, MIRROR).resolved.map((key) => key.name);
    expect(names).not.toContain("DATABASE_URL");
    expect(names).not.toContain("PATH");
    for (const name of names) expect(TARGET_KEYS.map((key) => key.name)).toContain(name);
  });

  it("keeps catalog order so the output is stable", () => {
    const names = resolveTargetKeys(PHASE, MIRROR).resolved.map((key) => key.name);
    const order = TARGET_KEYS.map((key) => key.name);
    expect(names).toEqual(order.filter((name) => names.includes(name)));
  });

  it("works without Phase at all", () => {
    const { resolved } = resolveTargetKeys(null, MIRROR);
    expect(resolved.map((key) => [key.name, key.source])).toEqual([
      ["DEMO_WORKSPACE_API_KEY", "fallback"],
      ["VERCEL_AUTOMATION_BYPASS_SECRET", "fallback"],
    ]);
  });
});

describe("githubEnvLines", () => {
  it("writes heredocs a later step reads back verbatim, including = and newlines", () => {
    const resolution = resolveTargetKeys(
      { PERF_REPORT_RECIPIENTS: "a@example.com,b@example.com", SENDGRID_FROM_NAME: "Perf=Bot\nNightly" },
      {},
    );
    const lines = githubEnvLines(resolution);
    expect(lines).toBe(
      "PERF_REPORT_RECIPIENTS<<__PERF_ENV_EOF__\na@example.com,b@example.com\n__PERF_ENV_EOF__\n"
        + "SENDGRID_FROM_NAME<<__PERF_ENV_EOF__\nPerf=Bot\nNightly\n__PERF_ENV_EOF__\n",
    );
  });

  it("refuses a value that would break out of its heredoc", () => {
    const resolution = resolveTargetKeys({ PERF_BASE_URL: "x __PERF_ENV_EOF__ y" }, {});
    expect(() => githubEnvLines(resolution)).toThrow(/delimiter/);
  });
});

describe("maskCommands and describeResolution", () => {
  const resolution = resolveTargetKeys(PHASE, MIRROR);

  it("masks every secret value and no public one", () => {
    const masks = maskCommands(resolution);
    expect(masks).toContain("::add-mask::mk_live_from_phase");
    expect(masks).toContain("::add-mask::xoxb-padded");
    expect(masks).toContain("::add-mask::bypass-from-mirror");
    expect(masks.join("\n")).not.toContain("https://app.example.delivery");
    expect(masks.join("\n")).not.toContain("v2");
  });

  it("describes sources without values", () => {
    const text = describeResolution(resolution, "Phase Delivery").join("\n");
    expect(text).toMatch(/DEMO_WORKSPACE_API_KEY\s+Phase Delivery/);
    expect(text).toMatch(/VERCEL_AUTOMATION_BYPASS_SECRET\s+GitHub environment/);
    expect(text).toMatch(/PERF_API_KEY\s+unset/);
    expect(text).not.toContain("mk_live");
    expect(text).not.toContain("bypass-from-mirror");
  });
});

describe("parsePhaseExport", () => {
  it("accepts the CLI's flat object and ignores non-string values", () => {
    expect(parsePhaseExport('{"A":"1","B":2,"C":null}')).toEqual({ A: "1" });
  });

  it("explains a non-JSON answer rather than failing to parse", () => {
    expect(() => parsePhaseExport("Error: token expired")).toThrow(/did not return JSON: Error: token expired/);
    expect(() => parsePhaseExport("[]")).toThrow(/key\/value object/);
  });
});
