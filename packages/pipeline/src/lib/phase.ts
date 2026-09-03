/**
 * Reading the target's facts from Phase.dev at run time.
 *
 * The application repository keeps everything about a stage — its origin, the
 * showcase tenant's key and id, the dataset version it was seeded with, the
 * protection bypass — in one Phase environment, and Phase mirrors that
 * environment into this repository's GitHub Environment as secrets. That mirror
 * is a convenience with a hard edge: GitHub admits at most 100 secrets per
 * environment, and Phase drops whatever does not fit *silently*. The application
 * stage already holds more than that, so the mirror is exactly the place a newly
 * published fact (the dataset version was the first) fails to arrive.
 *
 * So, when a `PHASE_SERVICE_TOKEN` is present, the harness reads the facts it
 * needs from Phase itself — one export, the keys it recognises, nothing else —
 * and treats the mirrored secrets as the fallback for a fork or a machine
 * without Phase. This module is the pure part: which keys, which are secret,
 * and how a resolved set becomes a `GITHUB_ENV` file and masks. Running the CLI
 * is `env.ts`.
 */

export interface TargetKey {
  name: string;
  /** Masked in the job log; the rest are public facts, useful in plain sight. */
  secret: boolean;
}

/**
 * Every variable the pipeline consults about the target or the report channels,
 * in the fallback order the pipeline itself applies (`target.ts`, `report.ts`,
 * `slack.ts`). Nothing else is read from Phase: a stage's environment holds far
 * more than the harness has any business seeing.
 */
export const TARGET_KEYS: readonly TargetKey[] = [
  { name: "PERF_BASE_URL", secret: false },
  { name: "DEMO_TARGET_BASE_URL", secret: false },
  { name: "APP_BASE_URL", secret: false },
  { name: "NEXT_PUBLIC_APP_URL", secret: false },
  { name: "PERF_API_KEY", secret: true },
  { name: "DEMO_WORKSPACE_API_KEY", secret: true },
  { name: "PERF_DATASET_VERSION", secret: false },
  { name: "DEMO_DATASET_VERSION", secret: false },
  { name: "VERCEL_AUTOMATION_BYPASS_SECRET", secret: true },
  { name: "SLACK_PERF_WEBHOOK_URL", secret: true },
  { name: "SLACK_BOT_TOKEN", secret: true },
  { name: "PERF_REPORT_RECIPIENTS", secret: true },
  { name: "SENDGRID_API_KEY", secret: true },
  { name: "SENDGRID_FROM_EMAIL", secret: false },
  { name: "SENDGRID_FROM_NAME", secret: false },
];

export type Source = "phase" | "fallback";

export interface ResolvedKey extends TargetKey {
  value: string;
  source: Source;
}

export interface Resolution {
  /** Keys that have a value, in catalog order. */
  resolved: ResolvedKey[];
  /** Keys with no value anywhere; the pipeline's own fallbacks decide if that matters. */
  unset: string[];
}

type Env = Record<string, string | undefined>;

/**
 * Phase's value wins when it has one; otherwise whatever the job already had
 * (the mirrored secret) stands. Phase is the source of truth for the stage, so a
 * mirrored value can only ever be equal or stale.
 */
export function resolveTargetKeys(phase: Env | null, fallback: Env): Resolution {
  const resolved: ResolvedKey[] = [];
  const unset: string[] = [];
  for (const key of TARGET_KEYS) {
    const fromPhase = phase?.[key.name]?.trim();
    if (fromPhase) {
      resolved.push({ ...key, value: fromPhase, source: "phase" });
      continue;
    }
    const fromFallback = fallback[key.name]?.trim();
    if (fromFallback) {
      resolved.push({ ...key, value: fromFallback, source: "fallback" });
      continue;
    }
    unset.push(key.name);
  }
  return { resolved, unset };
}

/**
 * `GITHUB_ENV` lines for the resolved keys. The heredoc form is used throughout
 * so a value containing `=` or a newline is carried intact; the delimiter is
 * fixed and checked against every value rather than randomised, so the output
 * is reproducible.
 */
export function githubEnvLines(resolution: Resolution, delimiter = "__PERF_ENV_EOF__"): string {
  return resolution.resolved
    .map(({ name, value }) => {
      if (value.includes(delimiter)) {
        throw new Error(`${name} contains the heredoc delimiter ${delimiter}`);
      }
      return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
    })
    .join("");
}

/** Workflow commands that hide the secret values from the job log. */
export function maskCommands(resolution: Resolution): string[] {
  return resolution.resolved
    .filter((key) => key.secret)
    .map((key) => `::add-mask::${key.value}`);
}

/** One line per key, saying where it came from and never what it is. */
export function describeResolution(resolution: Resolution, phaseLabel: string): string[] {
  const lines = resolution.resolved.map(
    ({ name, source }) => `  ${name.padEnd(32)} ${source === "phase" ? phaseLabel : "GitHub environment"}`,
  );
  for (const name of resolution.unset) lines.push(`  ${name.padEnd(32)} unset`);
  return lines;
}

/**
 * Parse `phase secrets export --format json`: a flat object of key to value.
 * Anything else is a CLI or auth failure surfaced as JSON, and the error text is
 * more useful than a parse failure.
 */
export function parsePhaseExport(stdout: string): Env {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`phase secrets export did not return JSON: ${stdout.slice(0, 200)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("phase secrets export returned something other than a key/value object");
  }
  const env: Env = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}
