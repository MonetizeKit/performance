/**
 * The per-run page is the citable artifact: someone quotes a number from it in
 * a blog post and a reader follows the link years later. So the properties that
 * matter are that the URL is stable and unique, that the page states the
 * conditions the number holds under, and that it renders at all for a run that
 * was never analyzed.
 */

import { describe, expect, it } from "vitest";

import { renderRunPage, runPagePath } from "../src/lib/run-page";
import { newRunId } from "../src/lib/run-document";

import { metrics, runDocument } from "./support/fixtures";

describe("runPagePath", () => {
  it("addresses a run by its id alone, which is unique across time", () => {
    expect(runPagePath("20260901T183841Z-7xzzm3")).toBe("run/20260901T183841Z-7xzzm3.html");
  });

  it("never produces the same path for two runs", () => {
    const ids = new Set(
      Array.from({ length: 500 }, () => runPagePath(newRunId(new Date("2026-09-01T02:00:00Z")))),
    );

    // Same timestamp for all 500, so this is entirely the suffix's doing.
    expect(ids.size).toBe(500);
  });
});

describe("renderRunPage", () => {
  const document = runDocument({
    baseline: {
      comparableRuns: 9,
      baselineRuns: 9,
      forming: false,
      regressionRatio: 1.2,
      scenarios: [
        {
          scenario: "entitlement-check",
          p95: 100,
          baselineP95: 96,
          ratio: 1.0417,
          sloP95Ms: 120,
          sloP95AboveFloorMs: null,
          floorP50Ms: null,
          sloPass: true,
          verdict: "pass",
        },
      ],
    },
  });

  it("states the conditions the number holds under", () => {
    const html = renderRunPage({
      document,
      canonicalUrl: "https://perf.example.com/run/20260830T020000Z-aaaaaa.html",
    });

    expect(html).toContain("1111111"); // build
    expect(html).toContain("v2"); // dataset
    expect(html).toContain("w1"); // workload
    expect(html).toContain("100 requests/minute"); // the limit in force
    expect(html).toContain("https://delivery.example.com"); // target
  });

  it("carries a canonical URL so the citation resolves to one place", () => {
    const html = renderRunPage({
      document,
      canonicalUrl: "https://perf.example.com/run/20260830T020000Z-aaaaaa.html",
    });

    expect(html).toContain(
      '<link rel="canonical" href="https://perf.example.com/run/20260830T020000Z-aaaaaa.html" />',
    );
    expect(html).toContain("This URL is permanent");
  });

  it("omits the canonical link rather than inventing one", () => {
    const html = renderRunPage({ document, canonicalUrl: null });

    expect(html).not.toContain("rel=\"canonical\"");
  });

  it("renders a run that was never analyzed, from its raw metrics", () => {
    // Otherwise a run that failed before `perf:analyze` would have a permalink
    // leading to an empty page.
    const html = renderRunPage({
      document: runDocument({
        baseline: null,
        scenarios: { "usage-ingest": metrics({ p95: 75 }) },
      }),
      canonicalUrl: null,
    });

    expect(html).toContain("usage-ingest");
    expect(html).toContain("75ms");
  });

  it("says what shipped, so a slower run is attributable from the page itself", () => {
    const html = renderRunPage({
      document: runDocument({
        changeSet: {
          detail: "commits",
          previousAppSha: "0000000000000000000000000000000000000000",
          commits: [{ sha: "abcdef1234", subject: "add an index", author: "Ada" }],
          migrations: ["20260901_add_index"],
          dependencies: [{ name: "prisma", from: "6.1.0", to: "6.2.0" }],
          compareUrl: "https://github.com/acme/repo/compare/0000000...1111111",
          truncated: false,
          unavailableReason: null,
        },
      }),
      canonicalUrl: null,
    });

    expect(html).toContain("add an index");
    expect(html).toContain("20260901_add_index");
    expect(html).toContain("prisma 6.1.0→6.2.0");
  });

  it("is self-contained: no scripts and no external fetches", () => {
    const html = renderRunPage({ document, canonicalUrl: null });

    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<(link|img|iframe)[^>]+src=/i);
  });

  it("escapes values that came from the store", () => {
    const html = renderRunPage({
      document: runDocument({ environment: '"><script>alert(1)</script>' }),
      canonicalUrl: null,
    });

    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;");
  });
});
