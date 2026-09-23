/**
 * `/settings` as pure functions: which pane a URL names, what the rail says beside each
 * entry, which dialog a `?confirm=` opens, which control a refused password change named, and
 * how every stamp on the page is spelled.
 *
 * Ported from `server/src/pages/settings.tsx`, `pages/model.ts`'s `settingsProps` view rules
 * (`settingsConfirm`, `tokenKindOf`, `passwordErrorOf`, `timeoutLabel`) and `web.ts`'s
 * `executionErrors` — the rules the routes design (§2) moves to the client now that the
 * server answers one read and the URL is the client's. No React, no DOM and no `@/` runtime
 * import, so `server/test/unit/settings-derive.test.ts` pins them from plain Node.
 */

import { formatStamp } from "../../lib/format";
import { SETTINGS_CONFIRM_PANE, SETTINGS_PANES } from "../../lib/paths";
import type { SettingsConfirmKind, SettingsPane } from "../../lib/paths";
import type {
  ConnectionRow,
  PasskeyRow,
  SessionRow,
  SettingsRead,
  SettingsTokenRow,
  Violation,
} from "../../lib/types";
import { searchOne, shownSentence } from "../apps/derive";
import type { SearchBag } from "../apps/derive";

/** The pane a `/settings/<segment>` URL names, or null for a segment that is not one — and
 *  `password` is not one: the landing pane has no alias (the Worker 404s `/settings/password`). */
export function settingsPaneOf(segment: string | undefined): SettingsPane | null {
  if (segment === undefined) return "password";
  if (segment === "password") return null;
  return SETTINGS_PANES.find((entry) => entry.pane === segment)?.pane ?? null;
}

/* ------------------------------------------------------------ the tokens ---- */

/** §13's `?kind=agent|app`, or null for All — anything else is All too, because a filter
 *  naming no kind is not a filter (and never an empty listing). */
export function tokenKindOf(search: SearchBag): SettingsTokenRow["kind"] | null {
  const kind = searchOne(search, "kind");
  return kind === "agent" || kind === "app" ? kind : null;
}

/** The rows the Tokens pane lists under a filter. Named once because the rail counts the SAME
 *  call: §13 reads every marker as "the rows its pane lists", so a filtered pane narrows both. */
export function listedTokens(
  tokens: SettingsTokenRow[],
  kind: SettingsTokenRow["kind"] | null,
): SettingsTokenRow[] {
  return kind === null ? tokens : tokens.filter((token) => token.kind === kind);
}

/* -------------------------------------------------------------- the rail ---- */

/** A rail entry's marker — `chrome/Panes`' `PaneMarker`, restated here so this module stays
 *  free of a component import. `null` draws no marker at all. */
export type RailMarker = { text: string; dot?: "on" | "off" } | null;

/**
 * §13's rail table, as data: the seven panes in the one order both navigations draw, each with
 * the marker its own pane's list produces. Password's `null` is the table's `none`; Two-factor's
 * is the one marker that is a status, said in words as well as in colour; Execution's is the
 * pair in seconds, the one reading of it that fits a glance.
 */
export function railEntries(
  read: SettingsRead,
  pane: SettingsPane,
  kind: SettingsTokenRow["kind"] | null,
): { pane: SettingsPane; label: string; short: string; group: string; marker: RailMarker; current: boolean }[] {
  const markers: Record<SettingsPane, RailMarker> = {
    password: null,
    "two-factor": read.twoFactor.enabled ? { text: "enabled", dot: "on" } : { text: "not enabled", dot: "off" },
    passkeys: { text: String(read.passkeys.length) },
    sessions: { text: String(read.sessions.length) },
    tokens: { text: String(listedTokens(read.tokens, kind).length) },
    clients: { text: String(read.connections.length) },
    execution: {
      text: `${timeoutLabel(read.execution.defaultTimeoutMs)} / ${timeoutLabel(read.execution.maxTimeoutMs)}`,
    },
  };
  return SETTINGS_PANES.map((entry) => ({ ...entry, marker: markers[entry.pane], current: entry.pane === pane }));
}

/** "30s" where the milliseconds divide evenly, "1500ms" where they do not — a value the reader
 *  would have to convert is not a glance (`pages/model.ts`'s `timeoutLabel`). */
