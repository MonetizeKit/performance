/**
 * The nightly performance report.
 *
 * Written to be read on a phone at 8am by someone who has not been following
 * along: the verdict is in the subject, the reason is in the first paragraph,
 * and the change set is right there rather than a link away — because the first
 * question after "something got slower" is always "what shipped".
 *
 * HTML is inline-styled tables. Email clients strip stylesheets, and a report
 * that renders as a wall of unstyled text is a report nobody reads.
 */

import { median } from "./baseline";
import type {
  ChangeSet,
  RunDocument,
  RunSummary,
  ScenarioComparison,
} from "./run-document";
import { STATUS_WORDS, describeSlo, headlineFor } from "./verdict";

/** Trend windows, in runs. */
const SHORT_TREND = 7;
const LONG_TREND = 30;

export interface ScenarioTrend {
  scenario: string;
  p95: number;
  shortMedian: number | null;
  longMedian: number | null;
}

export interface ReportInput {
  document: RunDocument;
  /** Comparable history, most recent first, excluding this run. */
  history: readonly RunSummary[];
  dashboardUrl: string | null;
  runUrl: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

function percent(ratio: number | null): string {
  if (ratio === null) return "—";
  const delta = (ratio - 1) * 100;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(0)}%`;
}

/** Direction of travel, in text rather than colour: colour alone is not read. */
function arrow(current: number, reference: number | null): string {
  if (reference === null || reference === 0) return "—";
  const ratio = current / reference;
  if (ratio > 1.1) return `slower ${percent(ratio)}`;
  if (ratio < 0.9) return `faster ${percent(ratio)}`;
  return `flat ${percent(ratio)}`;
}

export function computeTrends(input: ReportInput): ScenarioTrend[] {
  const { document, history } = input;

  return Object.entries(document.scenarios).map(([scenario, metrics]) => {
    const series = history
      .map((run) => run.scenarios[scenario]?.p95)
      .filter((value): value is number => typeof value === "number");

    return {
      scenario,
      p95: metrics.p95,
      shortMedian: median(series.slice(0, SHORT_TREND)),
      longMedian: median(series.slice(0, LONG_TREND)),
    };
  });
}

export function subjectFor(document: RunDocument): string {
  const day = document.timestamp.slice(0, 10);
  return `[MonetizeKit Perf] ${STATUS_WORDS[document.status].subject} — ${document.environment} ${day}`;
}

function scenarioRows(
  comparisons: readonly ScenarioComparison[],
  trends: readonly ScenarioTrend[],
  document: RunDocument,
): string {
  const trendByScenario = new Map(trends.map((trend) => [trend.scenario, trend]));

  return comparisons
    .map((comparison) => {
      const metrics = document.scenarios[comparison.scenario];
      const trend = trendByScenario.get(comparison.scenario);
      const background =
        comparison.verdict === "regressed"
          ? "#fffbeb"
          : !comparison.sloPass && !comparison.informational
            ? "#fef2f2"
            : "#ffffff";

      return `
        <tr style="background:${background};">
          <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;font-family:ui-monospace,monospace;font-size:13px;">${escapeHtml(comparison.scenario)}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;font-variant-numeric:tabular-nums;">${ms(comparison.p95)}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;font-variant-numeric:tabular-nums;color:#6b7280;">${comparison.baselineP95 !== null ? ms(comparison.baselineP95) : "—"}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;font-variant-numeric:tabular-nums;">${percent(comparison.ratio)}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;font-variant-numeric:tabular-nums;color:#6b7280;white-space:nowrap;">${escapeHtml(describeSlo(comparison))}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;font-variant-numeric:tabular-nums;color:#6b7280;">${metrics ? metrics.rps.toFixed(1) : "—"}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;font-variant-numeric:tabular-nums;color:#6b7280;">${metrics ? `${(metrics.errorRate * 100).toFixed(2)}%` : "—"}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:12px;">${escapeHtml(trend ? arrow(comparison.p95, trend.shortMedian) : "—")}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:12px;">${escapeHtml(trend ? arrow(comparison.p95, trend.longMedian) : "—")}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:12px;">${escapeHtml(comparison.verdict)}</td>
        </tr>`;
    })
    .join("");
}

function changeSetHtml(changeSet: ChangeSet | null): string {
  if (!changeSet) return "";

  switch (changeSet.detail) {
    case "unavailable":
      return `
      <h3 style="margin:28px 0 8px;font-size:15px;">What shipped</h3>
      <p style="margin:0;color:#6b7280;font-size:13px;">Not available — ${escapeHtml(changeSet.unavailableReason ?? "unknown")}.</p>`;
    case "same-build":
      return `
      <h3 style="margin:28px 0 8px;font-size:15px;">What shipped</h3>
      <p style="margin:0;color:#6b7280;font-size:13px;">Nothing: the same build was measured as last time, so any move is environmental rather than ours.</p>`;
    case "compare-link":
      return `
      <h3 style="margin:28px 0 8px;font-size:15px;">What shipped since the last measured build</h3>
      <p style="margin:0;font-size:13px;">The build moved from <code>${escapeHtml(changeSet.previousAppSha?.slice(0, 7) ?? "?")}</code>. Commit-level detail lives in the application repository${
        changeSet.compareUrl
          ? `: <a href="${escapeHtml(changeSet.compareUrl)}">open the full diff</a>.`
          : "; set PERF_APP_REPOSITORY_URL to link it."
      }</p>`;
    case "commits":
      break;
    default: {
      const exhaustive: never = changeSet.detail;
      throw new Error(`unhandled change-set detail ${String(exhaustive)}`);
    }
  }

  const commits = changeSet.commits
    .map(
      (commit) =>
        `<li style="margin:2px 0;"><code style="font-size:12px;color:#6b7280;">${escapeHtml(commit.sha.slice(0, 7))}</code> ${escapeHtml(commit.subject)} <span style="color:#9ca3af;">— ${escapeHtml(commit.author)}</span></li>`,
    )
    .join("");

  const migrations =
    changeSet.migrations.length > 0
      ? `<p style="margin:10px 0 0;font-size:13px;"><strong>Migrations that ran:</strong> ${changeSet.migrations.map((name) => escapeHtml(name)).join(", ")}</p>`
      : "";

  const dependencies =
    changeSet.dependencies.length > 0
      ? `<p style="margin:10px 0 0;font-size:13px;"><strong>Dependencies moved:</strong> ${changeSet.dependencies
          .slice(0, 12)
          .map(
            (change) =>
              `${escapeHtml(change.name)} ${escapeHtml(change.from ?? "added")}→${escapeHtml(change.to ?? "removed")}`,
          )
          .join(", ")}${changeSet.dependencies.length > 12 ? `, and ${changeSet.dependencies.length - 12} more` : ""}</p>`
      : "";

  const compare = changeSet.compareUrl
    ? `<p style="margin:10px 0 0;font-size:13px;"><a href="${escapeHtml(changeSet.compareUrl)}">Full diff</a></p>`
    : "";

  return `
    <h3 style="margin:28px 0 8px;font-size:15px;">What shipped since the last measured build</h3>
    <ul style="margin:0;padding-left:18px;font-size:13px;">${commits}</ul>
    ${changeSet.truncated ? '<p style="margin:6px 0 0;color:#9ca3af;font-size:12px;">List truncated; see the full diff.</p>' : ""}
    ${migrations}
    ${dependencies}
    ${compare}`;
}

const BANNER: Record<RunDocument["status"], { background: string; border: string; label: string }> = {
  passed: { background: "#ecfdf5", border: "#10b981", label: STATUS_WORDS.passed.label },
  "slo-breach": { background: "#fff7ed", border: "#f97316", label: STATUS_WORDS["slo-breach"].label },
  regressed: { background: "#fffbeb", border: "#f59e0b", label: STATUS_WORDS.regressed.label },
  failed: { background: "#fef2f2", border: "#ef4444", label: STATUS_WORDS.failed.label },
};

export function renderHtml(input: ReportInput): string {
  const { document, dashboardUrl, runUrl } = input;
  const comparisons = document.baseline?.scenarios ?? [];
  const trends = computeTrends(input);

  const banner = BANNER[document.status];

  const links = [
    dashboardUrl ? `<a href="${escapeHtml(dashboardUrl)}">Trends dashboard</a>` : null,
    runUrl ? `<a href="${escapeHtml(runUrl)}">This run's record</a>` : null,
  ]
    .filter(Boolean)
    .join(" &middot; ");

  return `<!doctype html>
<html>
<body style="margin:0;padding:24px;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;">
  <div style="max-width:860px;margin:0 auto;background:#ffffff;border-radius:10px;padding:24px;">
    <div style="background:${banner.background};border-left:4px solid ${banner.border};padding:12px 16px;border-radius:4px;">
      <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;">${escapeHtml(banner.label)}</div>
      <div style="margin-top:4px;font-size:16px;font-weight:600;">${escapeHtml(document.environment)} &middot; ${escapeHtml(document.timestamp.slice(0, 16).replace("T", " "))} UTC</div>
    </div>

    <p style="margin:18px 0 0;font-size:14px;line-height:1.55;">${escapeHtml(headlineFor(document))}</p>

    <table style="width:100%;border-collapse:collapse;margin-top:20px;font-size:13px;">
      <thead>
        <tr style="text-align:left;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;">
          <th style="padding:6px 10px;">Scenario</th>
          <th style="padding:6px 10px;text-align:right;">p95</th>
          <th style="padding:6px 10px;text-align:right;">Baseline</th>
          <th style="padding:6px 10px;text-align:right;">&Delta;</th>
          <th style="padding:6px 10px;text-align:right;">SLO</th>
          <th style="padding:6px 10px;text-align:right;">rps</th>
          <th style="padding:6px 10px;text-align:right;">Errors</th>
          <th style="padding:6px 10px;">7 runs</th>
          <th style="padding:6px 10px;">30 runs</th>
          <th style="padding:6px 10px;">Verdict</th>
        </tr>
      </thead>
      <tbody>${scenarioRows(comparisons, trends, document)}</tbody>
    </table>

    ${changeSetHtml(document.changeSet)}

    <h3 style="margin:28px 0 8px;font-size:15px;">Run details</h3>
    <table style="font-size:13px;color:#374151;">
      <tr><td style="padding:2px 12px 2px 0;color:#6b7280;">Build</td><td><code>${escapeHtml(document.appSha?.slice(0, 12) ?? "unknown")}</code></td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#6b7280;">Dataset</td><td>${escapeHtml(document.datasetVersion ?? "unknown")}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#6b7280;">Workload</td><td>${escapeHtml(document.workloadVersion)} &middot; k6 ${escapeHtml(document.k6Version ?? "unknown")} &middot; ${document.rateLimitPerMinute !== null ? `${document.rateLimitPerMinute} req/min allowed` : "rate limit unknown"}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#6b7280;">Baseline</td><td>${document.baseline ? `median of ${document.baseline.baselineRuns} run(s)${document.baseline.forming ? ", still forming" : ""}` : "not computed"}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#6b7280;">Target</td><td>${escapeHtml(document.baseUrl)}</td></tr>
    </table>

    ${
      document.notes.length > 0
        ? `<h3 style="margin:28px 0 8px;font-size:15px;">Notes</h3><ul style="margin:0;padding-left:18px;font-size:13px;color:#6b7280;">${document.notes
            .map((note) => `<li style="margin:2px 0;">${escapeHtml(note)}</li>`)
            .join("")}</ul>`
        : ""
    }

    ${links ? `<p style="margin:24px 0 0;font-size:13px;">${links}</p>` : ""}
  </div>
</body>
</html>`;
}

