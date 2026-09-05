/**
 * The Slack post is what gets a regression noticed within the hour, so the
 * properties worth pinning are that the verdict survives being reduced to a
 * notification preview, that the offenders are named rather than buried, and
 * that a broken webhook is reported rather than thrown — losing the report must
 * never cost the run it describes.
 */

import { describe, expect, it } from "vitest";

import {
  buildSlackMessage,
  DEFAULT_SLACK_CHANNEL,
  describeSlackDelivery,
  postSlackReport,
  resolveSlackDelivery,
  resolveSlackWebhookUrl,
  slackHeadline,
  type FetchLike,
} from "../src/lib/slack";
import type { BaselineAnalysis, RunDocument } from "../src/lib/run-document";

import { metrics, runDocument } from "./support/fixtures";

function baseline(overrides: Partial<BaselineAnalysis> = {}): BaselineAnalysis {
  return {
    comparableRuns: 9,
    baselineRuns: 9,
    forming: false,
    regressionRatio: 1.2,
    scenarios: [
      {
        scenario: "entitlement-check",
        p95: 100,
        baselineP95: 96,
        ratio: 1.04,
        sloP95Ms: 120,
        sloP95AboveFloorMs: null,
        floorP50Ms: null,
        sloPass: true,
        informational: false,
        verdict: "pass",
      },
    ],
    ...overrides,
  };
}

const PASSED = runDocument({ baseline: baseline() });

const REGRESSED = runDocument({
  status: "regressed",
  scenarios: {
    "entitlement-check": metrics({ p95: 240 }),
    "catalog-reads": metrics({ p95: 300, sloP95Ms: 200, sloPass: false }),
  },
  baseline: baseline({
    scenarios: [
      {
        scenario: "entitlement-check",
        p95: 240,
        baselineP95: 100,
        ratio: 2.4,
        sloP95Ms: 120,
        sloP95AboveFloorMs: null,
        floorP50Ms: null,
        sloPass: true,
        informational: false,
        verdict: "regressed",
      },
      {
        scenario: "catalog-reads",
        p95: 300,
        baselineP95: 150,
        ratio: 2,
        sloP95Ms: 200,
        sloP95AboveFloorMs: null,
        floorP50Ms: null,
        sloPass: false,
        informational: false,
        verdict: "slo-breach",
      },
    ],
  }),
});

function build(document: RunDocument) {
  return buildSlackMessage({
    document,
    dashboardUrl: "https://perf.example.com",
    runUrl: `https://perf.example.com/run/${document.runId}.html`,
    workflowUrl: "https://github.com/acme/repo/actions/runs/1",
  });
}

describe("the notification fallback", () => {
  it("carries the verdict on its own", () => {
    // This is the text a phone shows and a screen reader reads instead of the
    // blocks, so it has to be useful with no blocks rendered at all.
    expect(build(PASSED).text).toBe("Pass — delivery performance 2026-08-30");
    expect(build(REGRESSED).text).toBe("Regression — delivery performance 2026-08-30");
    expect(build(runDocument({ status: "failed", baseline: baseline() })).text).toBe(
      "Run failed — delivery performance 2026-08-30",
    );
  });
});

describe("slackHeadline", () => {
  it("leads with the regression, counts the SLO misses separately, and names the worst number", () => {
    const headline = slackHeadline(REGRESSED);

    expect(headline).toContain("1 scenario(s) regressed against the baseline");
    expect(headline).toContain("1 scenario(s) missed their SLO");
    expect(headline).toContain("*entitlement-check*");
    expect(headline).toContain("240ms");
    expect(headline).toContain("100ms baseline");
  });

  it("says an SLO miss with no movement is a target miss, not a change", () => {
    const headline = slackHeadline(
      runDocument({
        status: "slo-breach",
        baseline: baseline({
          scenarios: [
            {
              scenario: "usage-ingest",
              p95: 725,
              baselineP95: 720,
              ratio: 1.01,
              sloP95Ms: 245,
              sloP95AboveFloorMs: 150,
              floorP50Ms: 95,
              sloPass: false,
              informational: false,
              verdict: "slo-breach",
            },
          ],
        }),
      }),
    );

    expect(headline).not.toContain("regressed");
    expect(headline).toContain("a target miss, not a change since the last run");
    expect(headline).toContain("245ms (floor 95ms + 150ms) SLO");
  });

  it("says the baseline is still forming rather than implying a comparison", () => {
    const headline = slackHeadline(
      runDocument({ baseline: baseline({ forming: true, baselineRuns: 2 }) }),
    );

    expect(headline).toContain("still forming");
    expect(headline).toContain("2 comparable run(s)");
  });

  it("does not claim numbers for a run that never completed", () => {
    const headline = slackHeadline(runDocument({ status: "failed" }));

    expect(headline).toContain("did not complete");
    expect(headline).toContain("partial");
  });
});

