/**
 * The Run Document: one immutable record per performance run.
 *
 * Every downstream step reads this and nothing else — the analyzer compares
 * Run Documents to each other, the email renders one, and the dashboard plots a
 * series of them. That is deliberate: the numbers a report claims are the
 * numbers that were persisted, not a second derivation from the raw k6 output.
 *
 * Runs are only comparable when they measured the same thing against the same
 * data. `environment`, `workloadVersion` and `datasetVersion` together define
 * that comparability, and the analyzer refuses to mix across them.
 */

/**
 * 3: `slo-breach` is a run status of its own, and a scenario's `sloP95Ms` may be
 *    resolved per run from a budget above the measured network floor
 *    (`sloP95AboveFloorMs`, `floorP50Ms`).
 * 2: `changeSet.detail` discriminates how much attribution the run carries.
 * 1: the original shape, from when the harness lived beside the application.
 */
export const RUN_DOCUMENT_SCHEMA_VERSION = 4;

/** Where a run came from. Ad-hoc runs are recorded but never form a baseline. */
export type RunTrigger = "schedule" | "dispatch" | "local";

/**
 * `regressed` means slower than the run's own baseline: something changed
 * tonight. `slo-breach` means a target was missed with no such change: the
 * system is where it has been, and that place is outside the promise. They
 * call for different people, so they are never folded into one word.
 */
export type RunStatus = "passed" | "slo-breach" | "regressed" | "failed";

export interface ScenarioMetrics {
  /** Milliseconds. */
  avg: number;
  min: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  /** Observations recorded by the scenario. */
  requests: number;
  /** Achieved requests per second over the scenario's own window. */
  rps: number;
  /** Share of responses outside 2xx, in [0, 1]. */
  errorRate: number;
  /**
   * The p95 target this run was judged against, in milliseconds. Absolute for
   * a scenario that declares `sloP95Ms`; otherwise resolved for this run as
   * `floorP50Ms + sloP95AboveFloorMs`.
   */
  sloP95Ms: number;
  /**
   * The budget above the network floor the catalog granted this scenario, when
   * its SLO is expressed that way. Null for an absolute SLO.
   */
  sloP95AboveFloorMs: number | null;
  /**
   * The floor scenario's median latency in this run — what an empty request
   * cost from where the run was measured. Null for an absolute SLO.
   */
  floorP50Ms: number | null;
  sloErrorRate: number;
  sloPass: boolean;
  /**
   * True when the catalog marks the scenario informational (see
   * `ScenarioDefinition.informational`): reported, never verdict-bearing.
   * Absent in documents before schema version 4, which reads as false.
   */
  informational?: boolean;
}

export interface ChangeSetCommit {
  sha: string;
  subject: string;
  author: string;
}

export interface DependencyChange {
  name: string;
  from: string | null;
  to: string | null;
}

/**
 * How much of what shipped this run can say.
 *
 * - `same-build`: the deployment is the build measured last time; any movement
 *   is environmental.
 * - `compare-link`: the build changed and the range is known, but the commits
 *   live in the application repository, which this harness does not read. The
 *   compare link is the attribution.
 * - `commits`: the application repository supplied commit-level detail.
 * - `unavailable`: not even the range is known; `unavailableReason` says why.
 */
export type ChangeSetDetail = "same-build" | "compare-link" | "commits" | "unavailable";

/** What changed between the previously measured build and this one. */
export interface ChangeSet {
  detail: ChangeSetDetail;
  previousAppSha: string | null;
  commits: ChangeSetCommit[];
  /** Migration directories added in the range. */
  migrations: string[];
  dependencies: DependencyChange[];
  compareUrl: string | null;
  /** True when the commit list was cut short; `commits` is then a prefix. */
  truncated: boolean;
  /** Why attribution is unavailable, when it is. */
  unavailableReason: string | null;
}

