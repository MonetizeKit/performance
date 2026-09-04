/**
 * The report is how a regression actually reaches a person, so what is tested
 * here is whether it says the true thing first: the verdict in the subject, the
 * worst offender in the opening line, and the change set present rather than a
 * link away. HTML structure is not asserted beyond the facts it must contain.
 */

import { describe, expect, it } from "vitest";

import { analyzeBaseline, statusFrom } from "../src/lib/baseline";
import {
  computeTrends,
  renderHtml,
  renderText,
  subjectFor,
  type ReportInput,
} from "../src/lib/report";
import type { RunDocument } from "../src/lib/run-document";

import { historyEntry, metrics, runDocument } from "./support/fixtures";

/** `count` comparable nightlies at a fixed p95, most recent first. */
function history(count: number, p95: number) {
  return Array.from({ length: count }, (_unused, index) =>
    historyEntry(runDocument(), {
      runId: `night-${index}`,
      timestamp: `2026-08-${String(29 - index).padStart(2, "0")}T02:00:00.000Z`,
      p95,
    }),
  );
}

/** Analyze `document` against `count` runs at `baselineP95`, then render it. */
function report(document: RunDocument, count = 14, baselineP95 = 100): ReportInput {
  const past = history(count, baselineP95);
  const analyzed = { ...document, baseline: analyzeBaseline(document, past) };
  analyzed.status = statusFrom(analyzed.baseline, document.status === "failed");

  return {
    document: analyzed,
    history: past,
    dashboardUrl: "https://docs.example.com/perf",
    runUrl: "https://github.com/acme/mk/blob/perf-data/runs/delivery/x.json",
  };
}

describe("subject line", () => {
  it("carries the verdict, environment and day", () => {
    expect(subjectFor(runDocument())).toBe(
      "[MonetizeKit Perf] PASS — delivery 2026-08-30",
    );
    expect(subjectFor(runDocument({ status: "regressed" }))).toContain("REGRESSION");
    expect(subjectFor(runDocument({ status: "slo-breach" }))).toContain("SLO BREACH");
    expect(subjectFor(runDocument({ status: "slo-breach" }))).not.toContain("REGRESSION");
    expect(subjectFor(runDocument({ status: "failed" }))).toContain("RUN FAILED");
  });
});

describe("trends", () => {
  it("compares against the recent and the long window separately", () => {
    const input = report(runDocument({ scenarios: { "entitlement-check": metrics({ p95: 100 }) } }));
    // Last 7 runs sat at 300ms; the 30-run window is dominated by 100ms runs.
    input.history = [
      ...history(7, 300).map((run, index) => ({ ...run, runId: `recent-${index}` })),
      ...history(23, 100).map((run, index) => ({
        ...run,
        runId: `older-${index}`,
        timestamp: `2026-07-${String(23 - index).padStart(2, "0")}T02:00:00.000Z`,
      })),
    ];

    const [trend] = computeTrends(input);

    // The short window has already moved to the new regime while the long one
    // still remembers the old — which is exactly the pair a reader needs to tell
    // "slower than usual tonight" from "slower than it used to be".
    expect(trend!.shortMedian).toBe(300);
    expect(trend!.longMedian).toBe(100);
  });

  it("leaves both windows empty when the scenario is new", () => {
    const input = report(runDocument({ scenarios: { "brand-new": metrics() } }));

    expect(computeTrends(input)[0]).toMatchObject({
      shortMedian: null,
      longMedian: null,
    });
  });
});

