/**
 * Handoff between the pipeline's steps.
 *
 * `perf:run` knows things `perf:collect` cannot rediscover — which build was
 * actually serving when the load was offered, which k6 produced the numbers,
 * whether k6 itself failed a threshold. Those facts are written to a file
 * alongside the k6 summary rather than passed through stdout, so a CI step
 * boundary (or a re-run of just the collector) cannot lose them or, worse,
 * silently substitute today's values for last night's measurements.
 */

import type { RateLimitState } from "./target";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { RunTrigger } from "./run-document";

export interface RunContext {
  runId: string;
  startedAt: string;
  finishedAt: string;
  trigger: RunTrigger;
  environment: string;
  baseUrl: string;
  appSha: string | null;
  deploymentId: string | null;
  datasetVersion: string | null;
  workloadVersion: string;
  /**
   * Catalog the load was offered from.
   *
   * Carried so the collector reads the SLOs that were actually enforced rather
   * than whichever catalog happens to be the default when it runs. Optional
   * only because contexts written before this field existed are still readable.
   */
  catalogPath?: string;
  rateLimitPerMinute: number | null;
  /**
   * Whether `rateLimitPerMinute` is null because the key has no burst limit
   * (`unlimited`) or because the preflight could not tell (`unknown`).
   * Optional only because contexts written before this field existed are
   * still readable.
   */
  rateLimitState?: RateLimitState;
  k6Version: string | null;
  k6ExitCode: number | null;
  summaryPath: string;
  /**
   * Anything the operator wants told about this run before it is collected —
   * a shared-key warning, or a free-text `--note` from a manual dispatch.
   * Optional only because contexts written before this field existed are
   * still readable.
   */
  notes?: string[];
}

export function writeRunContext(path: string, context: RunContext): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(context, null, 2)}\n`, "utf8");
}

export function readRunContext(path: string): RunContext {
  const context = JSON.parse(readFileSync(path, "utf8")) as Partial<RunContext>;
  if (!context.runId || !context.environment || !context.workloadVersion) {
    throw new Error(`${path} is not a run context produced by \`pnpm perf:run\``);
  }
  return context as RunContext;
}

/**
 * How the run was started.
 *
 * Only scheduled runs form baselines, so this has to reflect the real trigger:
 * a dispatched re-run aimed at a hand-picked build must not become part of the
 * reference the nightlies are judged against.
 */
export function resolveTrigger(
  env: Record<string, string | undefined> = process.env,
): RunTrigger {
  if (env.PERF_TRIGGER === "schedule" || env.PERF_TRIGGER === "dispatch") {
    return env.PERF_TRIGGER;
  }
  if (env.GITHUB_EVENT_NAME === "schedule") return "schedule";
  if (env.GITHUB_ACTIONS === "true") return "dispatch";
  return "local";
}
