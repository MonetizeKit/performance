/**
 * The preflight exists so a misconfigured night costs a second rather than a
 * quarter of an hour of load and a record that has to be explained away. These
 * tests cover the four ways it earns that: a rejected key, a target that is not
 * serving, a workload the key is not allowed to offer, and a key that something
 * else is already spending.
 */

import { describe, expect, it } from "vitest";

import {
  assertRateBudgetIdle,
  assertWorkloadFitsBudget,
  healthCheck,
  PREFLIGHT_OWN_REQUESTS,
  RATE_BUDGET_CONTENTION_TOLERANCE,
  readBuildInfo,
  resolveEnvironmentName,
  resolveTarget,
  sampleRateBudget,
} from "../src/lib/target";

const TARGET = {
  environment: "delivery",
  baseUrl: "https://delivery.example.com",
  baseUrlSource: "PERF_BASE_URL",
  apiKey: "mk_live_abc",
  datasetVersion: "v2",
  protectionBypassSecret: null,
};

function responder(
  init: { status?: number; body?: unknown; headers?: Record<string, string> } = {},
): typeof fetch {
  const { status = 200, body = {}, headers = {} } = init;
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    })) as unknown as typeof fetch;
}

describe("target resolution", () => {
  it("names every variable it looked at, and where to set them", () => {
    expect(() => resolveTarget({})).toThrow(/PERF_BASE_URL/);
    expect(() => resolveTarget({})).toThrow(/APP_BASE_URL/);
    expect(() => resolveTarget({})).toThrow(/Phase\.dev/);
    expect(() =>
      resolveTarget({ PERF_BASE_URL: "https://x.example.com" }),
    ).toThrow(/PERF_API_KEY/);
  });

  it("falls back to the origin the stage already publishes for itself", () => {
    // Requiring a perf-specific copy of a URL the stage already knows would
    // only create a second thing to keep in step.
    const target = resolveTarget({
      APP_BASE_URL: "https://delivery.example.com",
      DEMO_WORKSPACE_API_KEY: "mk_live_abc",
    });

    expect(target.baseUrl).toBe("https://delivery.example.com");
    expect(target.baseUrlSource).toBe("APP_BASE_URL");
  });

  it("prefers the most specific override available", () => {
    const target = resolveTarget({
      PERF_BASE_URL: "https://perf.example.com",
      DEMO_TARGET_BASE_URL: "https://showcase.example.com",
      APP_BASE_URL: "https://delivery.example.com",
      PERF_API_KEY: "mk_live_perf",
      DEMO_WORKSPACE_API_KEY: "mk_live_demo",
    });

    expect(target.baseUrl).toBe("https://perf.example.com");
    expect(target.baseUrlSource).toBe("PERF_BASE_URL");
    expect(target.apiKey).toBe("mk_live_perf");
  });

  it("records the dataset version only when the seeder has published one", () => {
    const base = { PERF_BASE_URL: "https://x.example.com", PERF_API_KEY: "mk_live_abc" };

    // Unstated is recorded as unstated. Inventing a default here would make
    // runs against differently seeded tenants look comparable.
    expect(resolveTarget(base).datasetVersion).toBeNull();
    expect(resolveTarget(base).protectionBypassSecret).toBeNull();
    expect(
      resolveTarget({ ...base, VERCEL_AUTOMATION_BYPASS_SECRET: " s3cret " }).protectionBypassSecret,
    ).toBe("s3cret");
    expect(resolveTarget({ ...base, PERF_DATASET_VERSION: " v3 " }).datasetVersion).toBe("v3");
    // The application repository publishes it under its own name; accept that
    // too so one Phase secret serves both sides.
    expect(resolveTarget({ ...base, DEMO_DATASET_VERSION: "v2" }).datasetVersion).toBe("v2");
    expect(
      resolveTarget({ ...base, PERF_DATASET_VERSION: "v3", DEMO_DATASET_VERSION: "v2" }).datasetVersion,
    ).toBe("v3");
  });

  it("uses the showcase deployment when it is separate from the stage's app", () => {
    const target = resolveTarget({
      DEMO_TARGET_BASE_URL: "https://showcase.example.com",
      APP_BASE_URL: "https://delivery.example.com",
      DEMO_WORKSPACE_API_KEY: "mk_live_abc",
    });

    expect(target.baseUrl).toBe("https://showcase.example.com");
    expect(target.baseUrlSource).toBe("DEMO_TARGET_BASE_URL");
  });

  it("strips a trailing slash so request paths do not double up", () => {
    const target = resolveTarget({
      PERF_BASE_URL: "https://x.example.com/",
      PERF_API_KEY: "mk_live_abc",
    });

    expect(target.baseUrl).toBe("https://x.example.com");
  });

  it("labels the deployment, not the machine k6 ran on", () => {
    expect(resolveEnvironmentName({ PERF_ENVIRONMENT: "Production" })).toBe("production");
    expect(resolveEnvironmentName({ PHASE_ENVIRONMENT: "Delivery" })).toBe("delivery");
    expect(resolveEnvironmentName({})).toBe("delivery");
  });
});

