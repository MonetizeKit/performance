/**
 * Nightly performance run against a seeded MonetizeKit tenant.
 *
 * Run through `pnpm perf:run`, which resolves secrets from Phase.dev and passes
 * them in as k6 env vars. This file is executed by k6's own JS runtime, not
 * Node, so it uses only k6 modules and plain ES imports.
 *
 * Design points that matter for comparability:
 *
 * - Every scenario is `constant-arrival-rate`: k6 offers a fixed request rate
 *   regardless of how fast the system answers, so a slow night shows up as
 *   latency rather than as reduced load.
 * - Scenarios run one at a time, scheduled back to back from `scenarios.json`.
 *   Run together they would contend for the same database, and each scenario's
 *   latency would then depend on the others' workloads.
 * - Latency is recorded into a per-scenario Trend rather than read back off
 *   tagged sub-metrics, so the summary always carries per-scenario percentiles
 *   whether or not a threshold happens to be declared for that scenario.
 * - Write scenarios only ever touch a probe customer created for this run and
 *   archived in teardown. A fresh customer per run means the ingest path always
 *   writes into an empty event history, so its latency is not quietly inflated
 *   by however many previous runs have accumulated.
 */

import http from "k6/http";
import { Trend, Rate } from "k6/metrics";
import { fail } from "k6";

// `PERF_SCENARIOS` selects an alternate catalog — see scenarios.smoke.json,
// which exercises this whole pipeline in a couple of minutes. Any such catalog
// declares its own workloadVersion, so its runs can never be compared against
// the nightly's.
const CONFIG = JSON.parse(open(__ENV.PERF_SCENARIOS || "./scenarios.json"));

const BASE_URL = (__ENV.PERF_BASE_URL || "").replace(/\/+$/, "");
const API_KEY = __ENV.PERF_API_KEY || "";
// A stage behind Vercel Deployment Protection answers every request with a 302
// to SSO unless this accompanies it. Empty when the target is not protected.
const PROTECTION_BYPASS = __ENV.PERF_PROTECTION_BYPASS || "";
const RUN_ID = __ENV.PERF_RUN_ID || `local-${Date.now()}`;
const SUMMARY_PATH = __ENV.PERF_SUMMARY_PATH || "perf-summary.json";

/** Items per bulk-ingest request; the API's documented ceiling. */
const BATCH_SIZE = 500;

function underscore(name) {
  return name.replace(/-/g, "_");
}

/** Per-scenario metrics, declared at init time as k6 requires. */
const latency = {};
const failures = {};
for (const scenario of CONFIG.scenarios) {
  latency[scenario.name] = new Trend(`latency_${underscore(scenario.name)}`, true);
  failures[scenario.name] = new Rate(`failed_${underscore(scenario.name)}`);
}

function seconds(duration) {
  const match = /^(\d+)(s|m)$/.exec(duration);
  if (!match) throw new Error(`unsupported duration "${duration}"`);
  return Number(match[1]) * (match[2] === "m" ? 60 : 1);
}

/**
 * k6 thresholds are fixed at init, so only an absolute `sloP95Ms` can be one.
 * A scenario whose target is a budget above the measured floor
 * (`sloP95AboveFloorMs`) is judged by the collector once the floor is known;
 * k6 still enforces its error budget.
 */
function buildThresholds() {
  const thresholds = {};
  for (const scenario of CONFIG.scenarios) {
    if (typeof scenario.sloP95Ms === "number") {
      thresholds[`latency_${underscore(scenario.name)}`] = [`p(95)<${scenario.sloP95Ms}`];
    }
    thresholds[`failed_${underscore(scenario.name)}`] = [`rate<=${scenario.sloErrorRate}`];
  }
  return thresholds;
}

/**
 * Schedule the scenarios back to back, with a settling gap between them so one
 * scenario's tail does not land inside the next one's window.
 */
function buildScenarios() {
  const scenarios = {};
  let offset = 0;
  for (const scenario of CONFIG.scenarios) {
    scenarios[scenario.name] = {
      executor: "constant-arrival-rate",
      exec: underscore(scenario.name),
      startTime: `${offset}s`,
      rate: scenario.rate,
      timeUnit: scenario.timeUnit,
      duration: scenario.duration,
      preAllocatedVUs: scenario.preAllocatedVUs,
      // Never let k6 add VUs: a growing VU pool changes the workload mid-run.
      maxVUs: scenario.preAllocatedVUs,
      tags: { scenario: scenario.name },
    };
    offset += seconds(scenario.duration) + (CONFIG.settleSeconds || 0);
  }
  return scenarios;
}

