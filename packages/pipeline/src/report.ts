/**
 * `pnpm perf:report` — email the nightly performance report.
 *
 * Runs last, after the result is already persisted, so the email describes a
 * record that exists rather than one that might still fail to be written. It
 * sends on every outcome — pass, regression, and run failure — because a report
 * that only arrives when something is wrong teaches its readers that silence
 * means nothing happened, and silence is exactly what a broken cron looks like.
 *
 * The verdict is carried in the exit code (with `--fail-on-regression`) rather
 * than by skipping the send, so the mail goes out even on the nights the
 * workflow is about to go red.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import sgMail from "@sendgrid/mail";

import { comparableRuns } from "./lib/baseline";
import { parseFlags, progress, runCli } from "./lib/cli";
import { DEFAULT_DOCUMENT, DEFAULT_STORE, display, userPath, userPathOr } from "./lib/paths";
import { renderHtml, renderText, subjectFor, type ReportInput } from "./lib/report";
import { runDocumentPath, type RunDocument } from "./lib/run-document";
import { runPagePath } from "./lib/run-page";
import { exitMessageFor } from "./lib/verdict";
import {
  buildSlackMessage,
  describeSlackDelivery,
  postSlackReport,
  resolveSlackDelivery,
  type SlackDeliveryResult,
} from "./lib/slack";
import {
  PERF_DATA_BRANCH,
  PerfStore,
  checkoutStore,
  createRunner,
  repositoryUrl,
  siteUrl,
} from "./lib/store";

const HELP = `
pnpm perf:report — render and email the performance report for a run.

Flags:
  --run <path>           Analyzed Run Document (default ${display(DEFAULT_DOCUMENT)})
  --store <dir>          Checkout of the perf-data branch (default ${display(DEFAULT_STORE)})
  --no-fetch             Use an existing store checkout as-is, without fetching
  --out <path>           Also write the rendered HTML here, for inspection
  --dry-run              Render only; do not send
  --fail-on-regression   Exit non-zero unless the run passed (regression, SLO
                         breach or run failure); the message says which
  --help

Delivers to every configured channel. At least one is required unless --dry-run;
losing one channel is reported, losing all of them is an error.

Environment:
  SLACK_PERF_WEBHOOK_URL  Slack incoming webhook for the nightly post; or
  SLACK_BOT_TOKEN         Slack bot token (chat:write) posting to
  SLACK_PERF_CHANNEL      this channel (default #performance)
  PERF_REPORT_RECIPIENTS  Comma-separated email recipients
  SENDGRID_API_KEY        Sender credential for email
  SENDGRID_FROM_EMAIL     Sender address (default no-reply@monetizekit.app)
  SENDGRID_FROM_NAME      Sender name (default MonetizeKit)
  PERF_SITE_URL           Where results are served; derived from GITHUB_REPOSITORY
                          (https://<owner>.github.io/<repo>) when unset in Actions
  PERF_DASHBOARD_URL      Trends dashboard link override (default: PERF_SITE_URL)
`;

function recipients(): string[] {
  return (process.env.PERF_REPORT_RECIPIENTS ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address.length > 0);
}

/** The workflow run, so "why did this fail" is one click from the message. */
function workflowUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const repository = repositoryUrl();
  return repository && env.GITHUB_RUN_ID
    ? `${repository}/actions/runs/${env.GITHUB_RUN_ID}`
    : null;
}

interface EmailOutcome {
  delivered: boolean;
  detail?: string;
}

/**
 * Send the mail, reporting failure rather than raising it.
 *
 * Symmetrical with the Slack path: whichever channel breaks, the other still
 * carries the report, and the caller decides what losing one is worth.
 */