export function timeoutLabel(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

/* ----------------------------------------------------------- the dialogs ---- */

/** The destructive confirmation on screen, carrying exactly what its copy names — so the
 *  dialog never looks anything up, and its title spells the row as the row does. */
export type SettingsConfirm =
  | { kind: "disable-two-factor" }
  | { kind: "remove-passkey"; id: string; name: string }
  | { kind: "revoke-session"; id: string; label: string }
  | { kind: "revoke-other-sessions" }
  | { kind: "revoke-connection"; id: string; client: string };

/**
 * Which dialog `?confirm=` opens on this pane, or none. A dialog belongs to the pane that draws
 * its control, so the same query on another pane opens nothing; and a `confirm` naming no row —
 * a guessed id, the current session, a revoked binding — is no dialog rather than a dialog
 * about nothing (`pages/model.ts`'s `settingsConfirm`).
 */
export function settingsConfirm(search: SearchBag, pane: SettingsPane, read: SettingsRead): SettingsConfirm | null {
  const kind = searchOne(search, "confirm") ?? "";
  if (!Object.prototype.hasOwnProperty.call(SETTINGS_CONFIRM_PANE, kind)) return null;
  if (SETTINGS_CONFIRM_PANE[kind as SettingsConfirmKind] !== pane) return null;
  const id = searchOne(search, "id") ?? "";
  switch (kind as SettingsConfirmKind) {
    case "disable-two-factor":
      return { kind: "disable-two-factor" };
    case "revoke-other-sessions":
      return { kind: "revoke-other-sessions" };
    case "revoke-session": {
      const row = read.sessions.find((session: SessionRow) => session.id === id && !session.current);
      return row === undefined ? null : { kind: "revoke-session", id, label: sessionLabel(row) };
    }
    case "remove-passkey": {
      const row = read.passkeys.find((pk: PasskeyRow) => pk.id === id);
      return row === undefined ? null : { kind: "remove-passkey", id, name: row.name };
    }
    case "revoke-connection": {
      const row = read.connections.find((c: ConnectionRow) => c.id === id && c.revokedAt === null);
      return row === undefined ? null : { kind: "revoke-connection", id, client: row.clientName ?? row.clientId };
    }
  }
}

/** "pmcp CLI · device flow" for a CLI session, the client as-is otherwise — one definition for
 *  the row and the revoke dialog's title, so the two cannot spell one session two ways. */
export function sessionLabel(session: SessionRow): string {
  return session.source === "cli" ? `${session.client} · device flow` : session.client;
}

/* --------------------------------------------------------- the password ---- */

/** The Password pane's three controls, by the names its form and the server's `field=` use. */
export const PASSWORD_FIELDS = ["currentPassword", "newPassword", "confirmPassword"] as const;
export type PasswordField = (typeof PASSWORD_FIELDS)[number];

/**
 * The control a refused **Update password** named, read off the landing's own flash —
 * `failed=` present, `field=` one of the three — and only on the pane that drew the form.
 * The field travels, never the sentence: the words are the pane's (`passwordRefusal`).
 */
export function passwordErrorOf(flash: URLSearchParams | null, pane: SettingsPane): PasswordField | null {
  if (flash === null || pane !== "password" || flash.get("failed") === null) return null;
  const field = flash.get("field");
  return PASSWORD_FIELDS.find((name) => name === field) ?? null;
}

/** §13's three mapped refusals as the words beside each control. The new-password one IS the
 *  length hint, drawn from the server's one minimum and never from a literal of this page's. */
export function passwordRefusal(minLength: number): Record<PasswordField, string> {
  return {
    currentPassword: "That password is not right.",
    newPassword: `At least ${minLength} characters.`,
    confirmPassword: "The two entries do not match.",
  };
}

/** §13's "Confirmed your identity N minutes ago." — whole minutes since the current session's
 *  `createdAt`, the value the recent-auth gate judges on, so the line explains a bounce. */
export function confirmedLine(iso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  return `Confirmed your identity ${minutes} minute${minutes === 1 ? "" : "s"} ago.`;
}

/* -------------------------------------------------------- the execution ---- */

/** The Execution pane's messages, one slot per control plus the whole-form one. */
export type ExecutionErrors = Partial<Record<"defaults" | "maximum" | "form", string>>;

/**
 * §23.3's refusal as the pane draws it (`web.ts`'s `executionErrors`): each violation under the
 * control it names, anything naming neither as the whole-form message, and two on one control
 * joined with a space because the control has one place to say things.
 */
export function executionErrors(violations: readonly Violation[]): ExecutionErrors {
  const errors: ExecutionErrors = {};
  for (const violation of violations) {
    const key =
      violation.field === "default_timeout_ms" ? "defaults" : violation.field === "max_timeout_ms" ? "maximum" : "form";
    const sentence = shownSentence(violation);
    errors[key] = errors[key] === undefined ? sentence : `${errors[key]} ${sentence}`;
  }
  return errors;
}

/* ------------------------------------------------------------- the stamps ---- */

/** "Aug 24, 2026" from an ISO stamp — `lib/format`'s spelling, which the Tokens pane prints
 *  from epoch ms. */
export function formatDate(iso: string): string {
  return formatStamp(Date.parse(iso));
}

/** Calendar-day difference in UTC — "yesterday" is the previous date, not "within 24h". */
function calendarDaysBetween(from: number, to: number): number {
  const a = new Date(from);
  const b = new Date(to);
  return Math.round(
    (Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) -
      Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate())) /
      86_400_000,
  );
}

/** "Now" / "N minutes ago" / "N hours ago" / "yesterday" / "N days ago", then a date past a
 *  week — the relative spelling §13 gives this page and no other. */
export function formatRelative(iso: string, now: number): string {
  const at = Date.parse(iso);
  const diffMs = now - at;
  const dayDiff = calendarDaysBetween(at, now);
  if (dayDiff <= 0) {
    if (diffMs < 60_000) return "Now";
    if (diffMs < 3_600_000) {
      const m = Math.max(1, Math.floor(diffMs / 60_000));
      return `${m} minute${m === 1 ? "" : "s"} ago`;
    }
    const h = Math.floor(diffMs / 3_600_000);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  if (dayDiff === 1) return "yesterday";
  if (dayDiff < 7) return `${dayDiff} days ago`;
  return formatDate(iso);
}
