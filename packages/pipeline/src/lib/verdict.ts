/**
 * The words a run's outcome is reported in, shared by the email, the Slack
 * message, the run page and the CLI so they never disagree.
 *
 * Two outcomes look alike and are not. A *regression* is slower than the run's
 * own baseline: something changed since last night, and a person should look at
 * the change set before the next deploy. An *SLO breach* is a target missed
 * with no such movement: the system is where it has been, and that place is
 * outside the promise. The first nightly reported eight breaches as a
 * "REGRESSION" on a run with nothing to regress from, which is the confusion
 * this module exists to remove.
 */

import { offenders } from "./baseline";
import { ms } from "./format";
import type { RunDocument, RunStatus, ScenarioComparison } from "./run-document";

export interface StatusWords {
  /** Title case, for banners and Slack: "SLO breach". */
  label: string;
  /** Upper case, for email subjects: "SLO BREACH". */
  subject: string;
}

export const STATUS_WORDS: Record<RunStatus, StatusWords> = {
  passed: { label: "Pass", subject: "PASS" },
  "slo-breach": { label: "SLO breach", subject: "SLO BREACH" },
  regressed: { label: "Regression", subject: "REGRESSION" },
  failed: { label: "Run failed", subject: "RUN FAILED" },
};

/** What the exit code is saying, when a verdict fails the job. */
export function exitMessageFor(status: RunStatus): string {
  switch (status) {
    case "failed":
      return "the performance run did not complete; see the report above.";
    case "regressed":
      return "the performance run regressed against its baseline; see the report above.";
    case "slo-breach":
      return (
        "the performance run met its baseline but missed one or more SLOs; see the report above. "
        + "This is a target miss, not a change since the last run."
      );
    case "passed":
      return "the performance run passed.";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/** "245ms (floor 95ms + 150ms)", "400ms", or "400ms, informational". */
export function describeSlo(
  comparison: Pick<ScenarioComparison, "sloP95Ms" | "sloP95AboveFloorMs" | "floorP50Ms"> &
    Partial<Pick<ScenarioComparison, "informational">>,
): string {
  const note = comparison.informational ? ", informational" : "";
  if (comparison.sloP95AboveFloorMs === null || comparison.floorP50Ms === null) {
    return `${comparison.sloP95Ms}ms${note}`;
  }
  return `${comparison.sloP95Ms}ms (floor ${ms(comparison.floorP50Ms)} + ${comparison.sloP95AboveFloorMs}ms)${note}`;
}

export interface HeadlineOptions {
  /** Wraps a scenario name; Slack passes `*bold*`. */
  emphasis?: (name: string) => string;
}

/**
 * One sentence saying what happened and why it matters. The same sentence in
 * every channel, so a reader moving from the Slack alert to the email to the
 * run page is told one story.
 */
export function headlineFor(document: RunDocument, options: HeadlineOptions = {}): string {
  const emphasis = options.emphasis ?? ((name: string) => name);
  const worstFirst = document.baseline ? offenders(document.baseline) : [];

  if (document.status === "failed") {
    return (
      "The run did not complete, so tonight's numbers are partial. "
      + "The notes below say which scenarios produced no data."
    );
  }

  if (worstFirst.length > 0) {
    const regressions = worstFirst.filter((scenario) => scenario.verdict === "regressed");
    const breaches = worstFirst.filter((scenario) => !scenario.sloPass);
    const worst = worstFirst[0]!;

    const counts: string[] = [];
    if (regressions.length > 0) {
      counts.push(
        `${regressions.length} scenario(s) regressed against the baseline`,
      );
    }
    if (breaches.length > 0) {
      counts.push(
        `${breaches.length} scenario(s) missed their SLO`
          + (regressions.length === 0
            ? " without moving against the baseline — a target miss, not a change since the last run"
            : ""),
      );
    }

    const against =
      worst.verdict === "regressed" && worst.baselineP95 !== null
        ? `a ${ms(worst.baselineP95)} baseline and a ${describeSlo(worst)} SLO`
        : `a ${describeSlo(worst)} SLO`
          + (worst.baselineP95 !== null ? ` and a ${ms(worst.baselineP95)} baseline` : "");

    return (
      `${counts.join("; ")}. Worst: ${emphasis(worst.scenario)} at p95 ${ms(worst.p95)} against ${against}.`
    );
  }

  if (document.baseline?.forming) {
    return (
      `Every scenario met its SLO. The baseline is still forming — `
      + `${document.baseline.baselineRuns} comparable run(s) so far — so nothing is `
      + "being compared against a median yet."
    );
  }
  return "Every scenario met its SLO and stayed within tolerance of its baseline.";
}