async function deliverEmail(input: {
  dryRun: boolean;
  to: string[];
  subject: string;
  text: string;
  html: string;
}): Promise<EmailOutcome> {
  if (input.dryRun) return { delivered: false, detail: "dry run" };

  const apiKey = process.env.SENDGRID_API_KEY?.trim();
  if (!apiKey) return { delivered: false, detail: "SENDGRID_API_KEY is not set" };
  if (input.to.length === 0) {
    return { delivered: false, detail: "PERF_REPORT_RECIPIENTS is empty" };
  }

  try {
    sgMail.setApiKey(apiKey);
    await sgMail.send({
      to: input.to,
      from: {
        email: process.env.SENDGRID_FROM_EMAIL?.trim() || "no-reply@monetizekit.app",
        name: process.env.SENDGRID_FROM_NAME?.trim() || "MonetizeKit",
      },
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
    return { delivered: true };
  } catch (error) {
    return {
      delivered: false,
      detail: error instanceof Error ? error.message.slice(0, 200) : String(error),
    };
  }
}

function describeEmail(outcome: EmailOutcome, count: number): string {
  if (outcome.delivered) return `sent to ${count} recipient(s)`;
  return `not sent (${outcome.detail ?? "unknown"})`;
}

function describeSlack(outcome: SlackDeliveryResult): string {
  if (outcome.delivered) return "posted";
  if (outcome.reason === "not_configured") {
    return `not posted (${outcome.detail ?? "neither SLACK_PERF_WEBHOOK_URL nor SLACK_BOT_TOKEN is set"})`;
  }
  return `not posted (${outcome.detail ?? `HTTP ${outcome.status ?? "error"}`})`;
}

/**
 * Where this run's record lives.
 *
 * Prefers the published permalink page, which is written for a reader — the
 * numbers, the conditions they hold under, and what shipped. Falls back to the
 * raw JSON on the data branch when results are not published anywhere, because
 * a link to the record beats no link at all.
 */
function runUrlFor(document: RunDocument): string | null {
  const site = siteUrl();
  if (site) return `${site}/${runPagePath(document.runId)}`;

  const repository = repositoryUrl();
  return repository
    ? `${repository}/blob/${PERF_DATA_BRANCH}/${runDocumentPath(document)}`
    : null;
}

/** The trends page: the published site when there is one. */
function dashboardUrlFor(): string | null {
  return process.env.PERF_DASHBOARD_URL?.trim() || siteUrl();
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.has("help")) {
    process.stderr.write(HELP);
    return undefined;
  }

  const documentPath = userPathOr(flags.value("run"), DEFAULT_DOCUMENT);
  if (!existsSync(documentPath)) {
    throw new Error(`${documentPath} does not exist; run \`pnpm perf:collect\` first.`);
  }
  const document = JSON.parse(readFileSync(documentPath, "utf8")) as RunDocument;

  if (document.baseline === null) {
    throw new Error(
      `${documentPath} has not been analyzed, so it carries no baseline to report `
        + "against. Run `pnpm perf:analyze` first.",
    );
  }

  const storeDirectory = userPathOr(flags.value("store"), DEFAULT_STORE);
  const store =
    flags.has("no-fetch") && existsSync(storeDirectory)
      ? new PerfStore(storeDirectory)
      : checkoutStore({ runner: createRunner(), directory: storeDirectory });

  // The trend arrows have to compare like with like for the same reason the
  // baseline does, so the report reads the same comparable slice of history.
  const input: ReportInput = {
    document,
    history: comparableRuns(document, store.readIndex()),
    dashboardUrl: dashboardUrlFor(),
    runUrl: runUrlFor(document),
  };

  const subject = subjectFor(document);
  const html = renderHtml(input);
  const text = renderText(input);

  const outputPath = flags.value("out") === undefined ? undefined : userPath(flags.value("out")!);
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, html, "utf8");
  }

  const to = recipients();
  const slackDelivery = resolveSlackDelivery();
  const dryRun = flags.has("dry-run");

  const emailConfigured = Boolean(process.env.SENDGRID_API_KEY?.trim()) && to.length > 0;
  const slackConfigured = slackDelivery !== null;

  if (!dryRun && !emailConfigured && !slackConfigured) {
    throw new Error(
      "the report has nowhere to go: neither email nor Slack is configured.\n"
        + "  Email needs SENDGRID_API_KEY and PERF_REPORT_RECIPIENTS (comma-separated).\n"
        + "  Slack needs SLACK_PERF_WEBHOOK_URL, or SLACK_BOT_TOKEN with SLACK_PERF_CHANNEL (default #performance).\n"
        + "  Both are synced from Phase.dev. Pass --dry-run to render without sending.",
    );
  }

  const slackMessage = buildSlackMessage({
    document,
    dashboardUrl: input.dashboardUrl,
    runUrl: input.runUrl,
    workflowUrl: workflowUrl(),
  });

  // Independent on purpose: a revoked webhook must not cost the email, and a
  // bounced sender must not cost the Slack post. Both are attempted, both are
  // reported, and only losing every channel is fatal.
  const email = await deliverEmail({ dryRun, to, subject, text, html });
  const slack = dryRun
    ? { delivered: false, reason: "not_configured" as const, detail: "dry run" }
    : await postSlackReport(slackMessage, { delivery: slackDelivery });

  if (!dryRun) {
    progress(
      `Email: ${describeEmail(email, to.length)} · Slack: ${describeSlack(slack)}`,
    );
  } else {
    progress(
      `Dry run — not sending. Subject: ${subject}`
        + (slackDelivery ? ` · Slack would go via ${describeSlackDelivery(slackDelivery)}` : ""),
    );
  }

  const attempted = [
    emailConfigured ? email.delivered : null,
    slackConfigured ? slack.delivered : null,
  ].filter((outcome): outcome is boolean => outcome !== null);

  if (!dryRun && attempted.length > 0 && !attempted.some(Boolean)) {
    throw new DeliveryError(email, slack);
  }

  const report = {
    runId: document.runId,
    status: document.status,
    subject,
    delivery: {
      email: {
        configured: emailConfigured,
        delivered: email.delivered,
        recipients: dryRun ? to : to.length,
        ...(email.detail ? { detail: email.detail } : {}),
      },
      slack: {
        configured: slackConfigured,
        delivered: slack.delivered,
        ...(slack.reason ? { reason: slack.reason } : {}),
        ...(slack.detail ? { detail: slack.detail } : {}),
      },
    },
    htmlPath: outputPath ?? null,
    dashboardUrl: input.dashboardUrl,
    runUrl: input.runUrl,
  };

  // The report is out; now let the exit code carry the verdict so a scheduled
  // run goes red on a night it should.
  if (flags.has("fail-on-regression") && document.status !== "passed") {
    throw new PerfVerdictError(document.status, report);
  }

  return report;
}

