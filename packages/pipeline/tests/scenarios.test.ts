/**
 * The committed workload is what makes one night's numbers comparable to the
 * next, so it is treated as a contract rather than configuration. These tests
 * guard the invariants that k6 would otherwise discover at 2am, and the ones
 * that would quietly make a baseline meaningless.
 */

import { isAbsolute } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SCENARIOS_PATH,
  SMOKE_SCENARIOS_PATH,
  durationSeconds,
  isFloorRelative,
  loadScenarioCatalog,
  metricSuffix,
  peakRequestsPerMinute,
  requestsPerMinute,
  validateSloDeclarations,
} from "../src/lib/scenarios";

import { catalog as catalogFixture } from "./support/fixtures";

const catalog = loadScenarioCatalog();

describe("duration parsing", () => {
  it("reads k6 second and minute durations", () => {
    expect(durationSeconds("30s")).toBe(30);
    expect(durationSeconds("2m")).toBe(120);
  });

  it("refuses a unit k6 accepts but the collector cannot convert", () => {
    // A silently mis-parsed duration would corrupt every derived rps value.
    expect(() => durationSeconds("1h")).toThrow(/Unsupported/);
    expect(() => durationSeconds("90")).toThrow(/Unsupported/);
  });
});

describe("the committed scenario catalog", () => {
  it("declares a workload version, which partitions baselines", () => {
    expect(catalog.workloadVersion).toMatch(/^w\d+$/);
  });

  it("gives every scenario a unique name that survives metric naming", () => {
    const names = catalog.scenarios.map((scenario) => scenario.name);
    const suffixes = names.map(metricSuffix);

    expect(new Set(names).size).toBe(names.length);
    // Two names differing only in `-` vs `_` would collapse into one k6 metric.
    expect(new Set(suffixes).size).toBe(suffixes.length);
  });

  it("keeps every scenario's load fixed and offered rather than open-ended", () => {
    for (const scenario of catalog.scenarios) {
      expect(scenario.rate, scenario.name).toBeGreaterThan(0);
      expect(scenario.preAllocatedVUs, scenario.name).toBeGreaterThan(0);
      expect(scenario.timeUnit, scenario.name).toMatch(/^\d+(s|m)$/);
      expect(() => durationSeconds(scenario.duration)).not.toThrow();
    }
  });

  it("sets exactly one p95 target and an error budget on every scenario", () => {
    for (const scenario of catalog.scenarios) {
      const target = scenario.sloP95Ms ?? scenario.sloP95AboveFloorMs;
      expect(target, scenario.name).toBeGreaterThan(0);
      expect(
        typeof scenario.sloP95Ms === "number" && typeof scenario.sloP95AboveFloorMs === "number",
        `${scenario.name} declares both an absolute and a floor-relative target`,
      ).toBe(false);
      expect(scenario.sloErrorRate, scenario.name).toBeGreaterThanOrEqual(0);
      expect(scenario.sloErrorRate, scenario.name).toBeLessThan(1);
      expect(scenario.description.length, scenario.name).toBeGreaterThan(20);
    }
  });

  it("judges every authenticated scenario on its work above a floor measured the same way", () => {
    // A floor offered at a different concurrency measures cold starts rather
    // than the network, so it has to share the authenticated scenarios' shape.
    const floor = catalog.scenarios.find((scenario) => scenario.name === catalog.floorScenario);
    expect(floor).toBeDefined();
    expect(floor!.authenticated).toBe(false);
    expect(typeof floor!.sloP95Ms).toBe("number");

    const authenticated = catalog.scenarios.filter((scenario) => scenario.authenticated);
    for (const scenario of authenticated) {
      expect(isFloorRelative(scenario), scenario.name).toBe(true);
      expect(requestsPerMinute(scenario), scenario.name).toBeLessThanOrEqual(requestsPerMinute(floor!));
      expect(scenario.preAllocatedVUs, scenario.name).toBeLessThanOrEqual(floor!.preAllocatedVUs);
    }
    // ...and the floor has enough samples for its median to hold still.
    expect(requestsPerMinute(floor!) * (durationSeconds(floor!.duration) / 60)).toBeGreaterThanOrEqual(60);
  });

  it("keeps the smoke catalog on the same rules", () => {
    expect(() => loadScenarioCatalog(SMOKE_SCENARIOS_PATH)).not.toThrow();
  });

  it("describes a run that fits comfortably inside a nightly window", () => {
    const wall = catalog.scenarios.reduce(
      (total, scenario) => total + durationSeconds(scenario.duration) + catalog.settleSeconds,
      0,
    );

    // Sequential scenarios make the run as long as the sum of its parts; a
    // workload that grew past the schedule would start colliding with itself.
    // Seven authenticated scenarios at ten minutes each is the floor that buys
    // 600 samples apiece under the rate limit; the ceiling is the nightly
    // window before the next scheduled job wants the same tenant.
    expect(wall).toBeGreaterThanOrEqual(70 * 60);
    expect(wall).toBeLessThan(90 * 60);
  });

  it("gives every authenticated scenario enough samples for a p95 to mean something", () => {
    // p95 rests on the slowest 5% of samples: at 120 samples that is six
    // observations and one cold start moves it; at 600 it is thirty.
    for (const scenario of catalog.scenarios.filter((entry) => entry.authenticated)) {
      const samples =
        scenario.rate * (durationSeconds(scenario.duration) / durationSeconds(scenario.timeUnit));
      expect(samples, scenario.name).toBeGreaterThanOrEqual(100);
    }
  });

  it("bounds what the write scenarios leave behind", () => {
    // Usage events are billing records and outlive the probe customer, so the
    // nightly's storage cost is a property of the catalog, not of the cleanup.
    const rows = catalog.scenarios
      .filter((scenario) => scenario.writes)
      .reduce((total, scenario) => {
        const iterations =
          scenario.rate
          * (durationSeconds(scenario.duration) / durationSeconds(scenario.timeUnit));
        const perIteration = scenario.name === "usage-ingest-batch" ? 500 : 1;
        return total + iterations * perIteration;
      }, 0);

    expect(rows).toBeLessThanOrEqual(60_000);
  });

  it("fits inside the API rate limit it declares", () => {
    // A workload above the limit does not measure the platform, it measures the
    // limiter — fifteen minutes of 429s that the analyzer would then faithfully
    // call a regression.
    expect(peakRequestsPerMinute(catalog)).toBeLessThanOrEqual(
      catalog.requestsPerMinuteBudget,
    );
  });

  it("leaves the budget room for the run's own setup and preflight", () => {
    // Setup provisions the probe customer, teardown archives it, and perf:run
    // preflights the key: roughly ten authenticated calls that share the window
    // with the first scenario.
    expect(peakRequestsPerMinute(catalog)).toBeLessThanOrEqual(
      catalog.requestsPerMinuteBudget - 10,
    );
  });

  it("is the same file k6 opens, wherever the command is run from", () => {
    expect(SCENARIOS_PATH).toMatch(/[\\/]packages[\\/]api-workload[\\/]scenarios\.json$/);
    expect(isAbsolute(SCENARIOS_PATH)).toBe(true);
  });

  it("marks exactly the network floor and the platform baseline informational", () => {
    // Everything else is API work and has to bear on the verdict.
    for (const path of [SCENARIOS_PATH, SMOKE_SCENARIOS_PATH]) {
      const loaded = loadScenarioCatalog(path);
      const informational = loaded.scenarios
        .filter((scenario) => scenario.informational)
        .map((scenario) => scenario.name)
        .sort();

      expect(informational, path).toEqual(["network-floor", "platform-baseline"]);
      for (const scenario of loaded.scenarios.filter((entry) => entry.authenticated)) {
        expect(scenario.informational, scenario.name).not.toBe(true);
      }
    }
  });
});

