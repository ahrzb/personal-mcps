/**
 * `/approvals` and `/approvals/<id>` as pure functions: what a row SAYS, and where a decision
 * lands. No React, no DOM, no clock of its own and no `@/` runtime import — which is what lets
 * `server/test/unit/approvals-derive.test.ts` pin these rules from plain Node.
 *
 * Ported line for line from `server/src/pages/approvals.tsx`, `approval-detail.tsx` and
 * `pages/model.ts`'s `approvalsProps`. The two pages spell a timestamp DIFFERENTLY — the
 * list's "Aug 3 09:05:01", the detail's "Aug 03 09:05:01" — and both spellings are kept,
 * because each is compared pixel for pixel against its own server rendering.
 */

import type { ApprovalRow, ApprovalStatus, DetailApproval } from "../../lib/types";

/** The history a link naming no `?limit=` gets — the server page's `HISTORY_LIMIT`, ported. */
export const HISTORY_LIMIT = 20;

/**
 * The history cap `?limit=` asks for, or the default. `model.ts`'s `positive` verbatim — so
 * `0` IS accepted (an empty history with "Older →"), and anything that is not a whole number
 * is the default rather than an error, as the server read it.
 */
export function historyLimitOf(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return HISTORY_LIMIT;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : HISTORY_LIMIT;
}

/**
 * The `?limit=` the history read asks the server for. `approval_list`'s limit caps the WHOLE
 * listing, pending rows included, so they are paid for here — otherwise a namespace with many
 * open requests would show no history at all — and one more row is read than is shown, to
 * know whether "Older →" is worth drawing.
 */
export function historyReadLimit(historyLimit: number, pendingCount: number): number {
  return historyLimit + pendingCount + 1;
}

/**
 * The listing as the History section draws it: everything not pending, newest first (the
 * listing's own order), cut at the cap — and whether the ledger holds more past it.
 */
export function historyOf(
  listed: ApprovalRow[],
  historyLimit: number,
): { history: ApprovalRow[]; hasMore: boolean } {
  const decided = listed.filter((row) => row.status !== "pending");
  return { history: decided.slice(0, historyLimit), hasMore: decided.length > historyLimit };
}

/* ------------------------------------------------------------ spellings ---- */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** The list's "Aug 24 14:29:55" — UTC, day unpadded (`approvals.tsx`'s `formatStamp`). */
export function listStamp(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** The detail's "Aug 24 14:29:55" — UTC, day PADDED (`approval-detail.tsx`'s `absolute`). */
export function detailStamp(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** Whole minutes from `now` (epoch ms) to `target`, floored at 0 for an instant already
 *  past: expiry is judged lazily at read time (§7), so a row can be drawn a moment late. */
export function minutesUntil(now: number, target: string): number {
  return Math.max(0, Math.round((Date.parse(target) - now) / 60_000));
}

/** "17 minutes ago" / "in 43 minutes", scaling to hours and days (`approval-detail.tsx`). */
export function relative(iso: string, now: number): string {
  const diffMs = Date.parse(iso) - now;
  const future = diffMs >= 0;
  const mins = Math.round(Math.abs(diffMs) / 60000);
  const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const phrase =
    mins < 1
      ? "under a minute"
      : mins < 60
        ? plural(mins, "minute")
        : mins < 60 * 24
          ? plural(Math.round(mins / 60), "hour")
          : plural(Math.round(mins / (60 * 24)), "day");
  return future ? `in ${phrase}` : `${phrase} ago`;
}

/** Every row here is an agent's: `approvals.ts` refuses any other principal. */
export function principalOf(row: ApprovalRow): string {
  return `agent:${row.agentSlug}`;
}

/**
 * The detail's `{ "key": value, ... }` — single-line, braces and nested objects padded with
 * one space, the spelling every artboard draws arguments in. The list's cards use
 * `JSON.stringify(args, null, 2)` instead, which is the list's own spelling.
 *
 * The args are already redacted (`approvals.ts` stores nothing else), so this only ever
 * formats what is safe to show.
 */
export function formatArgs(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[ ${value.map(formatArgs).join(", ")} ]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length === 0
      ? "{}"
      : `{ ${entries.map(([key, each]) => `${JSON.stringify(key)}: ${formatArgs(each)}`).join(", ")} }`;
  }
  return JSON.stringify(value);
}