describe("build info", () => {
  it("reads the commit and deployment the target is serving", async () => {
    const build = await readBuildInfo(
      TARGET,
      responder({
        body: { commitSha: "abc123def456" },
        headers: { "x-vercel-id": "iad1::xyz" },
      }),
    );

    expect(build).toEqual({ appSha: "abc123def456", deploymentId: "iad1::xyz" });
  });

  it("treats the endpoint's own placeholder as no commit", async () => {
    // Recording "local" as a sha would make every dev-server run look like the
    // same build, and attribute a delta to an empty commit range.
    const build = await readBuildInfo(
      TARGET,
      responder({ body: { commitSha: "local" } }),
    );

    expect(build.appSha).toBeNull();
  });

  it("costs attribution rather than the run when the endpoint is unavailable", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(readBuildInfo(TARGET, failing)).resolves.toEqual({
      appSha: null,
      deploymentId: null,
    });
    await expect(
      readBuildInfo(TARGET, responder({ status: 404 })),
    ).resolves.toEqual({ appSha: null, deploymentId: null });
  });
});

describe("preflight", () => {
  it("reads back the workspace and the limit the key is granted", async () => {
    const health = await healthCheck(
      TARGET,
      responder({
        body: { id: "ws_1", name: "MonetizeKit Showcase" },
        headers: { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "99" },
      }),
    );

    expect(health).toEqual({
      workspaceName: "MonetizeKit Showcase",
      rateLimitState: "limited",
      rateLimitPerMinute: 100,
      rateLimitRemaining: 99,
    });
  });

  it("says who issues the key when it is rejected", async () => {
    await expect(healthCheck(TARGET, responder({ status: 401 }))).rejects.toThrow(
      /rejected the performance key \(HTTP 401\)[\s\S]*demo:ensure/,
    );
  });

  it("names the protection bypass when the stage redirects to SSO", async () => {
    // Vercel Deployment Protection answers with a 302 rather than a 401; a
    // preflight that followed it would report the sign-in page's 200.
    const redirecting = (async () =>
      new Response("", {
        status: 302,
        headers: { location: "https://vercel.com/sso-api?url=..." },
      })) as unknown as typeof fetch;

    await expect(healthCheck(TARGET, redirecting)).rejects.toThrow(
      /Deployment Protection[\s\S]*VERCEL_AUTOMATION_BYPASS_SECRET/,
    );
  });

  it("sends the protection bypass on every request when the target has one", async () => {
    const seen: Array<Record<string, string>> = [];
    const recording = (async (_url: string, init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string>) });
      return new Response(JSON.stringify({ name: "x", commitSha: "abc" }), {
        status: 200,
        headers: { "content-type": "application/json", "x-ratelimit-limit": "100" },
      });
    }) as unknown as typeof fetch;
    const protectedTarget = { ...TARGET, protectionBypassSecret: "bypass-secret" };

    await healthCheck(protectedTarget, recording);
    await readBuildInfo(protectedTarget, recording);

    expect(seen).toHaveLength(3);
    for (const headers of seen) {
      expect(headers["x-vercel-protection-bypass"]).toBe("bypass-secret");
    }
    // The unauthenticated build-info call carries the bypass but no key.
    expect(seen[2]!["X-API-Key"]).toBeUndefined();

    // And nothing is sent when there is nothing to send.
    seen.length = 0;
    await readBuildInfo(TARGET, recording);
    expect(seen[0]!["x-vercel-protection-bypass"]).toBeUndefined();
  });

  it("refuses to start against a target that is not serving", async () => {
    await expect(healthCheck(TARGET, responder({ status: 503 }))).rejects.toThrow(
      /not starting a run/,
    );
  });

  it("reports the key as unlimited when a 2xx probe carries no rate-limit headers", async () => {
    // The API omits X-RateLimit-* exactly when the workspace's plan sets no
    // burst limit (api_rate_limit_per_minute absent or 0), so their absence on
    // a successful probe is a statement about the key, not a reporting gap.
    const health = await healthCheck(TARGET, responder({ body: { name: "x" } }));

    expect(health.rateLimitState).toBe("unlimited");
    expect(health.rateLimitPerMinute).toBeNull();
    expect(health.rateLimitRemaining).toBeNull();
  });

  it("reports the limit as unknown when the probe itself did not succeed", async () => {
    let calls = 0;
    const identityThenFailure = (async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ name: "x" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response("upstream timeout", { status: 504 });
    }) as unknown as typeof fetch;

    const health = await healthCheck(TARGET, identityThenFailure);

    expect(health.rateLimitState).toBe("unknown");
    expect(health.rateLimitPerMinute).toBeNull();
  });

  it("reads the limit from a rate-limited endpoint, not from the identity call", async () => {
    // The regression this guards: `/api/v1/workspace/current` answers 200 with
    // no rate-limit headers, so reading the limit from it reported "unknown"
    // and let the budget check fall back to whatever the catalog claimed.
    const requested: string[] = [];
    const byPath = (async (url: string) => {
      requested.push(url);
      const identity = url.includes("/workspace/current");
      return new Response(JSON.stringify(identity ? { name: "Showcase" } : { data: [] }), {
        status: 200,
        headers: identity
          ? { "content-type": "application/json" }
          : { "content-type": "application/json", "x-ratelimit-limit": "100" },
      });
    }) as unknown as typeof fetch;

    const health = await healthCheck(TARGET, byPath);

    expect(health).toEqual({
      workspaceName: "Showcase",
      rateLimitState: "limited",
      rateLimitPerMinute: 100,
      rateLimitRemaining: null,
    });
    expect(requested).toEqual([
      "https://delivery.example.com/api/v1/workspace/current",
      "https://delivery.example.com/api/v1/customers?limit=1",
    ]);
  });
});

