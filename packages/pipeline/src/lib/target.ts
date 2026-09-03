/**
 * What was measured: the deployment under test and the build it is running.
 *
 * The build commit is the hinge of the whole pipeline — without it a latency
 * step cannot be attributed to anything — so it is read from the deployment
 * itself rather than from the CI checkout. The two are not the same: a nightly
 * run checks out `main` while the deployed app may be several commits behind it,
 * and attributing a regression to code that was not running would be worse than
 * not attributing it at all.
 */

export type PerfEnv = Record<string, string | undefined>;

export interface PerfTarget {
  environment: string;
  baseUrl: string;
  /** Which variable supplied the origin, so a run can say what it measured. */
  baseUrlSource: string;
  apiKey: string;
  /**
   * Version of the seeded dataset the tenant holds, when the seeder publishes
   * it. Runs are only comparable within one dataset version, so this is a
   * comparability key rather than a label; null means "not stated", and the
   * analyzer treats unstated as its own population.
   */
  datasetVersion: string | null;
  /**
   * Vercel Deployment Protection bypass, for a target behind it. Sent as
   * `x-vercel-protection-bypass` on every request, by the preflight and by k6
   * alike; without it a protected stage answers every call with a 302 to SSO
   * and the run measures a redirect.
   */
  protectionBypassSecret: string | null;
}

/** Headers every request to the target carries, before authentication. */
export function baseHeaders(target: Pick<PerfTarget, "protectionBypassSecret">): Record<string, string> {
  return target.protectionBypassSecret
    ? { "x-vercel-protection-bypass": target.protectionBypassSecret }
    : {};
}

/**
 * Environment label recorded on the run.
 *
 * Runs are only comparable within one label, so this must name the deployment,
 * not the machine k6 happened to run on.
 */
export function resolveEnvironmentName(env: PerfEnv = process.env): string {
  return (env.PERF_ENVIRONMENT || env.PHASE_ENVIRONMENT || "delivery")
    .trim()
    .toLowerCase();
}

/**
 * Where the target origin comes from, in order of precedence.
 *
 * `PERF_BASE_URL` overrides, then the showcase tenant's own override, then the
 * origin the stage already publishes for itself. A stage that is configured at
 * all knows its own URL, so requiring a perf-specific copy of it would only
 * create a second thing to keep in step. Mirrors the seeder and the E2E runner.
 */
const BASE_URL_SOURCES = [
  "PERF_BASE_URL",
  "DEMO_TARGET_BASE_URL",
  "APP_BASE_URL",
  "NEXT_PUBLIC_APP_URL",
] as const;

/** The key, likewise: perf-specific first, then the showcase tenant's. */
const API_KEY_SOURCES = ["PERF_API_KEY", "DEMO_WORKSPACE_API_KEY"] as const;

function firstOf(
  env: PerfEnv,
  names: readonly string[],
  hint: string,
): { value: string; source: string } {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return { value, source: name };
  }
  throw new Error(
    `none of ${names.join(", ")} is set. ${hint}\n`
      + "Set it in Phase.dev for the target stage, or in .env for local runs.",
  );
}

export function resolveTarget(env: PerfEnv = process.env): PerfTarget {
  const origin = firstOf(
    env,
    BASE_URL_SOURCES,
    "One of them must give the origin of the deployment to load-test.",
  );
  const key = firstOf(
    env,
    API_KEY_SOURCES,
    "One of them must give the target workspace's secret key (mk_...).",
  );

  return {
    environment: resolveEnvironmentName(env),
    baseUrl: origin.value.replace(/\/+$/, ""),
    baseUrlSource: origin.source,
    apiKey: key.value,
    datasetVersion: env.PERF_DATASET_VERSION?.trim() || env.DEMO_DATASET_VERSION?.trim() || null,
    protectionBypassSecret: env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() || null,
  };
}

export interface BuildInfo {
  appSha: string | null;
  deploymentId: string | null;
}

/**
 * The commit and deployment the target is serving.
 *
 * Never throws: a missing build endpoint costs attribution, not the run, and a
 * run with numbers but no `appSha` is far more useful than no run at all.
 */
export async function readBuildInfo(
  target: Pick<PerfTarget, "baseUrl" | "protectionBypassSecret">,
  fetchImpl: typeof fetch = fetch,
): Promise<BuildInfo> {
  try {
    const response = await fetchImpl(`${target.baseUrl}/api/build-info`, {
      headers: { ...baseHeaders(target), accept: "application/json" },
    });
    if (!response.ok) return { appSha: null, deploymentId: null };

    const body = (await response.json()) as { commitSha?: unknown };
    const sha = typeof body.commitSha === "string" ? body.commitSha.trim() : "";

    return {
      // "local" is the endpoint's own placeholder for an unbuilt app; recording
      // it as a commit would make every such run look like the same build.
      appSha: sha && sha !== "local" ? sha : null,
      deploymentId: response.headers.get("x-vercel-id"),
    };
  } catch {
    return { appSha: null, deploymentId: null };
  }
}

