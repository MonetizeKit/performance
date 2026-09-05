/**
 * Normalization of k6's summary export into Run Document scenario metrics.
 *
 * k6 reports per-metric objects keyed by metric name, with percentiles under
 * whatever `summaryTrendStats` asked for. The Run Document wants a fixed shape
 * per scenario, so the mapping is pinned here rather than assumed at each read
 * site — and a metric k6 did not emit is reported as missing rather than
 * silently defaulting to zero, which would look like a suspiciously fast night.
 */

import {
  durationSeconds,
  isFloorRelative,
  metricSuffix,
  type ScenarioCatalog,
  type ScenarioDefinition,
} from "./scenarios";
import type { ScenarioMetrics } from "./run-document";

interface K6Metric {
  type?: string;
  contains?: string;
  values?: Record<string, number>;
  thresholds?: Record<string, { ok?: boolean }>;
}

export interface K6Summary {
  metrics?: Record<string, K6Metric>;
  state?: { testRunDurationMs?: number };
}

export interface NormalizedSummary {
  scenarios: Record<string, ScenarioMetrics>;
  durationMs: number;
  thresholdsBreached: boolean;
  /** Scenarios declared in the catalog that k6 produced no data for. */
  missing: string[];
}

function trendValue(metric: K6Metric, key: string): number {
  const value = metric.values?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** True when any declared threshold was crossed, across every metric. */
function anyThresholdCrossed(metrics: Record<string, K6Metric>): boolean {
  for (const metric of Object.values(metrics)) {
    for (const threshold of Object.values(metric.thresholds ?? {})) {
      if (threshold.ok === false) return true;
    }
  }
  return false;
}

/**
 * The p95 target a scenario is judged against in this run.
 *
 * A floor-relative target is the floor scenario's median plus the budget: the
 * floor is what an empty request cost from where the run was measured, so what
 * is left is the API's own work. Rounded to whole milliseconds so the figure
 * reads as a target rather than as a measurement.
 */
export function resolveSloP95Ms(scenario: ScenarioDefinition, floorP50Ms: number | null): number {
  if (!isFloorRelative(scenario)) return scenario.sloP95Ms!;
  if (floorP50Ms === null) {
    throw new Error(
      `scenario "${scenario.name}" has a floor-relative SLO but the run produced no floor `
        + "measurement to resolve it from.",
    );
  }
  return Math.round(floorP50Ms + scenario.sloP95AboveFloorMs!);
}

function normalizeScenario(
  scenario: ScenarioDefinition,
  latency: K6Metric,
  failures: K6Metric | undefined,
  floorP50Ms: number | null,
): ScenarioMetrics {
  // A Rate is fed `true` on failure, so `rate` is the error rate and
  // `passes + fails` is the number of observations.
  const passes = failures?.values?.passes ?? 0;
  const fails = failures?.values?.fails ?? 0;
  const requests = passes + fails;
  const errorRate = failures?.values?.rate ?? 0;

  const p95 = trendValue(latency, "p(95)");
  const window = durationSeconds(scenario.duration);
  const relative = isFloorRelative(scenario);
  const sloP95Ms = resolveSloP95Ms(scenario, floorP50Ms);

  return {
    avg: trendValue(latency, "avg"),
    min: trendValue(latency, "min"),
    p50: trendValue(latency, "p(50)"),
    p90: trendValue(latency, "p(90)"),
    p95,
    p99: trendValue(latency, "p(99)"),
    max: trendValue(latency, "max"),
    requests,
    // Achieved rate over the scenario's own window, not the whole run: the
    // scenarios are scheduled one after another, so a run-wide rate would
    // understate every one of them.
    rps: window > 0 ? Number((requests / window).toFixed(3)) : 0,
    errorRate,
    sloP95Ms,
    sloP95AboveFloorMs: relative ? scenario.sloP95AboveFloorMs! : null,
    floorP50Ms: relative ? floorP50Ms : null,
    sloErrorRate: scenario.sloErrorRate,
    sloPass: p95 < sloP95Ms && errorRate <= scenario.sloErrorRate,
    informational: scenario.informational === true,
  };
}

/** The floor scenario's median in this run, or null when it produced no data. */
function measuredFloor(
  metrics: Record<string, K6Metric>,
  catalog: ScenarioCatalog,
): number | null {
  if (!catalog.floorScenario) return null;
  const latency = metrics[`latency_${metricSuffix(catalog.floorScenario)}`];
  if (!latency) return null;
  const p50 = latency.values?.["p(50)"] ?? latency.values?.med;
  return typeof p50 === "number" && Number.isFinite(p50) ? p50 : null;
}

export function normalizeK6Summary(
  summary: K6Summary,
  catalog: ScenarioCatalog,
): NormalizedSummary {
  const metrics = summary.metrics ?? {};
  const scenarios: Record<string, ScenarioMetrics> = {};
  const missing: string[] = [];
  const floorP50Ms = measuredFloor(metrics, catalog);

  for (const scenario of catalog.scenarios) {
    const suffix = metricSuffix(scenario.name);
    const latency = metrics[`latency_${suffix}`];
    if (!latency) {
      missing.push(scenario.name);
      continue;
    }
    if (isFloorRelative(scenario) && floorP50Ms === null) {
      // Data without a target it can be judged against is not a measurement
      // the pipeline can stand behind; report it as missing rather than pass
      // or fail it against a number that was never resolved.
      missing.push(scenario.name);
      continue;
    }
    scenarios[scenario.name] = normalizeScenario(
      scenario,
      latency,
      metrics[`failed_${suffix}`],
      floorP50Ms,
    );
  }

  return {
    scenarios,
    durationMs: Math.round(summary.state?.testRunDurationMs ?? 0),
    thresholdsBreached: anyThresholdCrossed(metrics),
    missing,
  };
}