describe("SLO declarations", () => {
  const floor = {
    ...catalogFixture().scenarios[0]!,
    name: "network-floor",
    authenticated: false,
    sloP95Ms: 250,
  };
  const relative = { ...catalogFixture().scenarios[0]!, sloP95Ms: undefined, sloP95AboveFloorMs: 75 };

  it("accepts an absolute target, or a budget above a declared floor", () => {
    expect(() => validateSloDeclarations(catalogFixture(), "test")).not.toThrow();
    expect(() =>
      validateSloDeclarations(
        catalogFixture({ floorScenario: "network-floor", scenarios: [floor, relative] }),
        "test",
      ),
    ).not.toThrow();
  });

  it("refuses a scenario with both targets, or with neither", () => {
    expect(() =>
      validateSloDeclarations(
        catalogFixture({ scenarios: [{ ...relative, sloP95Ms: 120 }] }),
        "test",
      ),
    ).toThrow(/exactly one of sloP95Ms/);
    expect(() =>
      validateSloDeclarations(
        catalogFixture({ scenarios: [{ ...relative, sloP95AboveFloorMs: undefined }] }),
        "test",
      ),
    ).toThrow(/neither/);
  });

  it("refuses a relative target with no floor to stand on", () => {
    expect(() => validateSloDeclarations(catalogFixture({ scenarios: [relative] }), "test")).toThrow(
      /names no floorScenario/,
    );
    expect(() =>
      validateSloDeclarations(
        catalogFixture({ floorScenario: "missing", scenarios: [relative] }),
        "test",
      ),
    ).toThrow(/no such scenario/);
  });

  it("refuses an informational scenario that is authenticated", () => {
    // An authenticated scenario measures API work by definition, so it cannot
    // also be exempted from the run's verdict.
    expect(() =>
      validateSloDeclarations(
        catalogFixture({
          scenarios: [{ ...catalogFixture().scenarios[0]!, informational: true, authenticated: true }],
        }),
        "test",
      ),
    ).toThrow(/authenticated and cannot be informational/);
  });

  it("refuses a floor that is authenticated or itself relative", () => {
    expect(() =>
      validateSloDeclarations(
        catalogFixture({
          floorScenario: "network-floor",
          scenarios: [{ ...floor, authenticated: true }, relative],
        }),
        "test",
      ),
    ).toThrow(/authenticated/);
    expect(() =>
      validateSloDeclarations(
        catalogFixture({
          floorScenario: "network-floor",
          scenarios: [{ ...floor, sloP95Ms: undefined, sloP95AboveFloorMs: 10 }, relative],
        }),
        "test",
      ),
    ).toThrow(/absolute sloP95Ms/);
  });
});