export const options = {
  // Discard response bodies by default: holding them costs memory and skews
  // nothing we measure. Setup/teardown opt back in where they parse responses.
  discardResponseBodies: true,
  // k6's default trend summary stops at p(95); the Run Document reports p99 too,
  // so the tail has to be asked for explicitly.
  summaryTrendStats: ["avg", "min", "med", "max", "p(50)", "p(90)", "p(95)", "p(99)"],
  thresholds: buildThresholds(),
  scenarios: buildScenarios(),
};

/** Headers every request carries, authenticated or not. */
function baseHeaders() {
  return PROTECTION_BYPASS ? { "x-vercel-protection-bypass": PROTECTION_BYPASS } : {};
}

function headers() {
  return Object.assign(baseHeaders(), {
    "X-API-Key": API_KEY,
    "Content-Type": "application/json",
    "X-Perf-Run": RUN_ID,
  });
}

/** Record one response against its scenario's metrics. */
function observe(scenarioName, response) {
  latency[scenarioName].add(response.timings.duration);
  failures[scenarioName].add(response.status < 200 || response.status >= 300);
}

// ---------------------------------------------------------------------------
// Setup: resolve the ids the scenarios need, and provision this run's probe.
// ---------------------------------------------------------------------------

function requireOk(response, what) {
  if (response.status < 200 || response.status >= 300) {
    fail(`${what} failed: HTTP ${response.status} ${String(response.body).slice(0, 300)}`);
  }
  return JSON.parse(response.body);
}

/** ISO timestamp `minutes` ago, for the backdated-ingest scenario. */
function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

export function setup() {
  if (!BASE_URL) fail("PERF_BASE_URL is not set");
  if (!API_KEY) fail("PERF_API_KEY is not set");

  const params = { headers: headers(), responseType: "text" };

  // The list endpoint already filters to published plans, which is exactly the
  // set a real customer could be on.
  const plans = requireOk(
    http.get(`${BASE_URL}/api/v1/plans?pageSize=100`, params),
    "listing plans",
  );
  const plan = (plans.data || [])[0];
  if (!plan) {
    fail(
      "the target tenant has no published plan, so entitlement scenarios cannot run. "
        + "Seed it first (MonetizeKit runs `pnpm demo:topup` in the application repo).",
    );
  }

  const meters = requireOk(
    http.get(`${BASE_URL}/api/v1/catalog/meters?pageSize=100`, params),
    "listing meters",
  );
  const meter = (meters.data || [])[0];
  if (!meter) fail("the target tenant has no meters, so ingest scenarios cannot run.");

  const products = requireOk(
    http.get(`${BASE_URL}/api/v1/catalog/products?pageSize=1`, params),
    "listing products",
  );
  if ((products.data || []).length === 0) {
    fail("the target tenant has no products, so catalog scenarios would measure an empty read.");
  }

  // A probe customer scoped to this run: writes land here and nowhere near the
  // showcase population, and its event history starts empty every night.
  const customer = requireOk(
    http.post(
      `${BASE_URL}/api/v1/customers`,
      JSON.stringify({
        name: `Perf Probe ${RUN_ID}`,
        email: `perf-probe+${RUN_ID}@perf.monetizekit.invalid`,
        attributes: { perfProbe: true, perfRunId: RUN_ID },
      }),
      params,
    ),
    "creating the probe customer",
  );

  const periodStart = new Date();
  const periodEnd = new Date(periodStart.getTime() + 30 * 24 * 3600 * 1000);
  requireOk(
    http.post(
      `${BASE_URL}/api/v1/subscriptions`,
      JSON.stringify({
        customerId: customer.id,
        planId: plan.id,
        status: "active",
        currentPeriodStart: periodStart.toISOString(),
        currentPeriodEnd: periodEnd.toISOString(),
      }),
      params,
    ),
    "subscribing the probe customer",
  );

  // The resolver returns the effective entitlement list directly, not an
  // envelope around it.
  const entitlements = requireOk(
    http.get(`${BASE_URL}/api/v1/entitlements/${customer.id}`, params),
    "reading probe entitlements",
  );
  const featureKeys = (Array.isArray(entitlements) ? entitlements : [])
    .map((entitlement) => entitlement.featureKey)
    .filter(Boolean);
  if (featureKeys.length === 0) {
    fail(`the probe customer's plan "${plan.name}" grants no entitlements to check.`);
  }

  return {
    customerId: customer.id,
    planId: plan.id,
    meterId: meter.id,
    featureKey: featureKeys[0],
    featureKeys: featureKeys.slice(0, 10),
  };
}