describe("buildSlackMessage", () => {
  it("flags a breach in the table so it is visible without reading numbers", () => {
    const table = JSON.stringify(build(REGRESSED).blocks);

    // "!!" marks what changed; " !" marks a target missed without moving.
    expect(table).toContain("!! entitlement-check");
    expect(table).toContain(" ! catalog-reads");
  });

  it("uses Slack mrkdwn, not standard markdown", () => {
    // `**bold**` renders literally in Slack; the single-asterisk form is the
    // one that works.
    const rendered = JSON.stringify(build(REGRESSED).blocks);

    expect(rendered).not.toContain("**");
    expect(rendered).toContain("*entitlement-check*");
  });

  it("puts what shipped in the message rather than behind a link", () => {
    const rendered = JSON.stringify(
      build(
        runDocument({
          baseline: baseline(),
          changeSet: {
            detail: "commits",
            previousAppSha: "0".repeat(40),
            commits: [{ sha: "abcdef1234", subject: "add an index", author: "Ada" }],
            migrations: ["20260903_add_index"],
            dependencies: [],
            compareUrl: null,
            truncated: false,
            unavailableReason: null,
          },
        }),
      ).blocks,
    );

    expect(rendered).toContain("add an index");
    expect(rendered).toContain("20260903_add_index");
  });

  it("says the build did not change, so a move is read as environmental", () => {
    const rendered = JSON.stringify(
      build(
        runDocument({
          baseline: baseline(),
          changeSet: {
            detail: "same-build",
            previousAppSha: "1".repeat(40),
            commits: [],
            migrations: [],
            dependencies: [],
            compareUrl: null,
            truncated: false,
            unavailableReason: null,
          },
        }),
      ).blocks,
    );

    expect(rendered).toContain("environmental");
  });

  it("links the run, the trends and the workflow", () => {
    const rendered = JSON.stringify(build(PASSED).blocks);

    expect(rendered).toContain("|This run>");
    expect(rendered).toContain("|Trends>");
    expect(rendered).toContain("|Workflow>");
  });

  it("omits links it does not have rather than emitting empty ones", () => {
    const rendered = JSON.stringify(
      buildSlackMessage({
        document: PASSED,
        dashboardUrl: null,
        runUrl: null,
      }).blocks,
    );

    expect(rendered).not.toContain("|This run>");
    expect(rendered).not.toContain("<|");
  });

  it("stays within Slack's 50-block message limit on a wide run", () => {
    const wide = runDocument({
      baseline: baseline({
        scenarios: Array.from({ length: 40 }, (_unused, index) => ({
          scenario: `scenario-${index}`,
          p95: 100,
          baselineP95: 90,
          ratio: 1.1,
          sloP95Ms: 200,
          sloP95AboveFloorMs: null,
          floorP50Ms: null,
          sloPass: true,
          informational: false,
          verdict: "pass" as const,
        })),
      }),
    });

    const message = build(wide);
    expect(message.blocks.length).toBeLessThanOrEqual(50);
    // Rows are capped and the overflow is acknowledged rather than dropped.
    expect(JSON.stringify(message.blocks)).toContain("more on the run page");
  });

  it("keeps every section inside Slack's 3000-character text limit", () => {
    const message = build(REGRESSED);

    for (const block of message.blocks as { text?: { text?: string } }[]) {
      if (block.text?.text) expect(block.text.text.length).toBeLessThanOrEqual(3000);
    }
  });
});

describe("informational scenarios", () => {
  it("lists an informational SLO miss without flagging it as a breach", () => {
    const document = runDocument({
      scenarios: {
        "network-floor": metrics({ p95: 200, sloP95Ms: 100, sloPass: false, informational: true }),
        "entitlement-check": metrics({ p95: 100, sloP95Ms: 120 }),
      },
      baseline: baseline({
        scenarios: [
          {
            scenario: "network-floor",
            p95: 200,
            baselineP95: 190,
            ratio: 1.05,
            sloP95Ms: 100,
            sloP95AboveFloorMs: null,
            floorP50Ms: null,
            sloPass: false,
            informational: true,
            verdict: "informational",
          },
          {
            scenario: "entitlement-check",
            p95: 100,
            baselineP95: 96,
            ratio: 1.04,
            sloP95Ms: 120,
            sloP95AboveFloorMs: null,
            floorP50Ms: null,
            sloPass: true,
            informational: false,
            verdict: "pass",
          },
        ],
      }),
    });

    const message = build(document);
    const table = JSON.stringify(message.blocks);

    expect(message.text).toBe("Pass — delivery performance 2026-08-30");
    expect(table).not.toContain("!! network-floor");
    expect(table).not.toContain(" ! network-floor");
    expect(table).toContain("   network-floor");
  });
});

