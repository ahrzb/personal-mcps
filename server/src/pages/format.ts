// format.ts — the strings the pages render that are not markup: §13's two time spellings
// and the alert class a notice's tone earns.
//
// One definition each, because a difference between two pages IS read as meaning: /apps's
// "Last seen" column and /apps/<slug>'s header state the same fact, so a second copy of
// the stamp is a second chance for them to disagree about it.

import type { Notice } from "./model";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "now" / "12m ago" / "3h ago" / "Aug 20" — an instant that is RECENT by nature, where the
 * year is implicit and printing it would be noise: /apps's Last seen column, the app
 * header's own stamp, a token's Issued and Last used.
 *
 * An instant that does not exist reads the dash those tables read, never the rail's `—`,
 * which means "advertises none" and nothing else (§13).
 *
 * A date that is NOT recent by nature — a creation date — wants `formatStamp`: its year is
 * the whole difference between an app created in 2025 and one created this August.
 */
export function formatLastSeen(lastSeen: number | null, nowIso: string): string {
  if (lastSeen === null) return "—";
  const diff = Date.parse(nowIso) - lastSeen;
  if (diff < MINUTE) return "now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  const at = new Date(lastSeen);
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`;
}

/** "Aug 24, 2026" — UTC so a fixture renders identically regardless of host TZ. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The same, for the epoch milliseconds the ops tables speak in. */
export function formatStamp(at: number): string {
  return formatDate(new Date(at).toISOString());
}

/** "info" needs no modifier — the bare `.alert` IS the muted tone model.ts describes for
 *  it — the other three tones each have their own. */
const ALERT_CLASS: Record<Notice["tone"], string> = {
  info: "alert",
  success: "alert alert--success",
  warning: "alert alert--warning",
  danger: "alert alert--danger",
};

export function alertClass(tone: Notice["tone"]): string {
  return ALERT_CLASS[tone];
}
