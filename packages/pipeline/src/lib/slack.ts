/**
 * The nightly performance report, as a Slack message.
 *
 * Email and Slack answer different questions. The mail is the durable record
 * someone reads at 8am and can find again in six months; Slack is where a
 * regression gets noticed within the hour and argued about in a thread. So this
 * is not the email reflowed — it leads with the verdict and the offenders, keeps
 * the table short enough to read on a phone, and links out for everything else.
 *
 * Follows the same shape as `support-escalation.service.ts`: a pure payload
 * builder that is trivially testable, and a delivery function that reports
 * failure rather than throwing, because a webhook being down must never cost us
 * the run it was describing.
 */

import { offenders } from "./baseline";
import { ms, percent } from "./format";
import type { RunDocument, ScenarioComparison } from "./run-document";

/** Commits listed before the message starts linking out instead. */
const MAX_COMMITS = 5;

/** Scenario rows in the table. Beyond this the page is the better read. */
const MAX_ROWS = 10;

export interface SlackReportInput {
  document: RunDocument;
  dashboardUrl: string | null;
  /** Permalink to this run's page, when the results are published. */
  runUrl: string | null;
  /** Link to the workflow run, for the "why did this fail" case. */
  workflowUrl?: string | null;
}

export interface SlackMessage {
  /** Notification and screen-reader fallback; shown instead of the blocks. */
  text: string;
  blocks: unknown[];
}

const VERDICT: Record<RunDocument["status"], { emoji: string; label: string }> = {
  passed: { emoji: ":large_green_circle:", label: "Pass" },
  regressed: { emoji: ":large_yellow_circle:", label: "Regression" },
  failed: { emoji: ":red_circle:", label: "Run failed" },
};

/** One sentence saying what happened. Mirrors the email's headline. */
export function slackHeadline(document: RunDocument): string {
  const regressed = document.baseline ? offenders(document.baseline) : [];

  if (document.status === "failed") {
    return "The run did not complete, so tonight's numbers are partial.";
  }
  if (regressed.length > 0) {
    const worst = regressed[0]!;
    const rest = regressed.length > 1 ? ` (and ${regressed.length - 1} more)` : "";
    return (
      `*${worst.scenario}* is outside tolerance${rest}: p95 ${ms(worst.p95)} against `
      + `${worst.baselineP95 !== null ? `a ${ms(worst.baselineP95)} baseline` : "no baseline yet"}`
      + ` and a ${worst.sloP95Ms}ms SLO.`
    );
  }
  if (document.baseline?.forming) {
    return (
      `Every scenario met its SLO. The baseline is still forming — `
      + `${document.baseline.baselineRuns} comparable run(s) — so nothing is being `
      + "compared against a median yet."
    );
  }
  return "Every scenario met its SLO and stayed within tolerance of its baseline.";
}

/**
 * The scenario table, as a fixed-width code block.
 *
 * Slack has a `table` block, but a message may contain only one and its column
 * behaviour varies by client. A code block is monospaced everywhere, including
 * on mobile and in notification previews, which is what actually keeps latency
 * columns readable.
 */
function table(comparisons: readonly ScenarioComparison[]): string {
  const rows = comparisons.slice(0, MAX_ROWS);
  const width = Math.max(8, ...rows.map((row) => row.scenario.length));

  const lines = rows.map((row) => {
    const flag =
      row.verdict === "slo-breach" ? "!!" : row.verdict === "regressed" ? " !" : "  ";
    return (
      `${flag} ${row.scenario.padEnd(width)}  `
      + `${ms(row.p95).padStart(8)}  `
      + `${(row.baselineP95 !== null ? ms(row.baselineP95) : "—").padStart(8)}  `
      + `${percent(row.ratio).padStart(6)}  `
      + `${`${row.sloP95Ms}ms`.padStart(7)}`
    );
  });

  const header =
    `   ${"scenario".padEnd(width)}  ${"p95".padStart(8)}  `
    + `${"baseline".padStart(8)}  ${"Δ".padStart(6)}  ${"SLO".padStart(7)}`;

  const fence = "```";
  const omitted =
    comparisons.length > MAX_ROWS
      ? `\n_… ${comparisons.length - MAX_ROWS} more on the run page_`
      : "";

  return [fence, header, ...lines, fence].join("\n") + omitted;
}

