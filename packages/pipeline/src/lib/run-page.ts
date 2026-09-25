/**
 * The per-run permalink: one page per measurement, at a URL that never moves.
 *
 * This exists so a number can be cited. Quoting "our p95 entitlement check is
 * 42ms" in a blog post is an assertion; linking it to a page that says which
 * commit was measured, under what offered load, against which dataset, on what
 * date, with the raw record one click away, is evidence. Run ids are timestamped
 * and unique for exactly this reason — the URL for a run is stable across time
 * and is never reused, so a citation stays true after the next run lands.
 *
 * Self-contained HTML, like the dashboard: no scripts, no external requests, so
 * it renders the same from a workflow artifact, a static host, or a file.
 */

import { escapeHtml, ms, percent, shortTimestamp } from "./format";
import type { ChangeSet, RunDocument, ScenarioComparison } from "./run-document";
import { STATUS_WORDS, describeSlo, headlineFor } from "./verdict";

/** Where a run's page lives in the store. Flat: the run id alone is unique. */
export function runPagePath(runId: string): string {
  return `run/${runId}.html`;
}

export interface RunPageInput {
  document: RunDocument;
  /** Absolute URL this page will be served at, for the citation block. */
  canonicalUrl: string | null;
  /** Relative path back to the store root, e.g. `../`. */
  rootPath?: string;
  /** Path to the raw Run Document, relative to this page. */
  rawDocumentPath?: string | null;
}

const STATUS_STYLE: Record<RunDocument["status"], { background: string; border: string; label: string }> = {
  passed: { background: "#ecfdf5", border: "#10b981", label: STATUS_WORDS.passed.label },
  "slo-breach": { background: "#fff7ed", border: "#f97316", label: STATUS_WORDS["slo-breach"].label },
  regressed: { background: "#fffbeb", border: "#f59e0b", label: STATUS_WORDS.regressed.label },
  failed: { background: "#fef2f2", border: "#ef4444", label: STATUS_WORDS.failed.label },
};

function verdictColour(verdict: ScenarioComparison["verdict"]): string {
  if (verdict === "slo-breach") return "#b91c1c";
  if (verdict === "regressed") return "#b45309";
  if (verdict === "baseline-forming" || verdict === "informational") return "#6b7280";
  return "#059669";
}

function scenarioRows(document: RunDocument): string {
  const comparisons = document.baseline?.scenarios ?? [];

  // Fall back to the raw metrics when a run was never analyzed, so a page
  // always shows what was measured even if no verdict was ever reached.
  const rows = comparisons.length
    ? comparisons
    : Object.entries(document.scenarios).map(([scenario, metrics]) => ({
        scenario,
        p95: metrics.p95,
        baselineP95: null,
        ratio: null,
        sloP95Ms: metrics.sloP95Ms,
        sloP95AboveFloorMs: metrics.sloP95AboveFloorMs ?? null,
        floorP50Ms: metrics.floorP50Ms ?? null,
        sloPass: metrics.sloPass,
        informational: metrics.informational === true,
        verdict: metrics.informational ? ("informational" as const) : ("baseline-forming" as const),
      }));

  return rows
    .map((comparison) => {
      const metrics = document.scenarios[comparison.scenario];
      const cell = "padding:8px 10px;border-bottom:1px solid #e5e7eb;";
      const number = `${cell}text-align:right;font-variant-numeric:tabular-nums;`;

      return `<tr>
        <td style="${cell}font-family:ui-monospace,monospace;font-size:13px;">${escapeHtml(comparison.scenario)}</td>
        <td style="${number}font-weight:600;">${ms(comparison.p95)}</td>
        <td style="${number}color:#6b7280;">${metrics ? ms(metrics.p50) : "—"}</td>
        <td style="${number}color:#6b7280;">${metrics ? ms(metrics.p99) : "—"}</td>
        <td style="${number}color:#6b7280;">${comparison.baselineP95 !== null ? ms(comparison.baselineP95) : "—"}</td>
        <td style="${number}">${percent(comparison.ratio)}</td>
        <td style="${number}color:#6b7280;white-space:nowrap;">${escapeHtml(describeSlo(comparison))}</td>
        <td style="${number}color:#6b7280;">${metrics ? metrics.requests : "—"}</td>
        <td style="${number}color:#6b7280;">${metrics ? `${(metrics.errorRate * 100).toFixed(2)}%` : "—"}</td>
        <td style="${cell}font-size:12px;color:${verdictColour(comparison.verdict)};">${escapeHtml(comparison.verdict)}</td>
      </tr>`;
    })
    .join("");
}

