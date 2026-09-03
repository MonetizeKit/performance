/**
 * The scenario catalog, shared by the k6 entrypoint and every Node-side step.
 *
 * `packages/api-workload/scenarios.json` is the single definition of the
 * workload. k6 reads it with its own `open()`; everything here reads the same
 * file so the SLOs the collector records are provably the SLOs k6 enforced.
 */

import { readFileSync } from "node:fs";

import { SCENARIOS_PATH } from "./paths";

export { SCENARIOS_PATH, SMOKE_SCENARIOS_PATH } from "./paths";

export interface ScenarioDefinition {
  name: string;
  description: string;
  method: string;
  /** False for scenarios that carry no API key, and so spend no rate budget. */
  authenticated: boolean;
  rate: number;
  timeUnit: string;
  duration: string;
  preAllocatedVUs: number;
  sloP95Ms: number;
  sloErrorRate: number;
  writes: boolean;
}

export interface ScenarioCatalog {
  /**
   * Bumped whenever the offered load changes. Runs are only comparable within
   * one workload version, so the analyzer partitions baselines by it.
   */
  workloadVersion: string;
  settleSeconds: number;
  /**
   * Requests per rolling minute the target's API key is allowed. The workload is
   * built to fit inside it; `pnpm perf:run` checks it against the limit the API
   * actually reports before offering any load.
   */
  requestsPerMinuteBudget: number;
  scenarios: ScenarioDefinition[];
}

/** Seconds in a k6 duration string (`"30s"`, `"2m"`). */
export function durationSeconds(duration: string): number {
  const match = /^(\d+)(s|m)$/.exec(duration);
  if (!match) throw new Error(`Unsupported k6 duration "${duration}"`);
  return Number(match[1]) * (match[2] === "m" ? 60 : 1);
}

/** Offered requests per minute for one scenario. */
export function requestsPerMinute(scenario: ScenarioDefinition): number {
  return (scenario.rate / durationSeconds(scenario.timeUnit)) * 60;
}

/**
 * The most authenticated requests any rolling minute of the run will offer.
 *
 * The rate limiter's window is per key and keeps running across the gaps between
 * scenarios, so the budget applies to the run as a whole rather than to each
 * scenario in turn. Because the scenarios are scheduled sequentially, a window
 * straddling a boundary sees a mix of two scenarios and never more than the
 * faster of them — so the busiest scenario is the run's peak.
 */
export function peakRequestsPerMinute(catalog: ScenarioCatalog): number {
  return catalog.scenarios
    .filter((scenario) => scenario.authenticated)
    .reduce((peak, scenario) => Math.max(peak, requestsPerMinute(scenario)), 0);
}

export function loadScenarioCatalog(path: string = SCENARIOS_PATH): ScenarioCatalog {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ScenarioCatalog>;

  if (!raw.workloadVersion) {
    throw new Error(`${path} does not declare a workloadVersion`);
  }
  if (!Array.isArray(raw.scenarios) || raw.scenarios.length === 0) {
    throw new Error(`${path} declares no scenarios`);
  }
  if (!raw.requestsPerMinuteBudget || raw.requestsPerMinuteBudget <= 0) {
    throw new Error(
      `${path} does not declare a requestsPerMinuteBudget. Without it the workload `
        + "cannot be checked against the API's rate limit, and a run that trips it "
        + "measures the limiter rather than the platform.",
    );
  }

  return {
    workloadVersion: raw.workloadVersion,
    settleSeconds: raw.settleSeconds ?? 0,
    requestsPerMinuteBudget: raw.requestsPerMinuteBudget,
    scenarios: raw.scenarios,
  };
}

/** k6 turns scenario names into metric-name fragments this way. */
export function metricSuffix(scenarioName: string): string {
  return scenarioName.replace(/-/g, "_");
}
