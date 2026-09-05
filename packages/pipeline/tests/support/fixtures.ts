/**
 * Run Document builders for the perf-pipeline tests.
 *
 * Written as overrides over a known-good run so each test states only the fact
 * it is about: a test that cares about one scenario's p95 should not also have
 * to spell out a deployment id.
 */

import {
  RUN_DOCUMENT_SCHEMA_VERSION,
  toRunSummary,
  type RunDocument,
  type RunSummary,
  type ScenarioMetrics,
} from "../../src/lib/run-document";
import type { ScenarioCatalog } from "../../src/lib/scenarios";

export function metrics(overrides: Partial<ScenarioMetrics> = {}): ScenarioMetrics {
  return {
    avg: 60,
    min: 20,
    p50: 55,
    p90: 90,
    p95: 100,
    p99: 140,
    max: 300,
    requests: 1200,
    rps: 20,
    errorRate: 0,
    sloP95Ms: 120,
    sloP95AboveFloorMs: null,
    floorP50Ms: null,
    informational: false,
    sloErrorRate: 0.001,
    sloPass: true,
    ...overrides,
  };
}

export function runDocument(overrides: Partial<RunDocument> = {}): RunDocument {
  return {
    schemaVersion: RUN_DOCUMENT_SCHEMA_VERSION,
    runId: "20260830T020000Z-aaaaaa",
    timestamp: "2026-08-30T02:00:00.000Z",
    status: "passed",
    trigger: "schedule",
    environment: "delivery",
    baseUrl: "https://delivery.example.com",
    appSha: "1111111111111111111111111111111111111111",
    deploymentId: "dpl_1",
    datasetVersion: "v2",
    workloadVersion: "w1",
    rateLimitPerMinute: 100,
    k6Version: "1.4.0",
    durationMs: 300_000,
    thresholdsBreached: false,
    scenarios: { "entitlement-check": metrics() },
    baseline: null,
    changeSet: null,
    notes: [],
    ...overrides,
  };
}

/** History entry for `document`, with each scenario's p95 forced to `p95`. */
export function historyEntry(
  document: RunDocument,
  overrides: Partial<RunSummary> & { p95?: number } = {},
): RunSummary {
  const { p95, ...rest } = overrides;
  const summary = toRunSummary(document);

  if (p95 !== undefined) {
    for (const scenario of Object.values(summary.scenarios)) scenario.p95 = p95;
  }

  return { ...summary, ...rest };
}

export function catalog(overrides: Partial<ScenarioCatalog> = {}): ScenarioCatalog {
  return {
    workloadVersion: "w1",
    settleSeconds: 5,
    requestsPerMinuteBudget: 100,
    scenarios: [
      {
        name: "entitlement-check",
        description: "single feature check",
        method: "GET",
        authenticated: true,
        rate: 1,
        timeUnit: "1s",
        duration: "60s",
        preAllocatedVUs: 5,
        sloP95Ms: 120,
        sloErrorRate: 0.001,
        writes: false,
      },
    ],
    ...overrides,
  };
}