export function teardown(data) {
  if (!data || !data.customerId) return;
  // Archives the probe so tomorrow's run starts from a clean history. A failure
  // here must not fail the run: the measurements are already taken.
  http.del(`${BASE_URL}/api/v1/customers/${data.customerId}`, null, {
    headers: headers(),
    responseType: "text",
  });
}

// ---------------------------------------------------------------------------
// Scenario bodies. One exported function per scenario, named to match `exec`.
// ---------------------------------------------------------------------------

export function platform_baseline() {
  const response = http.get(`${BASE_URL}/api/build-info`, {
    headers: baseHeaders(),
    tags: { scenario: "platform-baseline" },
  });
  observe("platform-baseline", response);
}

/**
 * The network floor: the same empty request as `platform-baseline`, offered at
 * the authenticated scenarios' own rate and concurrency. Its median is what a
 * request costs before the API does any work, and is what every
 * `sloP95AboveFloorMs` target is resolved from.
 */
export function network_floor() {
  const response = http.get(`${BASE_URL}/api/build-info`, {
    headers: baseHeaders(),
    tags: { scenario: "network-floor" },
  });
  observe("network-floor", response);
}

export function entitlement_check(data) {
  const response = http.get(
    `${BASE_URL}/api/v1/entitlements/${data.customerId}/${data.featureKey}`,
    { headers: headers(), tags: { scenario: "entitlement-check" } },
  );
  observe("entitlement-check", response);
}

export function entitlement_batch(data) {
  const response = http.post(
    `${BASE_URL}/api/v1/entitlements/batch`,
    JSON.stringify({ customerId: data.customerId, featureKeys: data.featureKeys }),
    { headers: headers(), tags: { scenario: "entitlement-batch" } },
  );
  observe("entitlement-batch", response);
}

export function customer_reads() {
  const response = http.get(`${BASE_URL}/api/v1/customers?page=1&pageSize=50`, {
    headers: headers(),
    tags: { scenario: "customer-reads" },
  });
  observe("customer-reads", response);
}

export function catalog_reads() {
  const response = http.get(`${BASE_URL}/api/v1/catalog/products?pageSize=50`, {
    headers: headers(),
    tags: { scenario: "catalog-reads" },
  });
  observe("catalog-reads", response);
}

export function usage_ingest(data) {
  const response = http.post(
    `${BASE_URL}/api/v1/usage/events`,
    JSON.stringify({
      customerId: data.customerId,
      meterId: data.meterId,
      value: 1,
      idempotencyKey: `${RUN_ID}:single:${__VU}:${__ITER}`,
    }),
    { headers: headers(), tags: { scenario: "usage-ingest" } },
  );
  observe("usage-ingest", response);
}

export function usage_ingest_backdated(data) {
  const response = http.post(
    `${BASE_URL}/api/v1/usage/events`,
    JSON.stringify({
      customerId: data.customerId,
      meterId: data.meterId,
      value: 1,
      occurredAt: minutesAgo(90),
      idempotencyKey: `${RUN_ID}:backdated:${__VU}:${__ITER}`,
    }),
    { headers: headers(), tags: { scenario: "usage-ingest-backdated" } },
  );
  observe("usage-ingest-backdated", response);
}

export function usage_ingest_batch(data) {
  const events = [];
  for (let index = 0; index < BATCH_SIZE; index += 1) {
    events.push({
      customerId: data.customerId,
      meterId: data.meterId,
      value: 1,
      idempotencyKey: `${RUN_ID}:batch:${__VU}:${__ITER}:${index}`,
    });
  }
  const response = http.post(
    `${BASE_URL}/api/v1/usage/events/batch`,
    JSON.stringify({ events }),
    { headers: headers(), tags: { scenario: "usage-ingest-batch" } },
  );
  observe("usage-ingest-batch", response);
}

/**
 * k6 writes the raw summary; `packages/pipeline/src/collect.ts` turns it into a Run
 * Document. Keeping normalization in TypeScript means the schema, the analyzer,
 * and the report all share one implementation.
 */
export function handleSummary(summary) {
  return { [SUMMARY_PATH]: JSON.stringify(summary, null, 2) };
}