function changeSetText(document: RunDocument): string | null {
  const changeSet = document.changeSet;
  if (!changeSet) return null;

  switch (changeSet.detail) {
    case "unavailable":
      return `*What shipped:* not available — ${changeSet.unavailableReason ?? "unknown"}.`;
    case "same-build":
      return "*What shipped:* nothing — the same build was measured as last time, so any movement is environmental.";
    case "compare-link":
      return `*What shipped:* the build moved from \`${changeSet.previousAppSha?.slice(0, 7) ?? "?"}\`${
        changeSet.compareUrl ? ` — <${changeSet.compareUrl}|full diff>` : ""
      }.`;
    case "commits":
      break;
    default: {
      const exhaustive: never = changeSet.detail;
      throw new Error(`unhandled change-set detail ${String(exhaustive)}`);
    }
  }

  const commits = changeSet.commits
    .slice(0, MAX_COMMITS)
    .map((commit) => `• \`${commit.sha.slice(0, 7)}\` ${commit.subject} — ${commit.author}`);
  if (changeSet.commits.length > MAX_COMMITS) {
    commits.push(`• …and ${changeSet.commits.length - MAX_COMMITS} more`);
  }
  if (changeSet.migrations.length > 0) {
    commits.push(`• migrations: ${changeSet.migrations.join(", ")}`);
  }

  return ["*What shipped since the last measured build:*", ...commits].join("\n");
}

export function buildSlackMessage(input: SlackReportInput): SlackMessage {
  const { document, dashboardUrl, runUrl, workflowUrl = null } = input;
  const verdict = VERDICT[document.status];
  const day = document.timestamp.slice(0, 10);

  // Carries the verdict on its own: this is what a phone notification shows.
  const text = `${verdict.label} — ${document.environment} performance ${day}`;

  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${verdict.emoji} ${text}`, emoji: true },
    },
    { type: "section", text: { type: "mrkdwn", text: slackHeadline(document) } },
  ];

  const comparisons = document.baseline?.scenarios ?? [];
  if (comparisons.length > 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: table(comparisons) } });
  }

  const shipped = changeSetText(document);
  if (shipped) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: shipped } });
  }

  const links = [
    runUrl ? `<${runUrl}|This run>` : null,
    dashboardUrl ? `<${dashboardUrl}|Trends>` : null,
    workflowUrl ? `<${workflowUrl}|Workflow>` : null,
  ].filter((link): link is string => link !== null);

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: [
          `build \`${document.appSha?.slice(0, 7) ?? "unknown"}\``,
          `dataset ${document.datasetVersion ?? "unknown"}`,
          `workload ${document.workloadVersion}`,
          document.rateLimitPerMinute !== null
            ? `${document.rateLimitPerMinute} req/min allowed`
            : "rate limit unknown",
          ...(links.length > 0 ? [links.join(" · ")] : []),
        ].join("  |  "),
      },
    ],
  });

  return { text, blocks };
}

export type SlackFailureReason = "not_configured" | "delivery_failed";

export interface SlackDeliveryResult {
  delivered: boolean;
  reason?: SlackFailureReason;
  status?: number;
  detail?: string;
}

/** Injectable for tests; the platform `fetch` in production. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text?: () => Promise<string> }>;

export function resolveSlackWebhookUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return env.SLACK_PERF_WEBHOOK_URL?.trim() || null;
}

/**
 * Post the report to Slack.
 *
 * Never throws. A webhook that is unset, revoked or briefly unreachable is a
 * delivery problem, and turning it into an exception would discard the run it
 * was reporting on — the caller decides what an undelivered report is worth.
 */
export async function postSlackReport(
  message: SlackMessage,
  deps: { fetchFn?: FetchLike; webhookUrl?: string | null } = {},
): Promise<SlackDeliveryResult> {
  const webhookUrl =
    deps.webhookUrl === undefined ? resolveSlackWebhookUrl() : deps.webhookUrl;
  if (!webhookUrl) return { delivered: false, reason: "not_configured" };

  const fetchFn = deps.fetchFn ?? (fetch as unknown as FetchLike);
  try {
    const response = await fetchFn(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });

    if (response.ok) return { delivered: true, status: response.status };

    // Slack answers a bad payload with 200-and-an-error-string or a 4xx plus a
    // one-line reason ("invalid_blocks", "no_service"); it is the only clue.
    const detail = await response.text?.().catch(() => undefined);
    return {
      delivered: false,
      reason: "delivery_failed",
      status: response.status,
      ...(detail ? { detail: detail.slice(0, 200) } : {}),
    };
  } catch (error) {
    return {
      delivered: false,
      reason: "delivery_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