describe("rendered report", () => {
  it("leads with the worst offender and names the number and the SLO", () => {
    const input = report(
      runDocument({
        scenarios: {
          "entitlement-check": metrics({ p95: 400 }),
          "catalog-reads": metrics({ p95: 100, sloP95Ms: 200 }),
        },
      }),
    );

    const html = renderHtml(input);
    const text = renderText(input);

    expect(html).toContain("1 scenario(s) regressed against the baseline");
    expect(html).toContain("Worst: entitlement-check at p95 400ms");
    expect(html).toContain("120ms SLO");
    expect(text).toContain("REGRESSION");
  });

  it("reports an SLO miss on a flat baseline as a breach, not a regression", () => {
    // Same p95 every night, all of them over the target: nothing regressed.
    const input = report(
      runDocument({
        scenarios: {
          "usage-ingest": metrics({ p95: 725, sloP95Ms: 245, sloP95AboveFloorMs: 150, floorP50Ms: 95, sloPass: false }),
        },
      }),
      14,
      720,
    );

    const html = renderHtml(input);
    const text = renderText(input);

    expect(input.document.status).toBe("slo-breach");
    expect(text).toContain("SLO BREACH");
    expect(text).not.toContain("REGRESSION");
    expect(html).toContain("SLO breach");
    expect(html).toContain("1 scenario(s) missed their SLO without moving against the baseline");
    // The target is shown as what it is: a floor measured tonight plus a budget.
    expect(html).toContain("245ms (floor 95ms + 150ms)");
  });

  it("still lists the healthy scenarios beside the offenders", () => {
    const html = renderHtml(
      report(
        runDocument({
          scenarios: {
            "entitlement-check": metrics({ p95: 400 }),
            "catalog-reads": metrics({ p95: 100, sloP95Ms: 200 }),
          },
        }),
      ),
    );

    // A table that only shows failures gives no sense of whether the rest
    // moved too.
    expect(html).toContain("catalog-reads");
  });

  it("says the baseline is forming instead of claiming everything is fine", () => {
    const input = report(runDocument(), 3);

    expect(renderHtml(input)).toContain("baseline is still forming");
    expect(renderHtml(input)).toContain("3 comparable run(s)");
  });

  it("says an incomplete run is incomplete rather than reporting a pass", () => {
    const input = report(runDocument({ status: "failed", notes: ["no data for catalog-reads"] }));

    expect(subjectFor(input.document)).toContain("RUN FAILED");
    expect(renderHtml(input)).toContain("The run did not complete");
    expect(renderHtml(input)).toContain("no data for catalog-reads");
  });

  it("puts the change set in the body, with the compare link", () => {
    const input = report(runDocument());
    input.document.changeSet = {
      detail: "commits",
      previousAppSha: "1111111",
      commits: [
        { sha: "2222222222", subject: "feat(usage): batch ingestion", author: "Ada" },
      ],
      migrations: ["20260830120000_add_index"],
      dependencies: [{ name: "next", from: "16.0.1", to: "16.1.0" }],
      compareUrl: "https://github.com/acme/mk/compare/1111111...2222222",
      truncated: false,
      unavailableReason: null,
    };

    const html = renderHtml(input);

    expect(html).toContain("feat(usage): batch ingestion");
    expect(html).toContain("20260830120000_add_index");
    expect(html).toContain("next 16.0.1→16.1.0");
    expect(html).toContain("https://github.com/acme/mk/compare/1111111...2222222");
  });

  it("distinguishes a redeploy of the same build from missing attribution", () => {
    const same = report(runDocument());
    same.document.changeSet = {
      detail: "same-build",
      previousAppSha: "1111111",
      commits: [],
      migrations: [],
      dependencies: [],
      compareUrl: null,
      truncated: false,
      unavailableReason: null,
    };

    const unknown = report(runDocument());
    unknown.document.changeSet = {
      detail: "unavailable",
      previousAppSha: null,
      commits: [],
      migrations: [],
      dependencies: [],
      compareUrl: null,
      truncated: false,
      unavailableReason: "no earlier run recorded a build commit",
    };

    expect(renderHtml(same)).toContain("the same build was measured as last time");
    expect(renderHtml(unknown)).toContain("no earlier run recorded a build commit");
  });

  it("points at the application repository when only the build range is known", () => {
    // The usual case for a harness that lives apart from the application: it
    // knows which builds it measured, and the commits between them are one
    // click away rather than copied here.
    const input = report(runDocument());
    input.document.changeSet = {
      detail: "compare-link",
      previousAppSha: "1111111111",
      commits: [],
      migrations: [],
      dependencies: [],
      compareUrl: "https://github.com/acme/mk/compare/1111111111...2222222222",
      truncated: false,
      unavailableReason: null,
    };

    const html = renderHtml(input);
    expect(html).toContain("The build moved from <code>1111111</code>");
    expect(html).toContain('href="https://github.com/acme/mk/compare/1111111111...2222222222"');
    expect(html).not.toContain("the same build was measured");
    expect(html).not.toContain("Not available");

    const text = renderText(input);
    expect(text).toContain("Build moved from 1111111");
    expect(text).toContain("full diff: https://github.com/acme/mk/compare/1111111111...2222222222");
  });

  it("escapes text that came from a commit message", () => {
    const input = report(runDocument());
    input.document.changeSet = {
      detail: "commits",
      previousAppSha: "1111111",
      commits: [
        {
          sha: "2222222222",
          subject: '<script>alert("x")</script>',
          author: "Ada & Grace",
        },
      ],
      migrations: [],
      dependencies: [],
      compareUrl: null,
      truncated: false,
      unavailableReason: null,
    };

    const html = renderHtml(input);

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Ada &amp; Grace");
  });

  it("links the dashboard and this run's record", () => {
    const html = renderHtml(report(runDocument()));

    expect(html).toContain("https://docs.example.com/perf");
    expect(html).toContain("blob/perf-data/runs/delivery/x.json");
  });

  it("renders a plain-text alternative carrying the same verdict", () => {
    const text = renderText(report(runDocument({ scenarios: { "entitlement-check": metrics({ p95: 400 }) } })));

    expect(text).toContain("[MonetizeKit Perf] REGRESSION");
    expect(text).toContain("entitlement-check");
    expect(text).toContain("regressed");
    expect(text).not.toContain("<");
  });
});