/**
 * A regression is a result, not a crash, so it prints the report rather than a
 * stack trace — but it still has to fail the job, because a red check is the
 * only signal a scheduled workflow has.
 */
/**
 * Every configured channel failed, so the report reached nobody.
 *
 * Distinct from a performance verdict: the run may have been perfectly fine and
 * the notification path broken. Conflating them would have someone chasing a
 * regression that does not exist, or ignoring a delivery outage as noise.
 */
class DeliveryError extends Error {
  constructor(
    readonly email: EmailOutcome,
    readonly slack: SlackDeliveryResult,
  ) {
    super(
      "the report was rendered but reached nobody — every configured channel failed.\n"
        + `  email: ${email.detail ?? "failed"}\n`
        + `  slack: ${slack.detail ?? slack.reason ?? "failed"}\n`
        + "  The run itself is unaffected and is already persisted.",
    );
    this.name = "DeliveryError";
  }
}

class PerfVerdictError extends Error {
  constructor(
    readonly status: RunDocument["status"],
    readonly report: unknown,
  ) {
    super(exitMessageFor(status));
    this.name = "PerfVerdictError";
  }
}

void runCli(main, {
  describeError: (error) => {
    if (error instanceof DeliveryError) return error.message;
    if (!(error instanceof PerfVerdictError)) return null;
    process.stdout.write(`${JSON.stringify(error.report, null, 2)}\n`);
    return error.message;
  },
});
