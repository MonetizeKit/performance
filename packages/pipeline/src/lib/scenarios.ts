/**
 * The scenario catalog, shared by the k6 entrypoint and every Node-side step.
 *
 * `packages/api-workload/scenarios.json` is the single definition of the
 * workload. k6 reads it with its own `open()`; everything here reads the same
 * file, so an absolute SLO the collector records is provably the one k6
 * enforced, and a floor-relative one is resolved from the same catalog k6 ran.
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
  /**
   * Absolute p95 target in milliseconds. Exactly one of this and
   * `sloP95AboveFloorMs` is set.
   */
  sloP95Ms?: number;
  /**
   * p95 budget above the network floor, in milliseconds. The target is
   * resolved per run as the floor scenario's p50 plus this budget, so a
   * scenario is judged on the work the API did rather than on how far the
   * runner happens to sit from the deployment.
   */
  sloP95AboveFloorMs?: number;
  sloErrorRate: number;
  writes: boolean;
  /**
   * True for scenarios that measure the platform or the runner's own network
   * rather than the API: their numbers are recorded and charted, their target
   * is still resolved and reported, but a miss or a regression on them never
   * decides the run's verdict. Only an unauthenticated scenario may be
   * informational — an authenticated one is, by definition, API work.
   */
  informational?: boolean;
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
  /**
   * The scenario whose p50 is the network floor for every `sloP95AboveFloorMs`
   * target. Unauthenticated, no query cost, and offered at the same rate and
   * concurrency as the scenarios it floors — a floor measured under different
   * concurrency measures cold starts, not the network.
   */
  floorScenario?: string;
  scenarios: ScenarioDefinition[];
}

/** True when the scenario's target is a budget above the floor. */
export function isFloorRelative(scenario: ScenarioDefinition): boolean {
  return typeof scenario.sloP95AboveFloorMs === "number";
}

/**
 * Check that every scenario's SLO is expressible: one target each, and a floor
 * to stand on wherever a target is relative to it.
 */
export function validateSloDeclarations(catalog: ScenarioCatalog, path: string): void {
  const names = new Set(catalog.scenarios.map((scenario) => scenario.name));
  const floor = catalog.floorScenario
    ? catalog.scenarios.find((scenario) => scenario.name === catalog.floorScenario)
    : undefined;

  for (const scenario of catalog.scenarios) {
    if (scenario.informational && scenario.authenticated) {
      throw new Error(
        `${path}: scenario "${scenario.name}" is authenticated and cannot be informational — `
          + "an authenticated scenario measures API work and must bear on the verdict",
      );
    }
  }

  if (catalog.floorScenario !== undefined) {
    if (!floor) {
      throw new Error(
        `${path} names "${catalog.floorScenario}" as its floorScenario but declares no such scenario.`,
      );
    }
    if (floor.authenticated) {
      throw new Error(
        `${path}: floorScenario "${floor.name}" is authenticated. The floor must carry no `
          + "query cost or key budget, or it measures the API rather than the distance to it.",
      );
    }
    if (typeof floor.sloP95Ms !== "number") {
      throw new Error(
        `${path}: floorScenario "${floor.name}" must declare an absolute sloP95Ms; a floor `
          + "cannot be relative to itself.",
      );
    }
  }

  for (const scenario of catalog.scenarios) {
    const absolute = typeof scenario.sloP95Ms === "number";
    const relative = typeof scenario.sloP95AboveFloorMs === "number";
    if (absolute === relative) {
      throw new Error(
        `${path}: scenario "${scenario.name}" must declare exactly one of sloP95Ms `
          + `(absolute) or sloP95AboveFloorMs (budget above the floor); it declares `
          + `${absolute ? "both" : "neither"}.`,
      );
    }
    if (relative && !floor) {
      throw new Error(
        `${path}: scenario "${scenario.name}" declares sloP95AboveFloorMs but the catalog `
          + "names no floorScenario to measure it from.",
      );
    }
    if ((absolute && scenario.sloP95Ms! <= 0) || (relative && scenario.sloP95AboveFloorMs! <= 0)) {
      throw new Error(`${path}: scenario "${scenario.name}" declares a non-positive p95 target.`);
    }
  }

  if (floor && names.size !== catalog.scenarios.length) {
    throw new Error(`${path} declares duplicate scenario names.`);
  }
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

  const catalog: ScenarioCatalog = {
    workloadVersion: raw.workloadVersion,
    settleSeconds: raw.settleSeconds ?? 0,
    requestsPerMinuteBudget: raw.requestsPerMinuteBudget,
    scenarios: raw.scenarios,
  };
  if (raw.floorScenario !== undefined) catalog.floorScenario = raw.floorScenario;
  validateSloDeclarations(catalog, path);
  return catalog;
}

/** k6 turns scenario names into metric-name fragments this way. */
export function metricSuffix(scenarioName: string): string {
  return scenarioName.replace(/-/g, "_");
}
