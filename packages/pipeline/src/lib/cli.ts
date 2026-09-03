/**
 * CLI plumbing shared by the repo's TypeScript commands.
 *
 * Follows the conventions the rest of `scripts/` already uses: manual flag
 * parsing, a `--help` block, progress on stderr so stdout stays a clean JSON
 * document, and a non-zero exit on failure.
 */

export interface Flags {
  has(name: string): boolean;
  value(name: string): string | undefined;
  int(name: string): number | undefined;
}

export function parseFlags(argv: readonly string[]): Flags {
  const values = new Map<string, string>();
  const present = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const [name, inline] = token.slice(2).split("=", 2);
    if (!name) continue;
    present.add(name);
    if (inline !== undefined) {
      values.set(name, inline);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(name, next);
      index += 1;
    }
  }

  return {
    has: (name) => present.has(name),
    value: (name) => values.get(name),
    int: (name) => {
      const raw = values.get(name);
      if (raw === undefined) return undefined;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--${name} must be a positive integer; received "${raw}"`);
      }
      return parsed;
    },
  };
}

/** Progress goes to stderr so stdout remains machine-readable. */
export function progress(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * A run that produced a report but did not fully succeed.
 *
 * Scheduled jobs only notice failure through the exit code, so an incomplete
 * run has to be fatal — but the report is the whole diagnosis, so it is carried
 * through and printed rather than replaced by a bare message.
 */
export class IncompleteRunError extends Error {
  constructor(
    message: string,
    readonly report: unknown,
  ) {
    super(message);
    this.name = "IncompleteRunError";
  }
}

export interface RunCliOptions {
  /** Render a domain-specific error more helpfully than a stack trace. */
  describeError?: (error: unknown) => string | null;
}

export async function runCli(
  main: () => Promise<unknown>,
  options: RunCliOptions = {},
): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await main();
    if (result !== undefined) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    progress(`Completed in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  } catch (error) {
    if (error instanceof IncompleteRunError) {
      process.stdout.write(`${JSON.stringify(error.report, null, 2)}\n`);
      process.stderr.write(`\n${error.message}\n`);
      process.exit(1);
    }
    const described = options.describeError?.(error) ?? null;
    process.stderr.write(
      described !== null
        ? `\n${described}\n`
        : `\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  }
}