describe("workload budget guard", () => {
  it("refuses a workload the key is not allowed to offer", () => {
    expect(() => assertWorkloadFitsBudget(1200, 100, 100)).toThrow(
      /1200 authenticated requests\/minute but this key is limited to 100/,
    );
    expect(() => assertWorkloadFitsBudget(1200, 100, 100)).toThrow(
      /api_rate_limit_per_minute/,
    );
  });

  it("trusts the observed limit over the declared budget", () => {
    // The catalog claims 100; the key actually allows 500, so 300 is fine.
    expect(() => assertWorkloadFitsBudget(300, 100, 500)).not.toThrow();
    // And the reverse: the catalog is optimistic and the key is not.
    expect(() => assertWorkloadFitsBudget(90, 500, 60)).toThrow(/limited to 60/);
  });

  it("falls back to the declared budget when the limit is unknown", () => {
    expect(() => assertWorkloadFitsBudget(120, 100, null)).toThrow(/limited to 100/);
    expect(() => assertWorkloadFitsBudget(60, 100, null)).not.toThrow();
  });

  it("says so when the real limit is not the one the catalog documents", () => {
    expect(stderrFrom(() => assertWorkloadFitsBudget(60, 100, 500))).toMatch(
      /limit is 500\/min, not the 100\/min/,
    );
  });

  it("waives the budget check for an unlimited key and says the budget is the harness's own", () => {
    expect(() => assertWorkloadFitsBudget(1200, 100, null, "unlimited")).not.toThrow();
    expect(stderrFrom(() => assertWorkloadFitsBudget(1200, 100, null, "unlimited"))).toMatch(
      /no per-minute burst limit.*harness's own choice/s,
    );
  });

  it("says so when it had to trust the catalog because no limit was reported", () => {
    // Otherwise a target that stops reporting its limit silently downgrades the
    // guard to a self-check against a hard-coded number.
    expect(stderrFrom(() => assertWorkloadFitsBudget(60, 100, null))).toMatch(
      /did not report a rate limit/,
    );
  });
});

