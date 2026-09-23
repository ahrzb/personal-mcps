/**
 * The strings the client renders that are not markup: §13's two time spellings and the
 * alert class a notice's tone earns.
 *
 * Once a COPY of `server/src/pages/format.ts`, and EXACT on purpose: every page this client
 * took over printed its stamps through the original, and pass 1 holds the look constant
 * against baselines shot from those pages. The original went with the server templates
 * (decision 38's last family), so this is now the one definition.
 *
 * The one behavioural difference from the server's copy is the clock, and it is not a
 * choice: the server formatted against a render instant carried in props, and the client
 * formats against the browser's own `Date.now()`. Every function therefore takes `now`
 * explicitly, so the preview gallery can freeze it.
 */

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
export function formatLastSeen(lastSeen: number | null, now: number): string {
  if (lastSeen === null) return "—";
  const diff = now - lastSeen;
  if (diff < MINUTE) return "now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  const at = new Date(lastSeen);
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`;
}

/**
 * "48m" / "3h" / "2d" — how long remains until an instant, which is what a deadline the
 * reader can still act on is worth saying (an approval expires an hour after it was asked,
 * §7). The mirror of `formatLastSeen`, and separate from it because the two arms are read
 * differently: "3h ago" is history, "3h" is a budget.
 *
 * An instant already past reads "under a minute" rather than a negative or a dash: expiry
 * is evaluated lazily at read time (§7), so a row can be rendered a moment past its own
 * deadline and is still the row the reader is looking at.
 */
export function formatUntil(at: number, now: number): string {
  const diff = at - now;
  if (diff < MINUTE) return "under a minute";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  return `${Math.floor(diff / DAY)}d`;
}

/** "Aug 24, 2026" — UTC so a screenshot renders identically regardless of host TZ. */
export function formatStamp(at: number): string {
  return new Date(at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** A flash's tone, as the shell and every pane spell it. */
export type NoticeTone = "success" | "warning" | "danger";

/** One modifier per tone over the bare `.alert` base. */
const ALERT_CLASS: Record<NoticeTone, string> = {
  success: "alert alert--success",
  warning: "alert alert--warning",
  danger: "alert alert--danger",
};

export function alertClass(tone: NoticeTone): string {
  return ALERT_CLASS[tone];
}
