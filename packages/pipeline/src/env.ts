/**
 * `pnpm perf:env` — resolve the target's facts for the steps that follow.
 *
 * In CI this is the first step after install: it reads the keys the pipeline
 * recognises from Phase.dev (when `PHASE_SERVICE_TOKEN` is set), falls back to
 * what the GitHub Environment already holds, masks the secret ones and writes
 * them all to `$GITHUB_ENV` so `perf:run` and `perf:report` find them in the
 * environment like any other variable. See `lib/phase.ts` for why the mirrored
 * secrets alone are not enough.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import { parseFlags, progress, runCli } from "./lib/cli";
import { userPathOr } from "./lib/paths";
import {
  describeResolution,
  githubEnvLines,
  maskCommands,
  parsePhaseExport,
  resolveTargetKeys,
  TARGET_KEYS,
} from "./lib/phase";

const HELP = `
pnpm perf:env — resolve the target's facts from Phase.dev into $GITHUB_ENV.

Flags:
  --github-env <path>  File to append the variables to (default: $GITHUB_ENV);
                       required outside GitHub Actions, since the values are
                       secrets and are never printed
  --help

Environment:
  PHASE_SERVICE_TOKEN  Enables the Phase read. Without it only the fallback
                       (the variables already in the environment) is used.
  PHASE_ENVIRONMENT    Phase environment to read (default: Delivery); also the
                       environment label recorded on the run
  PHASE_APP            Phase application name (or PHASE_APP_ID)
  PHASE_CLI            Path to the phase binary (default: phase on PATH)

Keys read, in the pipeline's own fallback order:
${TARGET_KEYS.map((key) => `  ${key.name}${key.secret ? "  (masked)" : ""}`).join("\n")}
`;

function readPhase(env: NodeJS.ProcessEnv): { values: Record<string, string | undefined>; label: string } {
  const environment = env.PHASE_ENVIRONMENT?.trim() || "Delivery";
  const cli = env.PHASE_CLI?.trim() || "phase";
  const args = ["secrets", "export", "--env", environment, "--format", "json"];
  if (env.PHASE_APP_ID?.trim()) args.push("--app-id", env.PHASE_APP_ID.trim());
  else if (env.PHASE_APP?.trim()) args.push("--app", env.PHASE_APP.trim());

  // Captured, never inherited: the export is every secret in the stage.
  const result = spawnSync(cli, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) {
    throw new Error(
      `could not run the Phase CLI (${cli}): ${result.error.message}\n`
        + "Install it (https://docs.phase.dev/cli/install) or point PHASE_CLI at the binary.",
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `phase secrets export --env ${environment} failed (exit ${result.status}):\n${result.stderr.trim()}\n`
        + "Check PHASE_SERVICE_TOKEN, and that the token's app has that environment.",
    );
  }
  return { values: parsePhaseExport(result.stdout), label: `Phase ${environment}` };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.has("help")) {
    process.stderr.write(HELP);
    return undefined;
  }

  const out = userPathOr(flags.value("github-env"), process.env.GITHUB_ENV ?? "");
  if (!out) {
    throw new Error(
      "nowhere to write: set GITHUB_ENV (GitHub Actions does) or pass --github-env <path>.",
    );
  }

  const phase = process.env.PHASE_SERVICE_TOKEN?.trim() ? readPhase(process.env) : null;
  if (!phase) progress("PHASE_SERVICE_TOKEN is not set; using the environment as it stands.");

  const resolution = resolveTargetKeys(phase?.values ?? null, process.env);

  // Masks first, so nothing that follows can echo a secret; then the file.
  for (const command of maskCommands(resolution)) process.stdout.write(`${command}\n`);
  appendFileSync(out, githubEnvLines(resolution));

  progress(`Resolved ${resolution.resolved.length} of ${TARGET_KEYS.length} keys:`);
  for (const line of describeResolution(resolution, phase?.label ?? "Phase")) progress(line);
  return undefined;
}

void runCli(main);
