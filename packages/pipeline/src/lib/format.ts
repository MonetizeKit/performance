/**
 * Presentation helpers shared by the email report, the trends dashboard and the
 * per-run pages.
 *
 * Kept together so the same measurement is never rendered two different ways:
 * a p95 quoted as "1.2s" in the email and "1204ms" on the page it links to
 * invites the reader to wonder which one is the real number.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Milliseconds, switching to seconds once "ms" stops being readable. */
export function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

/** A ratio as a signed percentage change, or an em dash when there is none. */
export function percent(ratio: number | null): string {
  if (ratio === null) return "—";
  const delta = (ratio - 1) * 100;
  return `${delta > 0 ? "+" : ""}${delta.toFixed(0)}%`;
}

/** `2026-09-01T18:38:41.000Z` → `2026-09-01 18:38`. */
export function shortTimestamp(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}
