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

function normalizeScenario(
  scenario: ScenarioDefinition,
  latency: K6Metric,
  failures: K6Metric | undefined,
): ScenarioMetrics {
  // A Rate is fed `true` on failure, so `rate` is the error rate and
  // `passes + fails` is the number of observations.
  const passes = failures?.values?.passes ?? 0;
  const fails = failures?.values?.fails ?? 0;
  const requests = passes + fails;
  const errorRate = failures?.values?.rate ?? 0;

  const p95 = trendValue(latency, "p(95)");
  const window = durationSeconds(scenario.duration);

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
    sloP95Ms: scenario.sloP95Ms,
    sloErrorRate: scenario.sloErrorRate,
    sloPass: p95 < scenario.sloP95Ms && errorRate <= scenario.sloErrorRate,
  };
}

export function normalizeK6Summary(
  summary: K6Summary,
  catalog: ScenarioCatalog,
): NormalizedSummary {
  const metrics = summary.metrics ?? {};
  const scenarios: Record<string, ScenarioMetrics> = {};
  const missing: string[] = [];

  for (const scenario of catalog.scenarios) {
    const suffix = metricSuffix(scenario.name);
    const latency = metrics[`latency_${suffix}`];
    if (!latency) {
      missing.push(scenario.name);
      continue;
    }
    scenarios[scenario.name] = normalizeScenario(
      scenario,
      latency,
      metrics[`failed_${suffix}`],
    );
  }

  return {
    scenarios,
    durationMs: Math.round(summary.state?.testRunDurationMs ?? 0),
    thresholdsBreached: anyThresholdCrossed(metrics),
    missing,
  };
}