export type ScenarioVerdict =
  | "pass"
  | "regressed"
  | "slo-breach"
  | "baseline-forming"
  | "missing"
  /** Measured and reported, but by design never bearing on the run's status. */
  | "informational";

export interface ScenarioComparison {
  scenario: string;
  p95: number;
  baselineP95: number | null;
  /** `p95 / baselineP95`; null while the baseline is still forming. */
  ratio: number | null;
  sloP95Ms: number;
  /** See `ScenarioMetrics.sloP95AboveFloorMs`. */
  sloP95AboveFloorMs: number | null;
  floorP50Ms: number | null;
  sloPass: boolean;
  /** See `ScenarioMetrics.informational`. */
  informational: boolean;
  verdict: ScenarioVerdict;
}

export interface BaselineAnalysis {
  /** Comparable runs found, before the trailing window is applied. */
  comparableRuns: number;
  /** Runs actually folded into the median. */
  baselineRuns: number;
  /** True below `MIN_BASELINE_RUNS`: verdicts are informational only. */
  forming: boolean;
  regressionRatio: number;
  scenarios: ScenarioComparison[];
}

export interface RunDocument {
  schemaVersion: number;
  runId: string;
  timestamp: string;
  status: RunStatus;
  trigger: RunTrigger;
  environment: string;
  baseUrl: string;
  /** Commit the measured deployment was built from, per `/api/build-info`. */
  appSha: string | null;
  deploymentId: string | null;
  datasetVersion: string | null;
  workloadVersion: string;
  /**
   * Requests per minute the API allowed this key, which is what bounds the
   * offered load. Recorded because the same workload measured under a different
   * limit is measuring a different thing.
   */
  rateLimitPerMinute: number | null;
  k6Version: string | null;
  durationMs: number;
  /** True when k6 itself reported a threshold breach. */
  thresholdsBreached: boolean;
  scenarios: Record<string, ScenarioMetrics>;
  baseline: BaselineAnalysis | null;
  changeSet: ChangeSet | null;
  /** Anything an operator reading this run after the fact would want told. */
  notes: string[];
}

/**
 * Compact projection appended to `index.ndjson`.
 *
 * The dashboard and the email trend both want hundreds of runs at once, and
 * fetching hundreds of full documents to plot two numbers each would make the
 * page cost grow with history. The index carries exactly what a time series
 * needs plus the path to the full record.
 */
export interface RunSummary {
  runId: string;
  timestamp: string;
  status: RunStatus;
  trigger: RunTrigger;
  environment: string;
  appSha: string | null;
  datasetVersion: string | null;
  workloadVersion: string;
  path: string;
  scenarios: Record<
    string,
    { p95: number; p99: number; rps: number; errorRate: number; sloPass: boolean }
  >;
}

/** A run's file path within the store, relative to its root. */
export function runDocumentPath(document: RunDocument): string {
  const day = document.timestamp.slice(0, 10);
  const build = document.appSha ? document.appSha.slice(0, 7) : "unknown";
  return `runs/${document.environment}/${day}-${build}-${document.runId}.json`;
}

export function toRunSummary(document: RunDocument): RunSummary {
  const scenarios: RunSummary["scenarios"] = {};
  for (const [name, metrics] of Object.entries(document.scenarios)) {
    scenarios[name] = {
      p95: metrics.p95,
      p99: metrics.p99,
      rps: metrics.rps,
      errorRate: metrics.errorRate,
      sloPass: metrics.sloPass,
    };
  }

  return {
    runId: document.runId,
    timestamp: document.timestamp,
    status: document.status,
    trigger: document.trigger,
    environment: document.environment,
    appSha: document.appSha,
    datasetVersion: document.datasetVersion,
    workloadVersion: document.workloadVersion,
    path: runDocumentPath(document),
    scenarios,
  };
}

/**
 * Stable, sortable, collision-free run id. The timestamp prefix means a
 * directory listing is chronological without parsing anything.
 */
export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}
