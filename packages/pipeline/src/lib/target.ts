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

/**
 * What the API said about this key's per-minute burst limit.
 *
 * - `limited`: `X-RateLimit-Limit` was present; the workload must fit under it.
 * - `unlimited`: the limited probe answered 2xx with no `X-RateLimit-*` headers.
 *   The API omits them precisely when the workspace's plan sets no burst limit
 *   (`api_rate_limit_per_minute` absent or 0), so this is a statement, not a gap.
 * - `unknown`: the probe did not answer 2xx, so nothing can be said either way.
 */
export type RateLimitState = "limited" | "unlimited" | "unknown";

export interface Health {
  workspaceName: string | null;
  rateLimitState: RateLimitState;
  /**
   * Requests per minute the API says this key may make, from
   * `X-RateLimit-Limit`. Null unless `rateLimitState` is `limited`.
   */
  rateLimitPerMinute: number | null;
  /**
   * Requests left in the key's current window after the probe, from
   * `X-RateLimit-Remaining`. Null unless `rateLimitState` is `limited`.
   */
  rateLimitRemaining: number | null;
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
  const limitHeader = probe.headers.get("x-ratelimit-limit");
  const remainingHeader = probe.headers.get("x-ratelimit-remaining");
  const limit = Number(limitHeader);
  const remaining = Number(remainingHeader);
  const limited = limitHeader !== null && Number.isFinite(limit) && limit > 0;

  return {
    workspaceName: typeof body.name === "string" ? body.name : null,
    rateLimitState: limited ? "limited" : probe.ok ? "unlimited" : "unknown",
    rateLimitPerMinute: limited ? limit : null,
    rateLimitRemaining:
      limited && remainingHeader !== null && Number.isFinite(remaining) && remaining >= 0
        ? remaining
        : null,
  };
}

/**
 * Requests spent from the key's window by anything other than this preflight,
 * before this run offered any load. The preflight's own probe is the one call
 * the limiter has seen from us by the time the header is read.
 */
export const PREFLIGHT_OWN_REQUESTS = 1;

/**
 * Requests another client may have spent in the window without being counted
 * as a competitor. Covers a stray manual call or a dashboard refresh; anything
 * more is a process on the same key.
 */
export const RATE_BUDGET_CONTENTION_TOLERANCE = 3;

/** Seconds between the two samples of the key's remaining budget. */
export const RATE_BUDGET_SAMPLE_GAP_S = 15;

export interface RateBudgetSample {
  limit: number;
  remaining: number;
}

/** A second read of the key's window, for the drawdown check. */
export async function sampleRateBudget(
  target: PerfTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<RateBudgetSample | null> {
  const headers = { ...baseHeaders(target), "X-API-Key": target.apiKey, accept: "application/json" };
  const probe = await fetchImpl(`${target.baseUrl}${LIMIT_PROBE_PATH}`, { headers });
  const limit = Number(probe.headers.get("x-ratelimit-limit"));
  const remaining = Number(probe.headers.get("x-ratelimit-remaining"));
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) return null;
  return { limit, remaining };
}

/**
 * Refuse to start while something else is spending the key's rate budget.
 *
 * The workload is sized to the key's whole per-minute allowance, so any other
 * client on the same key — the demo tenant's refresh job, a seeder catching up,
 * someone poking the API from a laptop — turns some of the run's requests into
 * 429s. The collector would record that as an error rate, the analyzer as a
 * breach, and the report would blame the platform for contention the harness
 * caused. Better to not start, and to say what was found.
 *
 * Two checks, because a single snapshot cannot tell them apart:
 *
 * 1. Budget already spent: on the first probe, more of the window has gone than
 *    the preflight itself used plus a small tolerance. Someone was here first.
 * 2. Budget being drawn down: the window is sampled again after a gap, and it
 *    has lost more than the sample itself cost. Someone is here now. The window
 *    is sliding, so old requests aging out can only make `remaining` rise;
 *    a fall beyond our own request is unambiguous.
 */
export function assertRateBudgetIdle(
  first: RateBudgetSample,
  second: RateBudgetSample | null,
  options: { tolerance?: number; gapSeconds?: number } = {},
): void {
  const tolerance = options.tolerance ?? RATE_BUDGET_CONTENTION_TOLERANCE;
  const gap = options.gapSeconds ?? RATE_BUDGET_SAMPLE_GAP_S;
  const foreign = first.limit - first.remaining - PREFLIGHT_OWN_REQUESTS;

  if (foreign > tolerance) {
    throw new Error(
      `${foreign} of this key's ${first.limit} requests/minute were already spent when the `
        + "preflight started; another client is using the performance key.\n"
        + contentionAdvice(),
    );
  }

  if (second) {
    const drawn = first.remaining - second.remaining - PREFLIGHT_OWN_REQUESTS;
    if (drawn > 0) {
      throw new Error(
        `the key's remaining budget fell from ${first.remaining} to ${second.remaining} in `
          + `${gap}s while this preflight made one request; another client is drawing it down.\n`
          + contentionAdvice(),
      );
    }
  }
}

function contentionAdvice(): string {
  return (
    "  The workload is sized to the whole allowance, so sharing it would turn part of the run\n"
    + "  into 429s that the report would call a platform problem. Likely causes: the demo\n"
    + "  refresh workflow (demo-refresh.yml in the application repo) still running, a seeder\n"
    + "  catch-up, or a manual session with the same key. Wait for it to finish, or run with\n"
    + "  --allow-shared-key to proceed anyway and have the run say so in its notes."
  );
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
  state: RateLimitState = observedLimit === null ? "unknown" : "limited",
): void {
  if (state === "unlimited") {
    // Nothing to fit under. The catalog's budget is now a harness choice about
    // how much load to offer, which is worth saying because a reader of the
    // declared budget would otherwise take it for a platform cap.
    process.stderr.write(
      "Note: this key has no per-minute burst limit (the plan sets no api_rate_limit_per_minute), "
        + `so the ${declaredBudget}/min budget in packages/api-workload/scenarios.json is the `
        + "harness's own choice of offered load, not a platform ceiling.\n",
    );
    return;
  }

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
