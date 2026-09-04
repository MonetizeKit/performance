/**
 * The trends dashboard: every run in the store, plotted.
 *
 * A single self-contained HTML file with inline SVG and no scripts. That is not
 * minimalism for its own sake — it means the dashboard can be opened from a
 * workflow artifact, mailed, committed next to the data it describes, or served
 * from anywhere later without the placement decision changing the code. A
 * dashboard that needs a running server is a dashboard that is down when
 * someone finally goes looking for it.
 *
 * Layout is small multiples: one chart per scenario rather than eight lines on
 * shared axes. The scenarios span an order of magnitude (a 100ms entitlement
 * check against a 1.5s bulk ingest), so shared axes would flatten every line
 * that matters into the floor.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { escapeHtml, ms, percent, shortTimestamp } from "./format";
import type { RunSummary } from "./run-document";
import { renderRunPage, runPagePath } from "./run-page";
import {
  appRepositoryUrl,
  PERF_DATA_BRANCH,
  repositoryUrl,
  siteUrl,
  type PerfStore,
} from "./store";

/** Runs plotted per scenario. Roughly a quarter of nightlies. */
export const DEFAULT_HISTORY = 90;

/**
 * The store root, so a static host pointed at the branch serves the dashboard
 * as its landing page and the run permalinks beside it.
 */
export const DASHBOARD_PATH = "index.html";

const CHART_WIDTH = 320;
const CHART_HEIGHT = 96;
const CHART_PADDING = 4;

export interface DashboardInput {
  /** Every run in the store, any order. */
  runs: readonly RunSummary[];
  generatedAt: string;
  /** This repository's web URL, for linking a run to the record it came from. */
  repositoryUrl?: string | null;
  /** The application's repository, for linking a run to the build it measured. */
  appRepositoryUrl?: string | null;
  /** Branch holding the store, for record links. */
  branch?: string;
  /** Where the methodology is documented; the footer links to it. */
  methodologyUrl?: string;
  maxRuns?: number;
}

/** Fixed per repository, so a fork's dashboard points at its own copy. */
const DEFAULT_METHODOLOGY_URL = "https://github.com/MonetizeKit/performance/blob/main/docs/methodology.md";

interface Links {
  repositoryUrl: string | null;
  appRepositoryUrl: string | null;
  branch: string;
}

interface ScenarioSeries {
  scenario: string;
  /** Oldest first, aligned with `runs`; null where the scenario is absent. */
  points: (number | null)[];
  latest: number | null;
  previous: number | null;
  breaches: number;
}

interface EnvironmentView {
  environment: string;
  runs: RunSummary[];
  workloadVersion: string;
  /** Indices in `runs` where the workload changed, so the axis stays honest. */
  workloadBreaks: number[];
  series: ScenarioSeries[];
}

function delta(latest: number | null, previous: number | null): string {
  if (latest === null || previous === null || previous === 0) return "—";
  return percent(latest / previous);
}

export function buildEnvironmentViews(input: DashboardInput): EnvironmentView[] {
  const limit = input.maxRuns ?? DEFAULT_HISTORY;
  const byEnvironment = new Map<string, RunSummary[]>();

  for (const run of input.runs) {
    const bucket = byEnvironment.get(run.environment);
    if (bucket) bucket.push(run);
    else byEnvironment.set(run.environment, [run]);
  }

  const views: EnvironmentView[] = [];

  for (const [environment, all] of byEnvironment) {
    const runs = all
      .slice()
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
      .slice(-limit);
    if (runs.length === 0) continue;

    const workloadBreaks = runs
      .map((run, index) =>
        index > 0 && run.workloadVersion !== runs[index - 1]!.workloadVersion ? index : -1,
      )
      .filter((index) => index >= 0);

    // Scenario order follows the newest run: it is the current workload, and a
    // scenario that has been retired should sink to the bottom, not lead.
    const newest = runs[runs.length - 1]!;
    const names = [
      ...Object.keys(newest.scenarios),
      ...runs.flatMap((run) => Object.keys(run.scenarios)),
    ].filter((name, index, all_) => all_.indexOf(name) === index);

    const series = names.map((scenario): ScenarioSeries => {
      const points = runs.map((run) => run.scenarios[scenario]?.p95 ?? null);

      return {
        scenario,
        points,
        latest: points[points.length - 1] ?? null,
        previous: points.slice(0, -1).reverse().find((value) => value !== null) ?? null,
        breaches: runs.filter((run) => run.scenarios[scenario]?.sloPass === false).length,
      };
    });

    views.push({
      environment,
      runs,
      workloadVersion: newest.workloadVersion,
      workloadBreaks,
      series,
    });
  }

  return views.sort((left, right) => left.environment.localeCompare(right.environment));
}

