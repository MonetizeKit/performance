/**
 * Attribution: what shipped between the last measured build and this one.
 *
 * A latency delta is only actionable if you know what changed to cause it, and
 * the answer is almost never in the run itself. Each Run Document therefore
 * carries the range between the previously measured `appSha` and its own.
 *
 * This harness measures a deployment; it does not hold the application's source.
 * So by default the range is expressed as a compare link into the application
 * repository, which is exactly what an engineer opens anyway. Commit-level
 * detail — subjects, migrations, dependency moves — is optional and arrives as
 * a payload from the application repository's own automation, which has the
 * history and can decide what is fit to publish. When present it is recorded;
 * when absent nothing is invented.
 */

import { readFileSync } from "node:fs";

import type {
  ChangeSet,
  ChangeSetCommit,
  DependencyChange,
} from "./run-document";

/** Beyond this the list stops being read and starts being skimmed. */
export const MAX_COMMITS = 40;

/**
 * Commit-level detail supplied by the application repository.
 *
 * Only the fields the payload chooses to send are used; a payload for a
 * different range than the one being attributed is refused rather than
 * silently attached to the wrong run.
 */
export interface ChangeSetPayload {
  previousAppSha: string;
  appSha: string;
  commits?: ChangeSetCommit[];
  migrations?: string[];
  dependencies?: DependencyChange[];
}

export function readChangeSetPayload(path: string): ChangeSetPayload {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ChangeSetPayload>;
  if (typeof raw.previousAppSha !== "string" || typeof raw.appSha !== "string") {
    throw new Error(`${path} is not a change-set payload: previousAppSha and appSha are required.`);
  }
  return raw as ChangeSetPayload;
}

export interface AttributionInput {
  previousAppSha: string | null;
  appSha: string | null;
  /** `https://github.com/<owner>/<repo>` of the application under test. */
  appRepositoryUrl: string | null;
  payload?: ChangeSetPayload | null;
}

function empty(detail: ChangeSet["detail"], previousAppSha: string | null): ChangeSet {
  return {
    detail,
    previousAppSha,
    commits: [],
    migrations: [],
    dependencies: [],
    compareUrl: null,
    truncated: false,
    unavailableReason: null,
  };
}

export function compareUrlFor(
  appRepositoryUrl: string | null,
  previousAppSha: string,
  appSha: string,
): string | null {
  return appRepositoryUrl
    ? `${appRepositoryUrl.replace(/\/+$/, "")}/compare/${previousAppSha}...${appSha}`
    : null;
}

export function attribute(input: AttributionInput): ChangeSet {
  const { previousAppSha, appSha, appRepositoryUrl, payload = null } = input;

  if (!appSha) {
    return {
      ...empty("unavailable", previousAppSha),
      unavailableReason: "the deployment did not report a build commit",
    };
  }
  if (!previousAppSha) {
    return {
      ...empty("unavailable", null),
      unavailableReason: "no earlier run recorded a build commit to compare against",
    };
  }
  if (previousAppSha === appSha) {
    return empty("same-build", previousAppSha);
  }

  const compareUrl = compareUrlFor(appRepositoryUrl, previousAppSha, appSha);

  if (payload) {
    if (payload.previousAppSha !== previousAppSha || payload.appSha !== appSha) {
      throw new Error(
        `the change-set payload describes ${payload.previousAppSha.slice(0, 7)}..${payload.appSha.slice(0, 7)} `
          + `but this run is ${previousAppSha.slice(0, 7)}..${appSha.slice(0, 7)}; refusing to attach it.`,
      );
    }
    const commits = payload.commits ?? [];
    return {
      detail: "commits",
      previousAppSha,
      commits: commits.slice(0, MAX_COMMITS),
      migrations: [...(payload.migrations ?? [])].sort(),
      dependencies: [...(payload.dependencies ?? [])].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
      compareUrl,
      truncated: commits.length > MAX_COMMITS,
      unavailableReason: null,
    };
  }

  return { ...empty("compare-link", previousAppSha), compareUrl };
}