export interface Health {
  workspaceName: string | null;
  /**
   * Requests per minute the API says this key may make, from
   * `X-RateLimit-Limit`. Null when the target does not report it.
   */
  rateLimitPerMinute: number | null;
}

/**
 * Identifies the workspace but is not itself rate-limited, so it says who we
 * are pointed at and nothing about what we may offer.
 */
const IDENTITY_PATH = "/api/v1/workspace/current";

/**
 * A rate-limited endpoint, read purely for its `X-RateLimit-Limit` header.
 *
 * It has to be one that passes through the same limiter the workload will,
 * because not every route does: `/api/v1/workspace/current` answers 200 with no
 * rate-limit headers at all, and reading the limit from there quietly reported
 * "unknown" and let the budget guard fall back to whatever the catalog claimed.
 * A guard that cannot see the real limit is not a guard.
 */
const LIMIT_PROBE_PATH = "/api/v1/customers?limit=1";

/**
 * Fail before spending a quarter of an hour of load on a deployment that is not
 * serving — and read back the key's rate limit while we are here, because the
 * limit is what bounds the workload. The nightly workflow gates on this.
 */
export async function healthCheck(
  target: PerfTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<Health> {
  const headers = { ...baseHeaders(target), "X-API-Key": target.apiKey, accept: "application/json" };
  const response = await fetchImpl(`${target.baseUrl}${IDENTITY_PATH}`, {
    headers,
    // A protected stage answers with a 302 to SSO; following it would report
    // the SSO page's status rather than the deployment's.
    redirect: "manual",
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `${target.baseUrl} redirected the API call (HTTP ${response.status}), which is what a `
        + "stage behind Vercel Deployment Protection does.\n"
        + "  Set VERCEL_AUTOMATION_BYPASS_SECRET to that project's protection bypass so the\n"
        + "  run reaches the application rather than the sign-in page.",
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `${target.baseUrl} rejected the performance key (HTTP ${response.status}).\n`
        + "  The key is issued by the tenant's owner (MonetizeKit rotates it with\n"
        + "  `pnpm demo:ensure` in the application repo and syncs it here via Phase.dev).",
    );
  }
  if (!response.ok) {
    throw new Error(
      `${target.baseUrl} is not serving the API (HTTP ${response.status}); not starting a run.`,
    );
  }

  const body = (await response.json().catch(() => ({}))) as { name?: unknown };

  // Two requests before a fifteen-minute run is a rounding error, and knowing
  // the real ceiling is what keeps the run from being fifteen minutes of 429s.
  const probe = await fetchImpl(`${target.baseUrl}${LIMIT_PROBE_PATH}`, { headers });
  const limit = Number(probe.headers.get("x-ratelimit-limit"));

  return {
    workspaceName: typeof body.name === "string" ? body.name : null,
    rateLimitPerMinute: Number.isFinite(limit) && limit > 0 ? limit : null,
  };
}

/**
 * Refuse a workload the key is not allowed to offer.
 *
 * Without this the run still completes — as fifteen minutes of 429s, which the
 * collector would faithfully record as a catastrophic error rate and the
 * analyzer would faithfully call a regression. Better to not start.
 */
export function assertWorkloadFitsBudget(
  peakRequestsPerMinute: number,
  declaredBudget: number,
  observedLimit: number | null,
): void {
  const limit = observedLimit ?? declaredBudget;

  if (peakRequestsPerMinute > limit) {
    throw new Error(
      `the workload offers up to ${Math.round(peakRequestsPerMinute)} authenticated `
        + `requests/minute but this key is limited to ${limit}.\n`
        + "  Lower the scenario rates in packages/api-workload/scenarios.json (and bump its\n"
        + "  workloadVersion), or raise the workspace's per-minute limit — the API\n"
        + "  reads it from the `api_rate_limit_per_minute` platform entitlement.",
    );
  }

  if (observedLimit === null) {
    // The guard is now only as good as the catalog's claim, which is exactly
    // the situation it exists to avoid relying on.
    process.stderr.write(
      `Note: the target did not report a rate limit, so the workload was checked `
        + `against the ${declaredBudget}/min budget declared in packages/api-workload/scenarios.json `
        + "rather than against the limit actually in force.\n",
    );
    return;
  }

  if (observedLimit !== declaredBudget) {
    // Not fatal, but the recorded numbers mean something different than the
    // catalog's comment claims, and the next reader deserves to know.
    process.stderr.write(
      `Note: the key's limit is ${observedLimit}/min, not the ${declaredBudget}/min `
        + "packages/api-workload/scenarios.json declares. The workload still fits; update the "
        + "budget and bump workloadVersion when you retune it.\n",
    );
  }
}