/** A badge's class suffix — `styles.css`'s `.badge--*`. */
export type Tone = "warning" | "success" | "danger" | "muted";

/**
 * A HISTORY row's outcome, lifted from the artboards rather than guessed: a spent pass reads
 * "executed", rejected is the only danger row, and approved-but-unspent and expired stay in
 * one amber family. Pending never reaches this — pending rows are the cards above.
 */
export function historyOutcome(status: ApprovalStatus): { label: string; tone: Tone } {
  if (status === "rejected") return { label: "rejected", tone: "danger" };
  if (status === "used") return { label: "executed", tone: "success" };
  if (status === "approved") return { label: "approved", tone: "warning" };
  return { label: "expired", tone: "warning" };
}

/** The DETAIL page's badge — which differs from the history's on one row, and deliberately:
 *  a lone expired request reads muted there, where the table keeps it amber beside its
 *  neighbours (`approval-detail.tsx`'s `BADGE`). */
export function detailBadge(status: ApprovalStatus): { label: string; tone: Tone } {
  if (status === "pending") return { label: "pending", tone: "warning" };
  if (status === "expired") return { label: "expired", tone: "muted" };
  return historyOutcome(status);
}

/**
 * The detail's two time rows. A live request (pending, approved) still counts down, so both
 * a relative and an absolute time; a terminal one is a fixed record, so the absolute alone.
 */
export function timeRows(approval: DetailApproval, now: number): { label: string; value: string }[] {
  switch (approval.status) {
    case "pending":
    case "approved":
      return [
        { label: "Requested", value: `${relative(approval.createdAt, now)} · ${detailStamp(approval.createdAt)}` },
        { label: "Expires", value: `${relative(approval.expiresAt, now)} · ${detailStamp(approval.expiresAt)}` },
      ];
    case "expired":
      return [
        { label: "Requested", value: detailStamp(approval.createdAt) },
        { label: "Expired", value: detailStamp(approval.expiresAt) },
      ];
    case "rejected":
    case "used":
      return [
        { label: "Requested", value: detailStamp(approval.createdAt) },
        { label: "Decided", value: detailStamp(approval.decidedAt) },
      ];
  }
}

/** The one line under the arguments explaining the status (ApprovalStates.dc.html). */
export function explanation(approval: ApprovalRow): string {
  switch (approval.status) {
    case "pending":
      return "Single use — lets the agent run this exact call once when it retries. Nothing runs until then; a different call needs a new approval.";
    case "approved":
      return `Approved — the agent can run this exact call once when it retries. Expires ${detailStamp(approval.expiresAt)}.`;
    case "expired":
      return "This request expired before it was decided. If the agent still needs it, its next attempt opens a fresh request.";
    case "rejected":
      return "Rejected — the agent's call was denied. If it still needs this, its next attempt opens a fresh request.";
    case "used":
      return "Spent — the agent already used this approval on its retry. A different call needs a new approval.";
  }
}

/**
 * Where a decision lands, from EITHER page: `/approvals` carrying the flash keys, exactly the
 * Location `web.ts`'s `noticeUrl` wrote for the 303 this replaces — `done=approval_decide` on
 * success, `failed=approval_decide` plus the refusal's words otherwise, and no `reason` key
 * at all for an empty one (`noticeOf` then says the words itself).
 *
 * A search bag rather than a URL, because the caller navigates client-side; `lib/notice.ts`
 * reads the same two keys back.
 */
export function decisionLanding(outcome: { ok: true } | { ok: false; reason: string }): Record<string, string> {
  if (outcome.ok) return { done: "approval_decide" };
  return outcome.reason === ""
    ? { failed: "approval_decide" }
    : { failed: "approval_decide", reason: outcome.reason };
}