describe("postSlackReport", () => {
  it("reports a missing webhook instead of throwing", async () => {
    const result = await postSlackReport(build(PASSED), { webhookUrl: null });

    expect(result).toEqual({ delivered: false, reason: "not_configured" });
  });

  it("posts JSON to the webhook", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, body: init.body });
      return { ok: true, status: 200 };
    };

    const result = await postSlackReport(build(PASSED), {
      webhookUrl: "https://hooks.slack.example/abc",
      fetchFn,
    });

    expect(result.delivered).toBe(true);
    expect(calls[0]!.url).toBe("https://hooks.slack.example/abc");
    expect(JSON.parse(calls[0]!.body)).toHaveProperty("blocks");
  });

  it("carries Slack's reason back when it rejects the payload", async () => {
    const fetchFn: FetchLike = async () => ({
      ok: false,
      status: 400,
      text: async () => "invalid_blocks",
    });

    const result = await postSlackReport(build(PASSED), {
      webhookUrl: "https://hooks.slack.example/abc",
      fetchFn,
    });

    expect(result).toMatchObject({
      delivered: false,
      reason: "delivery_failed",
      status: 400,
      detail: "invalid_blocks",
    });
  });

  it("treats an unreachable webhook as a delivery failure, not a crash", async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };

    const result = await postSlackReport(build(PASSED), {
      webhookUrl: "https://hooks.slack.example/abc",
      fetchFn,
    });

    expect(result).toMatchObject({ delivered: false, reason: "delivery_failed" });
    expect(result.detail).toContain("ECONNREFUSED");
  });
});

describe("postSlackReport via a bot token", () => {
  const delivery = { kind: "bot" as const, token: "xoxb-test", channel: "#performance" };

  it("posts to chat.postMessage with the token and channel", async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return { ok: true, status: 200, text: async () => '{"ok":true,"ts":"1.0"}' };
    };

    const result = await postSlackReport(build(PASSED), { delivery, fetchFn });

    expect(result.delivered).toBe(true);
    expect(calls[0]!.url).toBe("https://slack.com/api/chat.postMessage");
    expect(calls[0]!.headers.authorization).toBe("Bearer xoxb-test");
    const body = JSON.parse(calls[0]!.body);
    expect(body.channel).toBe("#performance");
    expect(body).toHaveProperty("blocks");
    expect(body.unfurl_links).toBe(false);
  });

  it("reads the Web API's ok:false as a failure even though the HTTP status is 200", async () => {
    const fetchFn: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => '{"ok":false,"error":"channel_not_found"}',
    });

    const result = await postSlackReport(build(PASSED), { delivery, fetchFn });

    expect(result).toMatchObject({
      delivered: false,
      reason: "delivery_failed",
      status: 200,
      detail: "channel_not_found",
    });
  });
});

describe("resolveSlackDelivery", () => {
  it("prefers the webhook when both are set", () => {
    expect(
      resolveSlackDelivery({
        SLACK_PERF_WEBHOOK_URL: "https://hooks.slack.example/x",
        SLACK_BOT_TOKEN: "xoxb-1",
      }),
    ).toEqual({ kind: "webhook", url: "https://hooks.slack.example/x" });
  });

  it("falls back to the bot token, posting to #performance unless told otherwise", () => {
    expect(resolveSlackDelivery({ SLACK_BOT_TOKEN: " xoxb-1 " })).toEqual({
      kind: "bot",
      token: "xoxb-1",
      channel: DEFAULT_SLACK_CHANNEL,
    });
    expect(
      resolveSlackDelivery({ SLACK_BOT_TOKEN: "xoxb-1", SLACK_PERF_CHANNEL: "#perf-nightly" }),
    ).toEqual({ kind: "bot", token: "xoxb-1", channel: "#perf-nightly" });
  });

  it("is null when nothing is configured", () => {
    expect(resolveSlackDelivery({})).toBeNull();
    expect(resolveSlackDelivery({ SLACK_BOT_TOKEN: "  " })).toBeNull();
  });

  it("names the route for logs", () => {
    expect(describeSlackDelivery({ kind: "webhook", url: "https://x" })).toBe("incoming webhook");
    expect(describeSlackDelivery({ kind: "bot", token: "t", channel: "#performance" })).toBe(
      "bot token → #performance",
    );
  });
});

describe("resolveSlackWebhookUrl", () => {
  it("follows the repo's SLACK_<purpose>_WEBHOOK_URL convention", () => {
    expect(
      resolveSlackWebhookUrl({ SLACK_PERF_WEBHOOK_URL: " https://hooks.slack.example/x " }),
    ).toBe("https://hooks.slack.example/x");
  });

  it("returns null when unset, so delivery degrades rather than guessing", () => {
    expect(resolveSlackWebhookUrl({})).toBeNull();
    expect(resolveSlackWebhookUrl({ SLACK_PERF_WEBHOOK_URL: "  " })).toBeNull();
  });
});
