import type { Flags } from "./cli";

/**
 * Notes recorded on the run: the shared-key warning, if the preflight was
 * overridden, followed by any operator-supplied `--note`. Lives outside the
 * `perf:run` entrypoint so the composition can be tested without importing a
 * module that starts a run on load.
 */
export function collectNotes(flags: Flags, sharedKeyNote: string | null): string[] {
  const notes: string[] = [];
  if (sharedKeyNote) notes.push(sharedKeyNote);
  const note = flags.value("note");
  if (note) notes.push(note);
  return notes;
}