/**
 * One scenario's p95 over time.
 *
 * The y-axis starts at zero rather than at the data's own minimum. Auto-scaled
 * axes turn 3ms of jitter into a mountain range, and a dashboard that cries
 * regression every night is one nobody reads by the second week.
 */
function chart(series: ScenarioSeries, breaks: readonly number[]): string {
  const observed = series.points.filter((value): value is number => value !== null);
  if (observed.length === 0) {
    return `<div style="width:${CHART_WIDTH}px;height:${CHART_HEIGHT}px;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:12px;">no data</div>`;
  }

  const ceiling = Math.max(...observed) * 1.15 || 1;
  const usableWidth = CHART_WIDTH - CHART_PADDING * 2;
  const usableHeight = CHART_HEIGHT - CHART_PADDING * 2;
  const step = series.points.length > 1 ? usableWidth / (series.points.length - 1) : 0;

  const x = (index: number) => CHART_PADDING + index * step;
  const y = (value: number) =>
    CHART_PADDING + usableHeight - (value / ceiling) * usableHeight;

  // A gap in the data is drawn as a gap: bridging it would invent a
  // measurement on a night the scenario did not run.
  const segments: string[] = [];
  let current: string[] = [];
  for (const [index, value] of series.points.entries()) {
    if (value === null) {
      if (current.length > 1) segments.push(current.join(" "));
      current = [];
      continue;
    }
    current.push(`${current.length === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(value).toFixed(1)}`);
  }
  if (current.length > 1) segments.push(current.join(" "));

  const line = segments
    .map(
      (path) =>
        `<path d="${path}" fill="none" stroke="#2563eb" stroke-width="1.5" stroke-linejoin="round" />`,
    )
    .join("");

  const dots = series.points
    .map((value, index) =>
      value === null
        ? ""
        : `<circle cx="${x(index).toFixed(1)}" cy="${y(value).toFixed(1)}" r="${index === series.points.length - 1 ? 3 : 1.5}" fill="${index === series.points.length - 1 ? "#1d4ed8" : "#93c5fd"}" />`,
    )
    .join("");

  const workloadMarkers = breaks
    .map(
      (index) =>
        `<line x1="${x(index).toFixed(1)}" y1="${CHART_PADDING}" x2="${x(index).toFixed(1)}" y2="${CHART_HEIGHT - CHART_PADDING}" stroke="#d97706" stroke-width="1" stroke-dasharray="2 2" />`,
    )
    .join("");

  return `<svg width="${CHART_WIDTH}" height="${CHART_HEIGHT}" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" role="img" aria-label="${escapeHtml(series.scenario)} p95 over the last ${series.points.length} runs, peaking at ${ms(Math.max(...observed))}">
    <rect x="0" y="0" width="${CHART_WIDTH}" height="${CHART_HEIGHT}" fill="#f9fafb" rx="4" />
    ${workloadMarkers}${line}${dots}
  </svg>`;
}

function seriesCard(series: ScenarioSeries, breaks: readonly number[]): string {
  const observed = series.points.filter((value): value is number => value !== null);
  const worst = observed.length > 0 ? Math.max(...observed) : null;

  return `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;background:#ffffff;">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;">
      <code style="font-size:13px;color:#111827;">${escapeHtml(series.scenario)}</code>
      <span style="font-size:12px;color:#6b7280;font-variant-numeric:tabular-nums;">${series.latest !== null ? ms(series.latest) : "—"} <span style="color:#9ca3af;">(${delta(series.latest, series.previous)})</span></span>
    </div>
    <div style="margin-top:8px;">${chart(series, breaks)}</div>
    <div style="margin-top:6px;font-size:11px;color:#9ca3af;">
      ${observed.length} run(s) · worst ${worst !== null ? ms(worst) : "—"}${series.breaches > 0 ? ` · <span style="color:#b91c1c;">${series.breaches} SLO breach(es)</span>` : ""}
    </div>
  </div>`;
}

