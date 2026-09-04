/**
 * The baseline decides what counts as a regression, so the expensive mistakes it
 * can make are both directions of wrong: crying regression against runs that
 * measured something else, or averaging incomparable runs in until a real
 * regression disappears into the noise. Both are pinned here.
 */

import { describe, expect, it } from "vitest";

import {
  BASELINE_WINDOW,
  MIN_BASELINE_RUNS,
  REGRESSION_RATIO,
  analyzeBaseline,
  comparableRuns,
  median,
  offenders,
  statusFrom,
} from "../src/lib/baseline";

import { historyEntry, metrics, runDocument } from "./support/fixtures";

/** `count` nightly runs, each with the same p95, walking backwards in time. */
function nightlies(count: number, p95: number, overrides = {}) {
  return Array.from({ length: count }, (_unused, index) =>
    historyEntry(runDocument(), {
      runId: `night-${index}`,
      timestamp: `2026-08-${String(10 + index).padStart(2, "0")}T02:00:00.000Z`,
      p95,
      ...overrides,
    }),
  );
}

describe("median", () => {
  it("takes the middle of an odd count and the mean of the middle pair", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("comparability", () => {
  it("excludes runs that measured a different system", () => {
    const document = runDocument();
    const history = [
      ...nightlies(1, 100, { runId: "same" }),
      ...nightlies(1, 100, { runId: "other-env", environment: "production" }),
      ...nightlies(1, 100, { runId: "other-workload", workloadVersion: "w2" }),
      ...nightlies(1, 100, { runId: "other-dataset", datasetVersion: "v3" }),
    ];

    expect(comparableRuns(document, history).map((run) => run.runId)).toEqual(["same"]);
  });

  it("excludes local and dispatched runs, and failed ones", () => {
    const document = runDocument();
    const history = [
      ...nightlies(1, 100, { runId: "scheduled" }),
      ...nightlies(1, 100, { runId: "laptop", trigger: "local" }),
      ...nightlies(1, 100, { runId: "rerun", trigger: "dispatch" }),
      ...nightlies(1, 100, { runId: "broken", status: "failed" }),
    ];

    expect(comparableRuns(document, history).map((run) => run.runId)).toEqual([
      "scheduled",
    ]);
  });

  it("never compares a run against itself", () => {
    const document = runDocument();
    const history = [historyEntry(document, { p95: 100 })];

    expect(comparableRuns(document, history)).toEqual([]);
  });

  it("returns the most recent run first", () => {
    const analysis = comparableRuns(runDocument(), nightlies(3, 100));

    expect(analysis[0]!.timestamp > analysis[2]!.timestamp).toBe(true);
  });
});

describe("baseline analysis", () => {
  it("withholds verdicts until enough runs exist to take a median of", () => {
    const document = runDocument({ scenarios: { "entitlement-check": metrics({ p95: 400 }) } });
    const analysis = analyzeBaseline(document, nightlies(MIN_BASELINE_RUNS - 1, 100));

    expect(analysis.forming).toBe(true);
    expect(analysis.baselineRuns).toBe(MIN_BASELINE_RUNS - 1);
    // 4x the recent runs, but with a thin history the honest answer is "not yet
    // enough to say" rather than an accusation.
    expect(analysis.scenarios[0]!.baselineP95).toBeNull();
    expect(analysis.scenarios[0]!.verdict).toBe("baseline-forming");
    expect(statusFrom(analysis, false)).toBe("passed");
  });

  it("calls a regression once the ratio clears the tolerance", () => {
    const history = nightlies(MIN_BASELINE_RUNS, 100);

    const within = analyzeBaseline(
      runDocument({ scenarios: { "entitlement-check": metrics({ p95: 119 }) } }),
      history,
    );
    const beyond = analyzeBaseline(
      runDocument({ scenarios: { "entitlement-check": metrics({ p95: 121 }) } }),
      history,
    );

    expect(within.scenarios[0]!.ratio).toBe(1.19);
    expect(within.scenarios[0]!.verdict).toBe("pass");
    expect(beyond.scenarios[0]!.verdict).toBe("regressed");
    expect(statusFrom(beyond, false)).toBe("regressed");
  });

  it("reports a regression ahead of an SLO breach: the regression is what changed", () => {
    const scenarios = {
      // Over its target but flat against the baseline: a miss, not a change.
      "entitlement-check": metrics({ p95: 115, sloP95Ms: 110, sloPass: false }),
      // Under its target but half again slower than every recent night.
      "catalog-reads": metrics({ p95: 150, sloP95Ms: 200 }),
    };
    const document = runDocument({ scenarios });
    const analysis = analyzeBaseline(
      document,
      Array.from({ length: MIN_BASELINE_RUNS }, (_unused, index) =>
        historyEntry(runDocument({ scenarios }), {
          runId: `night-${index}`,
          timestamp: `2026-08-${String(10 + index).padStart(2, "0")}T02:00:00.000Z`,
          p95: 100,
        }),
      ),
    );

    expect(analysis.scenarios[0]!.verdict).toBe("slo-breach");
    expect(analysis.scenarios[1]!.verdict).toBe("regressed");
    expect(offenders(analysis).map((scenario) => scenario.scenario)).toEqual([
      "catalog-reads",
      "entitlement-check",
    ]);
    expect(statusFrom(analysis, false)).toBe("regressed");
  });

  it("calls a scenario that regressed and misses its SLO 'regressed', keeping the breach beside it", () => {
    // Under the old rule a scenario already outside its SLO could double and
    // still read "slo-breach": the change hid behind a verdict nobody was
    // reading any more.
    const scenarios = { "entitlement-check": metrics({ p95: 260, sloP95Ms: 120, sloPass: false }) };
    const analysis = analyzeBaseline(
      runDocument({ scenarios }),
      Array.from({ length: MIN_BASELINE_RUNS }, (_unused, index) =>
        historyEntry(runDocument({ scenarios }), {
          runId: `night-${index}`,
          timestamp: `2026-08-${String(10 + index).padStart(2, "0")}T02:00:00.000Z`,
          p95: 130,
        }),
      ),
    );

    expect(analysis.scenarios[0]).toMatchObject({ verdict: "regressed", sloPass: false });
    expect(offenders(analysis)).toHaveLength(1);
  });

  it("gives a run that missed a target without moving its own status, not 'regressed'", () => {
    // The first nightly had nothing to regress from and reported REGRESSION
    // for eight SLO misses. A miss with a flat (or absent) baseline is a
    // different finding for a different person, and the status has to say so.
    const scenarios = { "entitlement-check": metrics({ p95: 130, sloPass: false }) };
    const document = runDocument({ scenarios });

    const noHistory = analyzeBaseline(document, []);
    expect(noHistory.scenarios[0]!.verdict).toBe("slo-breach");
    expect(statusFrom(noHistory, false)).toBe("slo-breach");

    const flat = analyzeBaseline(
      document,
      Array.from({ length: MIN_BASELINE_RUNS }, (_unused, index) =>
        historyEntry(runDocument({ scenarios }), {
          runId: `night-${index}`,
          timestamp: `2026-08-${String(10 + index).padStart(2, "0")}T02:00:00.000Z`,
          p95: 130,
        }),
      ),
    );
    expect(flat.scenarios[0]!.verdict).toBe("slo-breach");
    expect(statusFrom(flat, false)).toBe("slo-breach");
    expect(statusFrom(flat, true)).toBe("failed");
  });

  it("carries a floor-relative target through to the comparison", () => {
    const analysis = analyzeBaseline(
      runDocument({
        scenarios: {
          "entitlement-check": metrics({ p95: 170, sloP95Ms: 170, sloP95AboveFloorMs: 75, floorP50Ms: 95, sloPass: false }),
        },
      }),
      [],
    );

    expect(analysis.scenarios[0]).toMatchObject({ sloP95Ms: 170, sloP95AboveFloorMs: 75, floorP50Ms: 95 });
  });

  it("takes the median of the trailing window and ignores older runs", () => {
    // Older runs are much slower; a mean over all history would hide a real
    // regression behind them.
    const recent = nightlies(BASELINE_WINDOW, 100).map((run, index) => ({
      ...run,
      timestamp: `2026-08-${String(10 + index).padStart(2, "0")}T02:00:00.000Z`,
    }));
    const ancient = nightlies(10, 1000).map((run, index) => ({
      ...run,
      runId: `old-${index}`,
      timestamp: `2026-07-${String(1 + index).padStart(2, "0")}T02:00:00.000Z`,
    }));

    const analysis = analyzeBaseline(
      runDocument({ scenarios: { "entitlement-check": metrics({ p95: 200 }) } }),
      [...ancient, ...recent],
    );

    expect(analysis.comparableRuns).toBe(BASELINE_WINDOW + 10);
    expect(analysis.baselineRuns).toBe(BASELINE_WINDOW);
    expect(analysis.scenarios[0]!.baselineP95).toBe(100);
    expect(analysis.scenarios[0]!.verdict).toBe("regressed");
  });

  it("ignores a scenario the history has no observations for", () => {
    // A newly added scenario has nothing to compare against even though the run
    // count is healthy.
    const analysis = analyzeBaseline(
      runDocument({ scenarios: { "brand-new": metrics({ p95: 100 }) } }),
      nightlies(MIN_BASELINE_RUNS, 100),
    );

    expect(analysis.scenarios[0]!.baselineP95).toBeNull();
    expect(analysis.scenarios[0]!.verdict).toBe("baseline-forming");
  });

  it("keeps an incomplete run failed however good its numbers look", () => {
    const analysis = analyzeBaseline(runDocument(), nightlies(MIN_BASELINE_RUNS, 100));

    expect(statusFrom(analysis, true)).toBe("failed");
  });
});

describe("the absolute floor on a regression", () => {
  it("ignores a large ratio that is a small number of milliseconds", () => {
    // Observed for real: an unauthenticated read went 12ms to 17ms across a
    // rehearsal series. That is +48% and five milliseconds, and reporting it
    // as a regression is how a nightly loses its audience.
    const document = runDocument({
      scenarios: { "entitlement-check": metrics({ p95: 17 }) },
    });

    const analysis = analyzeBaseline(document, nightlies(6, 12));

    expect(analysis.forming).toBe(false);
    expect(analysis.scenarios[0]!.ratio).toBeGreaterThan(REGRESSION_RATIO);
    expect(analysis.scenarios[0]!.verdict).toBe("pass");
  });

  it("still reports a large ratio that is a large number of milliseconds", () => {
    const document = runDocument({
      scenarios: { "entitlement-check": metrics({ p95: 900, sloP95Ms: 2000 }) },
    });

    const analysis = analyzeBaseline(document, nightlies(6, 600));

    expect(analysis.scenarios[0]!.verdict).toBe("regressed");
  });

  it("reports a breach of the SLO however small the delta", () => {
    // The floor governs regression against history, never the promise itself.
    const document = runDocument({
      scenarios: { "entitlement-check": metrics({ p95: 17, sloP95Ms: 15, sloPass: false }) },
    });

    const analysis = analyzeBaseline(document, nightlies(6, 12));

    expect(analysis.scenarios[0]!.verdict).toBe("slo-breach");
  });
});
