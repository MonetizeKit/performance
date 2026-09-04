/**
 * Baselines and regression verdicts.
 *
 * A single run's p95 says almost nothing: serverless cold starts, a noisy
 * neighbour on the database, or one unlucky GC pause all move it. So the
 * reference is the median of the recent comparable runs, which is robust to the
 * occasional bad night in a way a mean or a previous-run comparison is not.
 *
 * "Comparable" is strict on purpose. A run measured against a different
 * environment, a different offered load, or a different dataset is measuring a
 * different system, and averaging it in would hide real regressions behind
 * unrelated variance. Ad-hoc runs are excluded for the same reason — a developer
 * running the suite from a laptop over home broadband must not move the
 * nightly's reference.
 */

import type {
  BaselineAnalysis,
  RunDocument,
  RunStatus,
  RunSummary,
  ScenarioComparison,
  ScenarioVerdict,
} from "./run-document";

/** Runs folded into the median. Two weeks of nightlies. */
export const BASELINE_WINDOW = 14;

/** Below this the median is too thin to accuse anything of regressing. */
export const MIN_BASELINE_RUNS = 5;

/** A scenario is regressed once its p95 exceeds the baseline by this factor. */
export const REGRESSION_RATIO = 1.2;

/**
 * ...and by at least this many milliseconds.
 *
 * A ratio alone cannot tell a regression from noise on a fast scenario. The
 * first run to form a baseline in rehearsal flagged an unauthenticated read that
 * went from a 12ms median to 17ms: +48% by ratio, 5ms in reality, and entirely
 * within the jitter of the machine it ran on. A nightly that reports that as a
 * regression teaches its readers to ignore it inside a week, which costs far
 * more than the occasional missed 15ms.
 *
 * The floor is absolute rather than a share of the SLO because what makes a
 * delta worth a human's attention is how big it is, not how close the scenario
 * happens to sit to its target.
 */
export const MIN_REGRESSION_DELTA_MS = 20;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Runs that measured the same system as `document`, most recent first.
 *
 * Only successful scheduled runs qualify: a failed run's numbers are partial by
 * definition, and a dispatched or local run may have been aimed at something
 * else entirely.
 */
export function comparableRuns(
  document: RunDocument,
  history: readonly RunSummary[],
): RunSummary[] {
  return history
    .filter(
      (run) =>
        run.runId !== document.runId &&
        run.environment === document.environment &&
        run.workloadVersion === document.workloadVersion &&
        run.datasetVersion === document.datasetVersion &&
        run.trigger === "schedule" &&
        run.status !== "failed",
    )
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}

function verdictFor(
  p95: number,
  baselineP95: number | null,
  ratio: number | null,
  sloPass: boolean,
  forming: boolean,
): ScenarioVerdict {
  // A regression is judged first, because it is the news: something moved
  // tonight. A scenario that has sat outside its SLO for a month and then
  // doubles must say "regressed", or the doubling hides behind a verdict the
  // reader stopped looking at weeks ago. `sloPass` is carried beside the
  // verdict, so the breach is never lost either way.
  const compared = ratio !== null && baselineP95 !== null;
  const regressed =
    compared && ratio > REGRESSION_RATIO && p95 - baselineP95 >= MIN_REGRESSION_DELTA_MS;
  if (regressed && !forming) return "regressed";

  // An SLO breach is a breach whatever the history says: the target is the
  // promise, and the baseline only describes what has been happening.
  if (!sloPass) return "slo-breach";
  if (!compared || regressed) return "baseline-forming";
  return "pass";
}

export function analyzeBaseline(
  document: RunDocument,
  history: readonly RunSummary[],
): BaselineAnalysis {
  const comparable = comparableRuns(document, history);
  const window = comparable.slice(0, BASELINE_WINDOW);
  const forming = window.length < MIN_BASELINE_RUNS;

  const scenarios: ScenarioComparison[] = Object.entries(document.scenarios).map(
    ([name, metrics]) => {
      const observations = window
        .map((run) => run.scenarios[name]?.p95)
        .filter((value): value is number => typeof value === "number");

      const baselineP95 = forming ? null : median(observations);
      const ratio =
        baselineP95 !== null && baselineP95 > 0
          ? Number((metrics.p95 / baselineP95).toFixed(4))
          : null;

      return {
        scenario: name,
        p95: metrics.p95,
        baselineP95,
        ratio,
        sloP95Ms: metrics.sloP95Ms,
        // Older documents predate these fields; read them as absolute targets.
        sloP95AboveFloorMs: metrics.sloP95AboveFloorMs ?? null,
        floorP50Ms: metrics.floorP50Ms ?? null,
        sloPass: metrics.sloPass,
        verdict: verdictFor(metrics.p95, baselineP95, ratio, metrics.sloPass, forming),
      };
    },
  );

  return {
    comparableRuns: comparable.length,
    baselineRuns: window.length,
    forming,
    regressionRatio: REGRESSION_RATIO,
    scenarios,
  };
}

/**
 * The run's overall status.
 *
 * A run that could not complete stays `failed` whatever the analysis says —
 * partial measurements must never be reported as a pass. Otherwise a regression
 * outranks an SLO breach: the breach may have been true every night this month,
 * while the regression says something changed since last night, and that is the
 * one somebody has to look at before the next deploy.
 */
export function statusFrom(
  analysis: BaselineAnalysis,
  runFailed: boolean,
): RunStatus {
  if (runFailed) return "failed";
  if (analysis.scenarios.some((scenario) => scenario.verdict === "regressed")) return "regressed";
  if (analysis.scenarios.some((scenario) => !scenario.sloPass)) return "slo-breach";
  return "passed";
}

/**
 * Scenarios a report should lead with: regressions first (they are what changed),
 * then SLO breaches, each group worst first.
 */
export function offenders(analysis: BaselineAnalysis): ScenarioComparison[] {
  const rank: Record<ScenarioVerdict, number> = {
    regressed: 0,
    "slo-breach": 1,
    "baseline-forming": 2,
    missing: 3,
    pass: 4,
  };
  return [...analysis.scenarios]
    .filter((scenario) => scenario.verdict === "regressed" || !scenario.sloPass)
    .sort((left, right) => {
      const byVerdict = rank[left.verdict] - rank[right.verdict];
      if (byVerdict !== 0) return byVerdict;
      return (right.ratio ?? 0) - (left.ratio ?? 0);
    });
}