/** Plain-text alternative, for clients that will not render HTML. */
export function renderText(input: ReportInput): string {
  const { document, dashboardUrl } = input;
  const lines: string[] = [
    subjectFor(document),
    "",
    headlineFor(document),
    "",
  ];

  for (const comparison of document.baseline?.scenarios ?? []) {
    lines.push(
      `  ${comparison.scenario.padEnd(26)} p95 ${ms(comparison.p95).padStart(8)}`
        + `  baseline ${(comparison.baselineP95 !== null ? ms(comparison.baselineP95) : "—").padStart(8)}`
        + `  ${percent(comparison.ratio).padStart(6)}`
        + `  SLO ${describeSlo(comparison)}`
        + `  ${comparison.verdict}`,
    );
  }

  const changeSet = document.changeSet;
  if (changeSet) {
    switch (changeSet.detail) {
      case "commits":
        lines.push("", "Shipped since the last measured build:");
        for (const commit of changeSet.commits) {
          lines.push(`  ${commit.sha.slice(0, 7)} ${commit.subject} — ${commit.author}`);
        }
        if (changeSet.migrations.length > 0) {
          lines.push(`  migrations: ${changeSet.migrations.join(", ")}`);
        }
        break;
      case "compare-link":
        lines.push(
          "",
          `Build moved from ${changeSet.previousAppSha?.slice(0, 7) ?? "?"}; `
            + (changeSet.compareUrl ? `full diff: ${changeSet.compareUrl}` : "see the application repository."),
        );
        break;
      case "unavailable":
        lines.push("", `Change set unavailable — ${changeSet.unavailableReason ?? "unknown"}.`);
        break;
      case "same-build":
        break;
      default: {
        const exhaustive: never = changeSet.detail;
        throw new Error(`unhandled change-set detail ${String(exhaustive)}`);
      }
    }
  }

  if (document.notes.length > 0) {
    lines.push("", "Notes:");
    for (const note of document.notes) lines.push(`  - ${note}`);
  }

  lines.push(
    "",
    `Build ${document.appSha?.slice(0, 12) ?? "unknown"} · dataset ${document.datasetVersion ?? "unknown"} · workload ${document.workloadVersion} · k6 ${document.k6Version ?? "unknown"} · ${document.rateLimitPerMinute !== null ? `${document.rateLimitPerMinute} req/min allowed` : "rate limit unknown"}`,
  );
  if (dashboardUrl) lines.push(`Trends: ${dashboardUrl}`);

  return lines.join("\n");
}
