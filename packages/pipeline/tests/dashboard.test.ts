import { describe, expect, it } from "vitest";

import {
  buildEnvironmentViews,
  renderDashboard,
} from "../src/lib/dashboard";
import type { RunSummary } from "../src/lib/run-document";

import { historyEntry, metrics, runDocument } from "./support/fixtures";

/** `count` nightlies for one environment, oldest first, each with `p95`. */
function nightlies(
  count: number,
  p95: (index: number) => number,
  overrides: (index: number) => Partial<RunSummary> = () => ({}),
): RunSummary[] {
  return Array.from({ length: count }, (_unused, index) =>
    historyEntry(
      runDocument({
        scenarios: {
          "entitlement-check": metrics({ p95: p95(index) }),
          "catalog-reads": metrics({ p95: p95(index) * 2, sloP95Ms: 200 }),
        },
      }),
      {
        runId: `run-${index}`,
        timestamp: `2026-08-${String(index + 1).padStart(2, "0")}T02:00:00.000Z`,
        ...overrides(index),
      },
    ),
  );
}

describe("buildEnvironmentViews", () => {
  it("orders runs oldest first so the newest point is on the right", () => {
    const shuffled = [...nightlies(4, () => 100)].reverse();

    const [view] = buildEnvironmentViews({
      runs: shuffled,
      generatedAt: "2026-08-31T00:00:00.000Z",
    });

    expect(view!.runs.map((run) => run.timestamp)).toEqual([
      "2026-08-01T02:00:00.000Z",
      "2026-08-02T02:00:00.000Z",
      "2026-08-03T02:00:00.000Z",
      "2026-08-04T02:00:00.000Z",
    ]);
  });

  it("keeps the most recent runs when history exceeds the plotted window", () => {
    const [view] = buildEnvironmentViews({
      runs: nightlies(10, (index) => 100 + index),
      generatedAt: "2026-08-31T00:00:00.000Z",
      maxRuns: 3,
    });

    expect(view!.runs).toHaveLength(3);
    expect(view!.series[0]!.points).toEqual([107, 108, 109]);
    expect(view!.series[0]!.latest).toBe(109);
    expect(view!.series[0]!.previous).toBe(108);
  });

  it("separates environments so one never borrows the other's history", () => {
    const runs = [
      ...nightlies(2, () => 100),
      ...nightlies(3, () => 400, () => ({ environment: "production" })),
    ];

    const views = buildEnvironmentViews({
      runs,
      generatedAt: "2026-08-31T00:00:00.000Z",
    });

    expect(views.map((view) => view.environment)).toEqual(["delivery", "production"]);
    expect(views[0]!.runs).toHaveLength(2);
    expect(views[1]!.runs).toHaveLength(3);
  });

  it("marks where the workload changed, since runs either side are not comparable", () => {
    const runs = nightlies(4, () => 100, (index) => ({
      workloadVersion: index < 2 ? "w1" : "w2",
    }));

    const [view] = buildEnvironmentViews({
      runs,
      generatedAt: "2026-08-31T00:00:00.000Z",
    });

    expect(view!.workloadBreaks).toEqual([2]);
    expect(view!.workloadVersion).toBe("w2");
  });

  it("leaves a hole where a scenario produced no data rather than bridging it", () => {
    const runs = nightlies(3, () => 100);
    delete runs[1]!.scenarios["catalog-reads"];

    const [view] = buildEnvironmentViews({
      runs,
      generatedAt: "2026-08-31T00:00:00.000Z",
    });

    const series = view!.series.find((entry) => entry.scenario === "catalog-reads");
    expect(series!.points).toEqual([200, null, 200]);
    // The gap must not be counted as the previous observation.
    expect(series!.previous).toBe(200);
  });

  it("counts SLO breaches across the plotted window", () => {
    const runs = nightlies(3, () => 100);
    runs[0]!.scenarios["entitlement-check"]!.sloPass = false;
    runs[2]!.scenarios["entitlement-check"]!.sloPass = false;

    const [view] = buildEnvironmentViews({
      runs,
      generatedAt: "2026-08-31T00:00:00.000Z",
    });

    expect(view!.series.find((entry) => entry.scenario === "entitlement-check")!.breaches).toBe(2);
  });
});