function runRow(run: RunSummary, links: Links): string {
  const colour =
    run.status === "passed"
      ? "#059669"
      : run.status === "regressed"
        ? "#b45309"
        : run.status === "slo-breach"
          ? "#c2410c"
          : "#b91c1c";
  const record = links.repositoryUrl
    ? `<a href="${escapeHtml(`${links.repositoryUrl}/blob/${links.branch}/${run.path}`)}" style="color:#2563eb;text-decoration:none;">record</a>`
    : "—";
  const build = links.appRepositoryUrl && run.appSha
    ? `<a href="${escapeHtml(`${links.appRepositoryUrl}/commit/${run.appSha}`)}" style="color:#2563eb;text-decoration:none;font-family:ui-monospace,monospace;">${escapeHtml(run.appSha.slice(0, 7))}</a>`
    : `<code>${escapeHtml(run.appSha?.slice(0, 7) ?? "unknown")}</code>`;

  const cell = "padding:6px 10px;border-bottom:1px solid #f3f4f6;font-size:12px;";

  return `<tr>
    <td style="${cell}color:#374151;white-space:nowrap;"><a href="${escapeHtml(runPagePath(run.runId))}" style="color:#2563eb;text-decoration:none;">${escapeHtml(shortTimestamp(run.timestamp))}</a></td>
    <td style="${cell}color:${colour};">${escapeHtml(run.status)}</td>
    <td style="${cell}color:#6b7280;">${escapeHtml(run.trigger)}</td>
    <td style="${cell}">${build}</td>
    <td style="${cell}color:#6b7280;">${escapeHtml(run.workloadVersion)} / ${escapeHtml(run.datasetVersion ?? "—")}</td>
    <td style="${cell}"><a href="${escapeHtml(runPagePath(run.runId))}" style="color:#2563eb;text-decoration:none;">permalink</a> · ${record}</td>
  </tr>`;
}

/**
 * Latest p95 per scenario, one column per environment.
 *
 * Environments are never folded into one baseline — a run measured against
 * delivery says nothing about production — but seeing them beside each other is
 * how you tell "the platform got slower" apart from "that one deployment is
 * slower", which is the first question when two environments disagree.
 */
function comparisonSection(views: readonly EnvironmentView[]): string {
  if (views.length < 2) return "";

  const scenarios = [
    ...new Set(views.flatMap((view) => view.series.map((series) => series.scenario))),
  ];

  const header = views
    .map(
      (view) =>
        `<th style="padding:8px 10px;text-align:right;">${escapeHtml(view.environment)}</th>`,
    )
    .join("");

  const rows = scenarios
    .map((scenario) => {
      const cells = views
        .map((view) => {
          const series = view.series.find((entry) => entry.scenario === scenario);
          const newest = view.runs[view.runs.length - 1];
          const breached = newest?.scenarios[scenario]?.sloPass === false;
          const value = series?.latest;
          return `<td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;text-align:right;font-variant-numeric:tabular-nums;color:${breached ? "#b91c1c" : "#111827"};">${
            value !== undefined && value !== null ? ms(value) : "—"
          }</td>`;
        })
        .join("");

      return `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;font-family:ui-monospace,monospace;font-size:12px;">${escapeHtml(scenario)}</td>
        ${cells}
      </tr>`;
    })
    .join("");

  return `<section style="margin-top:28px;">
    <h2 style="margin:0;font-size:18px;">Latest run, side by side</h2>
    <p style="margin:6px 0 0;font-size:13px;color:#6b7280;max-width:70ch;">
      Each environment's most recent p95. These are not compared against one another
      for a verdict — different environments run different hardware and different
      data, so only an environment's own history judges it — but a gap that appears
      in one column and not the others usually points at the deployment rather than
      at the code.
    </p>
    <table style="margin-top:12px;border-collapse:collapse;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;">
      <thead>
        <tr style="text-align:left;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;background:#f9fafb;">
          <th style="padding:8px 10px;">Scenario</th>
          ${header}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

/** Newest first, and only enough to see the recent record at a glance. */
const RUN_TABLE_ROWS = 20;

function environmentSection(view: EnvironmentView, links: Links): string {
  const newest = view.runs[view.runs.length - 1]!;
  const breachingNow = view.series.filter(
    (series) => newest.scenarios[series.scenario]?.sloPass === false,
  );

  const summary =
    breachingNow.length > 0
      ? `<span style="color:#b91c1c;">${breachingNow.length} scenario(s) missed their SLO on the latest run: ${breachingNow
          .map((series) => escapeHtml(series.scenario))
          .join(", ")}.</span>`
      : `Every scenario met its SLO on the latest run.`;

  return `<section style="margin-top:36px;">
    <h2 style="margin:0;font-size:18px;">${escapeHtml(view.environment)}</h2>
    <p style="margin:6px 0 0;font-size:13px;color:#6b7280;">
      ${view.runs.length} run(s) plotted · latest ${escapeHtml(newest.timestamp.slice(0, 16).replace("T", " "))} UTC · workload ${escapeHtml(view.workloadVersion)}.
      ${summary}
      ${view.workloadBreaks.length > 0 ? `<br />Dashed vertical lines mark where the workload changed; runs either side of one are not comparable.` : ""}
    </p>

    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(346px,1fr));gap:12px;margin-top:14px;">
      ${view.series.map((series) => seriesCard(series, view.workloadBreaks)).join("")}
    </div>

    <h3 style="margin:24px 0 8px;font-size:14px;color:#374151;">Recent runs</h3>
    <table style="width:100%;border-collapse:collapse;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">
      <thead>
        <tr style="text-align:left;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;background:#f9fafb;">
          <th style="padding:6px 10px;">When (UTC)</th>
          <th style="padding:6px 10px;">Status</th>
          <th style="padding:6px 10px;">Trigger</th>
          <th style="padding:6px 10px;">Build</th>
          <th style="padding:6px 10px;">Workload / dataset</th>
          <th style="padding:6px 10px;"></th>
        </tr>
      </thead>
      <tbody>${[...view.runs]
        .reverse()
        .slice(0, RUN_TABLE_ROWS)
        .map((run) => runRow(run, links))
        .join("")}</tbody>
    </table>
  </section>`;
}

export function renderDashboard(input: DashboardInput): string {
  const views = buildEnvironmentViews(input);
  const branch = input.branch ?? "perf-data";
  const links: Links = {
    repositoryUrl: input.repositoryUrl ?? null,
    appRepositoryUrl: input.appRepositoryUrl ?? null,
    branch,
  };
  const methodologyUrl = input.methodologyUrl ?? DEFAULT_METHODOLOGY_URL;

  const body =
    views.length === 0
      ? `<p style="margin-top:32px;font-size:14px;color:#6b7280;">No runs recorded yet. The first nightly to complete will appear here.</p>`
      : comparisonSection(views)
        + views.map((view) => environmentSection(view, links)).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MonetizeKit performance trends</title>
  <meta name="description" content="Nightly p95 latency of the MonetizeKit public API, measured against a seeded showcase tenant. Every point links to an immutable run record." />
</head>
<body style="margin:0;padding:28px 20px 64px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;">
  <div style="max-width:1180px;margin:0 auto;">
    <h1 style="margin:0;font-size:24px;">Performance trends</h1>
    <p style="margin:8px 0 0;font-size:13px;color:#6b7280;max-width:70ch;">
      p95 latency per scenario over the recorded nightlies, newest point on the right.
      Charts start at zero so ordinary jitter reads as jitter. Generated
      ${escapeHtml(input.generatedAt.slice(0, 16).replace("T", " "))} UTC from
      <code>index.ndjson</code> on <code>${escapeHtml(branch)}</code>.
    </p>
    ${body}
    <p style="margin-top:40px;font-size:12px;color:#9ca3af;">
      Machine-written by <code>packages/pipeline/src/dashboard.ts</code>. Every point is one Run Document;
      the analyzer, the nightly report and this page all read the same records. How the numbers are
      produced, and what they do and do not claim: <a href="${escapeHtml(methodologyUrl)}" style="color:#2563eb;">methodology</a>.
    </p>
  </div>
</body>
</html>`;
}