function changeSetSection(changeSet: ChangeSet | null): string {
  if (!changeSet) return "";

  const heading = `<h2 style="margin:32px 0 8px;font-size:16px;">What shipped since the last measured build</h2>`;

  switch (changeSet.detail) {
    case "unavailable":
      return `${heading}
      <p style="margin:0;color:#6b7280;font-size:13px;">Not available — ${escapeHtml(changeSet.unavailableReason ?? "unknown")}.</p>`;
    case "same-build":
      return `${heading}
      <p style="margin:0;color:#6b7280;font-size:13px;">Nothing: the same build was measured as last time, so any movement here is environmental rather than ours.</p>`;
    case "compare-link":
      return `${heading}
      <p style="margin:0;font-size:13px;">The build moved from <code>${escapeHtml(changeSet.previousAppSha?.slice(0, 7) ?? "?")}</code>. This site records what was measured; the commits that changed it live in the application repository${
        changeSet.compareUrl
          ? `: <a href="${escapeHtml(changeSet.compareUrl)}" style="color:#2563eb;">full diff</a>.`
          : "."
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
        `<li style="margin:3px 0;"><code style="font-size:12px;color:#6b7280;">${escapeHtml(commit.sha.slice(0, 7))}</code> ${escapeHtml(commit.subject)} <span style="color:#9ca3af;">— ${escapeHtml(commit.author)}</span></li>`,
    )
    .join("");

  const extras = [
    changeSet.migrations.length > 0
      ? `<p style="margin:10px 0 0;font-size:13px;"><strong>Migrations that ran:</strong> ${changeSet.migrations.map(escapeHtml).join(", ")}</p>`
      : "",
    changeSet.dependencies.length > 0
      ? `<p style="margin:10px 0 0;font-size:13px;"><strong>Dependencies moved:</strong> ${changeSet.dependencies
          .slice(0, 20)
          .map((change) => `${escapeHtml(change.name)} ${escapeHtml(change.from ?? "added")}→${escapeHtml(change.to ?? "removed")}`)
          .join(", ")}${changeSet.dependencies.length > 20 ? `, and ${changeSet.dependencies.length - 20} more` : ""}</p>`
      : "",
    changeSet.compareUrl
      ? `<p style="margin:10px 0 0;font-size:13px;"><a href="${escapeHtml(changeSet.compareUrl)}" style="color:#2563eb;">Full diff</a></p>`
      : "",
  ].join("");

  return `<h2 style="margin:32px 0 8px;font-size:16px;">What shipped since the last measured build</h2>
    <ul style="margin:0;padding-left:18px;font-size:13px;">${commits}</ul>
    ${changeSet.truncated ? '<p style="margin:6px 0 0;color:#9ca3af;font-size:12px;">List truncated; see the full diff.</p>' : ""}
    ${extras}`;
}

/**
 * What a citation needs to be checkable: the claim, the conditions it holds
 * under, and where the raw record is.
 */
function citation(input: RunPageInput): string {
  const { document, canonicalUrl } = input;
  const headline = document.baseline?.scenarios.find(
    (scenario) => scenario.verdict === "pass",
  ) ?? document.baseline?.scenarios[0];

  const claim = headline
    ? `${headline.scenario} p95 ${ms(headline.p95)}`
    : "see the table below";

  return `<div style="margin-top:24px;padding:14px 16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;">Citing this run</div>
    <p style="margin:8px 0 0;font-size:13px;line-height:1.6;color:#374151;">
      MonetizeKit ${escapeHtml(document.environment)}, ${escapeHtml(document.timestamp.slice(0, 10))},
      build <code>${escapeHtml(document.appSha?.slice(0, 7) ?? "unknown")}</code>: ${escapeHtml(claim)},
      measured at ${describeRateLimitForCitation(document)}
      against dataset ${escapeHtml(document.datasetVersion ?? "unknown")} with workload ${escapeHtml(document.workloadVersion)}.
    </p>
    ${
      canonicalUrl
        ? `<p style="margin:8px 0 0;font-size:12px;"><a href="${escapeHtml(canonicalUrl)}" style="color:#2563eb;word-break:break-all;">${escapeHtml(canonicalUrl)}</a></p>`
        : ""
    }
    <p style="margin:8px 0 0;font-size:12px;color:#9ca3af;">
      This URL is permanent. Run ids are timestamped and never reused, so a later run cannot change what this page says.
    </p>
  </div>`;
}

export function renderRunPage(input: RunPageInput): string {
  const { document, rootPath = "../", rawDocumentPath = null } = input;
  const banner = STATUS_STYLE[document.status];
  const summary = headlineFor(document);

  const detail = (label: string, value: string) =>
    `<tr><td style="padding:3px 16px 3px 0;color:#6b7280;white-space:nowrap;">${label}</td><td>${value}</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(document.environment)} performance run ${escapeHtml(document.runId)}</title>
  ${input.canonicalUrl ? `<link rel="canonical" href="${escapeHtml(input.canonicalUrl)}" />` : ""}
</head>
<body style="margin:0;padding:28px 20px 64px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;">
  <div style="max-width:980px;margin:0 auto;">
    <p style="margin:0 0 16px;font-size:13px;"><a href="${escapeHtml(rootPath)}" style="color:#2563eb;text-decoration:none;">← All performance runs</a></p>

    <div style="background:${banner.background};border-left:4px solid ${banner.border};padding:14px 18px;border-radius:4px;">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;">${escapeHtml(banner.label)}</div>
      <h1 style="margin:6px 0 0;font-size:20px;">${escapeHtml(document.environment)} · ${escapeHtml(shortTimestamp(document.timestamp))} UTC</h1>
      <div style="margin-top:4px;font-size:12px;color:#6b7280;font-family:ui-monospace,monospace;">${escapeHtml(document.runId)}</div>
    </div>

    <p style="margin:18px 0 0;font-size:14px;line-height:1.55;">${escapeHtml(summary)}</p>

    ${citation(input)}

    <h2 style="margin:32px 0 8px;font-size:16px;">Scenarios</h2>
    <table style="width:100%;border-collapse:collapse;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;">
      <thead>
        <tr style="text-align:left;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;background:#f9fafb;">
          <th style="padding:8px 10px;">Scenario</th>
          <th style="padding:8px 10px;text-align:right;">p95</th>
          <th style="padding:8px 10px;text-align:right;">p50</th>
          <th style="padding:8px 10px;text-align:right;">p99</th>
          <th style="padding:8px 10px;text-align:right;">Baseline</th>
          <th style="padding:8px 10px;text-align:right;">&Delta;</th>
          <th style="padding:8px 10px;text-align:right;">SLO</th>
          <th style="padding:8px 10px;text-align:right;">Requests</th>
          <th style="padding:8px 10px;text-align:right;">Errors</th>
          <th style="padding:8px 10px;">Verdict</th>
        </tr>
      </thead>
      <tbody>${scenarioRows(document)}</tbody>
    </table>

    ${changeSetSection(document.changeSet)}

    <h2 style="margin:32px 0 8px;font-size:16px;">Conditions</h2>
    <table style="font-size:13px;color:#374151;">
      ${detail("Build", `<code>${escapeHtml(document.appSha ?? "unknown")}</code>`)}
      ${detail("Target", escapeHtml(document.baseUrl))}
      ${detail("Dataset", escapeHtml(document.datasetVersion ?? "unknown"))}
      ${detail("Workload", `${escapeHtml(document.workloadVersion)} · k6 ${escapeHtml(document.k6Version ?? "unknown")}`)}
      ${detail("Rate limit", describeRateLimit(document))}
      ${detail("Trigger", escapeHtml(document.trigger))}
      ${detail("Duration", `${Math.round(document.durationMs / 1000)}s`)}
      ${detail("Baseline", document.baseline ? `median of ${document.baseline.baselineRuns} comparable run(s)${document.baseline.forming ? ", still forming" : ""}` : "not computed")}
    </table>

    ${
      document.notes.length > 0
        ? `<h2 style="margin:32px 0 8px;font-size:16px;">Notes</h2><ul style="margin:0;padding-left:18px;font-size:13px;color:#6b7280;">${document.notes
            .map((note) => `<li style="margin:3px 0;">${escapeHtml(note)}</li>`)
            .join("")}</ul>`
        : ""
    }

    <p style="margin:32px 0 0;font-size:12px;color:#9ca3af;">
      ${rawDocumentPath ? `<a href="${escapeHtml(rawDocumentPath)}" style="color:#2563eb;">Raw Run Document (JSON)</a> · ` : ""}Machine-written by <code>packages/pipeline/src/persist.ts</code>. Append-only: this run is never rewritten.
    </p>
  </div>
</body>
</html>`;
}

function describeRateLimit(document: Pick<RunDocument, "rateLimitPerMinute" | "rateLimitState">): string {
  if (document.rateLimitPerMinute !== null) return `${document.rateLimitPerMinute} requests/minute`;
  return document.rateLimitState === "unlimited" ? "none (plan sets no burst limit)" : "not reported";
}

function describeRateLimitForCitation(
  document: Pick<RunDocument, "rateLimitPerMinute" | "rateLimitState">,
): string {
  if (document.rateLimitPerMinute !== null) return `up to ${document.rateLimitPerMinute} requests/minute`;
  return document.rateLimitState === "unlimited"
    ? "the offered load below, with no per-key rate limit in force"
    : "the offered load below";
}
