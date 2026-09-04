/**
 * The collector is the only place raw k6 output is interpreted, so a mistake
 * here silently changes what every baseline, email and chart afterwards claims.
 * These tests pin the two failure modes that would be hardest to notice: a
 * scenario that did not run being reported as instant, and an error rate being
 * read off the wrong field.
 */

import { describe, expect, it } from "vitest";

import { normalizeK6Summary } from "../src/lib/k6-summary";

import { catalog } from "./support/fixtures";

function summaryFor(
  values: Record<string, number>,
  failures?: Record<string, number>,
  thresholds?: Record<string, { ok?: boolean }>,
) {
  return {
    state: { testRunDurationMs: 65_432.7 },
    metrics: {
      latency_entitlement_check: { type: "trend", values, thresholds },
      ...(failures
        ? { failed_entitlement_check: { type: "rate", values: failures } }
        : {}),
    },
  };
}

const TIMINGS = {
  avg: 61.2,
  min: 20.4,
  med: 55,
  "p(50)": 55,
  "p(90)": 92.5,
  "p(95)": 104.8,
  "p(99)": 180.1,
  max: 402,
};

describe("k6 summary normalization", () => {
  it("maps k6 trend percentiles onto the Run Document shape", () => {
    const normalized = normalizeK6Summary(
      summaryFor(TIMINGS, { rate: 0, passes: 1200, fails: 0 }),
      catalog(),
    );

    expect(normalized.scenarios["entitlement-check"]).toMatchObject({
      avg: 61.2,
      p50: 55,
      p90: 92.5,
      p95: 104.8,
      p99: 180.1,
      max: 402,
      requests: 1200,
      errorRate: 0,
      sloP95Ms: 120,
      sloPass: true,
    });
    expect(normalized.durationMs).toBe(65_433);
    expect(normalized.missing).toEqual([]);
  });

  it("reports a scenario k6 produced no data for as missing, not as zero", () => {
    const normalized = normalizeK6Summary({ metrics: {} }, catalog());

    // Zeroes would read as a spectacularly fast night and would drag every
    // subsequent baseline down with them.
    expect(normalized.scenarios).toEqual({});
    expect(normalized.missing).toEqual(["entitlement-check"]);
  });

  it("derives requests and rate from the failure Rate metric", () => {
    const normalized = normalizeK6Summary(
      summaryFor(TIMINGS, { rate: 0.02, passes: 980, fails: 20 }),
      catalog(),
    );
    const scenario = normalized.scenarios["entitlement-check"]!;

    expect(scenario.requests).toBe(1000);
    expect(scenario.errorRate).toBe(0.02);
    // 1000 observations over the scenario's own 60s window, not the whole run:
    // the scenarios are scheduled back to back.
    expect(scenario.rps).toBeCloseTo(16.667, 2);
  });

  it("fails the SLO on the error budget even when latency is comfortable", () => {
    const normalized = normalizeK6Summary(
      summaryFor(TIMINGS, { rate: 0.05, passes: 950, fails: 50 }),
      catalog(),
    );

    expect(normalized.scenarios["entitlement-check"]!.sloPass).toBe(false);
  });

  it("surfaces a crossed k6 threshold from any metric", () => {
    const clean = normalizeK6Summary(
      summaryFor(TIMINGS, { rate: 0, passes: 10, fails: 0 }, { "p(95)<120": { ok: true } }),
      catalog(),
    );
    const breached = normalizeK6Summary(
      summaryFor(TIMINGS, { rate: 0, passes: 10, fails: 0 }, { "p(95)<120": { ok: false } }),
      catalog(),
    );

    expect(clean.thresholdsBreached).toBe(false);
    expect(breached.thresholdsBreached).toBe(true);
  });
});

describe("floor-relative SLOs", () => {
  const floored = () =>
    catalog({
      floorScenario: "network-floor",
      scenarios: [
        {
          ...catalog().scenarios[0]!,
          name: "network-floor",
          authenticated: false,
          sloP95Ms: 250,
        },
        { ...catalog().scenarios[0]!, sloP95Ms: undefined, sloP95AboveFloorMs: 75 },
      ],
    });

  function floorSummary(floorP50: number | null, checkP95: number) {
    return {
      metrics: {
        ...(floorP50 !== null
          ? {
              latency_network_floor: {
                type: "trend",
                values: { ...TIMINGS, "p(50)": floorP50, "p(95)": floorP50 + 20 },
              },
              failed_network_floor: { type: "rate", values: { rate: 0, passes: 60, fails: 0 } },
            }
          : {}),
        latency_entitlement_check: { type: "trend", values: { ...TIMINGS, "p(95)": checkP95 } },
        failed_entitlement_check: { type: "rate", values: { rate: 0, passes: 600, fails: 0 } },
      },
    };
  }

  it("resolves the target for the run as the floor's median plus the budget", () => {
    // 95ms to reach an empty route, 75ms of allowed work: a 136ms p95 from the
    // same vantage is 41ms of API time, and passes.
    const normalized = normalizeK6Summary(floorSummary(95.4, 136), floored());

    expect(normalized.scenarios["entitlement-check"]).toMatchObject({
      sloP95Ms: 170,
      sloP95AboveFloorMs: 75,
      floorP50Ms: 95.4,
      sloPass: true,
    });
    expect(normalized.scenarios["network-floor"]).toMatchObject({
      sloP95Ms: 250,
      sloP95AboveFloorMs: null,
      floorP50Ms: null,
    });
  });

  it("judges the same API work the same from a nearer or farther vantage", () => {
    // 310ms of p95 is a breach from 95ms away and a pass from 240ms away,
    // because the API did 215ms of work in the first case and 70ms in the second.
    const far = normalizeK6Summary(floorSummary(240, 310), floored());
    const near = normalizeK6Summary(floorSummary(95, 310), floored());

    expect(far.scenarios["entitlement-check"]!.sloPass).toBe(true);
    expect(near.scenarios["entitlement-check"]!.sloPass).toBe(false);
  });

  it("reports a relative scenario as missing when the floor produced no data", () => {
    // Passing or failing it against a number that was never resolved would be
    // a verdict with nothing behind it.
    const normalized = normalizeK6Summary(floorSummary(null, 136), floored());

    expect(normalized.scenarios["entitlement-check"]).toBeUndefined();
    expect(normalized.missing).toEqual(["network-floor", "entitlement-check"]);
  });
});