export interface SiteResult {
  runs: number;
  /** Permalink pages written. */
  pages: number;
}

/**
 * Render the whole static site into a store checkout: the dashboard, one
 * permalink page per run, and the `.nojekyll` a branch-hosted static site needs.
 *
 * Every page is rewritten each time rather than only the new one. Pages are a
 * pure function of the immutable Run Documents, so a rewrite is byte-identical
 * unless the renderer itself changed — git records nothing — and when the
 * renderer does improve, the whole archive gets the improvement instead of only
 * the runs that happen to come after it.
 */
export function writeSite(
  store: PerfStore,
  options: { maxRuns?: number; outPath?: string } = {},
): SiteResult {
  const runs = store.readIndex();
  const site = siteUrl();

  const dashboardPath = options.outPath ?? join(store.root, DASHBOARD_PATH);
  mkdirSync(dirname(dashboardPath), { recursive: true });
  writeFileSync(
    dashboardPath,
    renderDashboard({
      runs,
      generatedAt: new Date().toISOString(),
      repositoryUrl: repositoryUrl(),
      appRepositoryUrl: appRepositoryUrl(),
      branch: PERF_DATA_BRANCH,
      maxRuns: options.maxRuns,
    }),
    "utf8",
  );

  // Only when writing into the store: a one-off dashboard rendered elsewhere
  // has nowhere to put the permalinks it would link to.
  if (options.outPath) return { runs: runs.length, pages: 0 };

  writeFileSync(join(store.root, ".nojekyll"), "", "utf8");

  let pages = 0;
  for (const run of runs) {
    let document;
    try {
      document = store.readRunDocument(run.path);
    } catch {
      // The index outlived its document, which a hand-edit could do. Skipping
      // costs one page; throwing would cost the whole publish.
      continue;
    }

    const pagePath = runPagePath(run.runId);
    const absolute = join(store.root, pagePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(
      absolute,
      renderRunPage({
        document,
        canonicalUrl: site ? `${site}/${pagePath}` : null,
        rootPath: "../",
        // Both live in the store; `run/` is one level down, the document is not.
        rawDocumentPath: `../${run.path}`,
      }),
      "utf8",
    );
    pages += 1;
  }

  return { runs: runs.length, pages };
}