describe("offered load accounting", () => {
  it("normalizes any time unit to requests per minute", () => {
    const perSecond = catalogFixture().scenarios[0]!;

    expect(requestsPerMinute(perSecond)).toBe(60);
    expect(requestsPerMinute({ ...perSecond, rate: 1, timeUnit: "6s" })).toBe(10);
    expect(requestsPerMinute({ ...perSecond, rate: 30, timeUnit: "1m" })).toBe(30);
  });

  it("takes the peak from the busiest scenario, since they run one at a time", () => {
    const scenario = catalogFixture().scenarios[0]!;
    const busy = peakRequestsPerMinute(
      catalogFixture({
        scenarios: [
          { ...scenario, name: "slow", rate: 1, timeUnit: "6s" },
          { ...scenario, name: "fast", rate: 1, timeUnit: "1s" },
        ],
      }),
    );

    // Not the sum: sequential scheduling means a rolling window sees at most the
    // faster of two adjacent scenarios.
    expect(busy).toBe(60);
  });

  it("ignores unauthenticated scenarios, which spend no key budget", () => {
    const scenario = catalogFixture().scenarios[0]!;
    const peak = peakRequestsPerMinute(
      catalogFixture({
        scenarios: [
          { ...scenario, name: "public", authenticated: false, rate: 50 },
          { ...scenario, name: "keyed", authenticated: true, rate: 1 },
        ],
      }),
    );

    expect(peak).toBe(60);
  });
});