describe("renderDashboard", () => {
  it("renders a self-contained page with no scripts or external requests", () => {
    const html = renderDashboard({
      runs: nightlies(5, (index) => 100 + index * 5),
      generatedAt: "2026-08-31T06:30:00.000Z",
    });

    expect(html).not.toMatch(/<script/i);
    // The only outbound link is the methodology, which is documentation, not a
    // request the page makes.
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org|github\.com\/MonetizeKit\/performance\/blob\/main\/docs\/methodology\.md)/);
    expect(html).toContain("docs/methodology.md");
    expect(html).not.toContain("noindex");
    expect(html).toContain("<svg");
    expect(html).toContain("delivery");
  });

  it("says so plainly when there is no history yet", () => {
    const html = renderDashboard({ runs: [], generatedAt: "2026-08-31T06:30:00.000Z" });

    expect(html).toContain("No runs recorded yet");
    expect(html).not.toContain("<svg");
  });

  it("links a run to its record here and to its build in the application repository", () => {
    const html = renderDashboard({
      runs: nightlies(1, () => 100),
      generatedAt: "2026-08-31T06:30:00.000Z",
      repositoryUrl: "https://github.com/acme/performance",
      appRepositoryUrl: "https://github.com/acme/monetizekit",
      branch: "perf-data",
    });

    // The record is in this repository's data branch...
    expect(html).toContain(
      "https://github.com/acme/performance/blob/perf-data/runs/delivery/",
    );
    // ...but the commit is the application's, and a link into the wrong
    // repository would 404 for every build.
    expect(html).toContain(
      "https://github.com/acme/monetizekit/commit/1111111111111111111111111111111111111111",
    );
    expect(html).not.toContain("https://github.com/acme/performance/commit/");
  });

  it("shows the build as plain text when the application repository is not stated", () => {
    const html = renderDashboard({
      runs: nightlies(1, () => 100),
      generatedAt: "2026-08-31T06:30:00.000Z",
      repositoryUrl: "https://github.com/acme/performance",
    });

    expect(html).not.toContain("/commit/");
    expect(html).toContain("<code>1111111</code>");
  });

  it("links every run to its permalink page", () => {
    const html = renderDashboard({
      runs: nightlies(2, () => 100),
      generatedAt: "2026-08-31T06:30:00.000Z",
    });

    expect(html).toContain('href="run/run-0.html"');
    expect(html).toContain('href="run/run-1.html"');
  });

  it("puts the environments side by side once there is more than one", () => {
    const runs = [
      ...nightlies(2, () => 100),
      ...nightlies(2, () => 400, () => ({ environment: "production" })),
    ];

    const html = renderDashboard({ runs, generatedAt: "2026-08-31T06:30:00.000Z" });

    expect(html).toContain("Latest run, side by side");
    // The comparison is informational: environments are never pooled into one
    // baseline, and the page has to say so.
    expect(html).toContain("only an environment's own history judges it");
  });

  it("omits the comparison when there is only one environment to compare", () => {
    const html = renderDashboard({
      runs: nightlies(3, () => 100),
      generatedAt: "2026-08-31T06:30:00.000Z",
    });

    expect(html).not.toContain("Latest run, side by side");
  });

  it("names the scenarios that missed their SLO on the latest run", () => {
    const runs = nightlies(2, () => 100);
    runs[1]!.scenarios["catalog-reads"]!.sloPass = false;

    const html = renderDashboard({ runs, generatedAt: "2026-08-31T06:30:00.000Z" });

    expect(html).toContain("1 scenario(s) missed their SLO on the latest run");
    expect(html).toContain("catalog-reads");
  });

  it("escapes values that came from the store", () => {
    const runs = nightlies(1, () => 100, () => ({
      environment: '<img src=x onerror="alert(1)">',
    }));

    const html = renderDashboard({ runs, generatedAt: "2026-08-31T06:30:00.000Z" });

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});