describe("shared-key guard", () => {
  // The limit is 100 and the preflight has made its one counted request, so an
  // idle key reads 99 remaining.
  const IDLE = { limit: 100, remaining: 100 - PREFLIGHT_OWN_REQUESTS };

  it("starts on an idle key", () => {
    expect(() => assertRateBudgetIdle(IDLE, null)).not.toThrow();
    // Second sample: our own probe cost one more, nothing else moved.
    expect(() =>
      assertRateBudgetIdle(IDLE, { limit: 100, remaining: IDLE.remaining - PREFLIGHT_OWN_REQUESTS }),
    ).not.toThrow();
  });

  it("forgives a stray manual call but not a process", () => {
    const stray = { limit: 100, remaining: IDLE.remaining - RATE_BUDGET_CONTENTION_TOLERANCE };
    expect(() => assertRateBudgetIdle(stray, null)).not.toThrow();

    const process_ = { limit: 100, remaining: IDLE.remaining - RATE_BUDGET_CONTENTION_TOLERANCE - 1 };
    expect(() => assertRateBudgetIdle(process_, null)).toThrow(
      /4 of this key's 100 requests\/minute were already spent/,
    );
  });

  it("refuses when the budget is falling faster than the preflight spends it", () => {
    // Between the two samples we made one request; the window lost eleven.
    expect(() =>
      assertRateBudgetIdle(IDLE, { limit: 100, remaining: IDLE.remaining - 11 }),
    ).toThrow(/fell from 99 to 88 in 15s[\s\S]*another client is drawing it down/);
  });

  it("does not mistake the sliding window aging out for contention", () => {
    // Old requests leaving the window can only raise `remaining`; that is not
    // evidence of anyone else.
    expect(() =>
      assertRateBudgetIdle({ limit: 100, remaining: 97 }, { limit: 100, remaining: 100 }),
    ).not.toThrow();
  });

  it("tells the operator what is probably holding the key and how to override", () => {
    expect(() => assertRateBudgetIdle({ limit: 100, remaining: 50 }, null)).toThrow(
      /demo-refresh\.yml[\s\S]*--allow-shared-key/,
    );
  });

  it("cannot judge when the second sample has no headers", () => {
    // A target that stops reporting mid-preflight yields no second sample; the
    // first-sample check still applies, the drawdown check is skipped.
    expect(() => assertRateBudgetIdle(IDLE, null)).not.toThrow();
  });

  it("samples the window from the rate-limited endpoint", async () => {
    const requested: string[] = [];
    const recording = (async (url: string) => {
      requested.push(url);
      return new Response("{}", {
        status: 200,
        headers: { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "42" },
      });
    }) as unknown as typeof fetch;

    await expect(sampleRateBudget(TARGET, recording)).resolves.toEqual({ limit: 100, remaining: 42 });
    expect(requested).toEqual(["https://delivery.example.com/api/v1/customers?limit=1"]);

    await expect(sampleRateBudget(TARGET, responder({}))).resolves.toBeNull();
  });
});

function stderrFrom(action: () => void): string {
  const written: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    action();
  } finally {
    process.stderr.write = original;
  }

  return written.join("");
}
