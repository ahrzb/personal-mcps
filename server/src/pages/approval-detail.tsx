/**
 * approval-detail.tsx — /approvals/<id>, the page a -32003 error hands an agent's
 * user (§7 of the design spec; ApprovalDetail.dc.html / MobileApprovalDetail.dc.html).
 *
 * Chromeless like /login, /device, and /apps/new (ApprovalDetailProps extends
 * only PageProps, never ShellProps): it is opened from a push notification or an
 * error string, often on a phone, with one job — decide, or read, a single
 * approval. It therefore renders its own document rather than the signed-in
 * shell's `Layout` (which always draws the four-section nav header this page
 * never has).
 *
 * Pure: (props) => JSX. `approval.status` alone selects the presentation
 * (ApprovalStates.dc.html, referenced directly by model.ts): "pending" renders the
 * Approve/Reject form (one form, two submit buttons — "approve and reject share
 * the form", model.ts on `paths.approvalDecide`); every other status renders
 * read-only with its own explanation.
 */

import { html } from "hono/html";
import type { FC } from "hono/jsx";
import { paths } from "./model";
import type { ApprovalDetailProps, ApprovalRow, ApprovalStatus } from "./model";

const STYLESHEET = "/styles.css";
const MANIFEST = "/manifest.webmanifest";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** "Aug 24 14:29:55" — UTC, so the same fixture renders byte-identically off any host. */
function absolute(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** "17 minutes ago" / "in 43 minutes" (ApprovalDetail.dc.html), scaling to hours/days. */
function relative(iso: string, nowIso: string): string {
  const diffMs = new Date(iso).getTime() - new Date(nowIso).getTime();
  const future = diffMs >= 0;
  const mins = Math.round(Math.abs(diffMs) / 60000);
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  let phrase: string;
  if (mins < 1) {
    phrase = "under a minute";
  } else if (mins < 60) {
    phrase = plural(mins, "minute");
  } else if (mins < 60 * 24) {
    phrase = plural(Math.round(mins / 60), "hour");
  } else {
    phrase = plural(Math.round(mins / (60 * 24)), "day");
  }
  return future ? `in ${phrase}` : `${phrase} ago`;
}

/**
 * The "{ "key": value, ... }" spaced-compact style every artboard renders arguments
 * in (ApprovalDetail.dc.html, Approvals.dc.html) — braces and nested objects padded
 * with a single space, never multi-line. `approval.args` is already redacted
 * (approvals.ts owns that), so this only ever formats what is safe to show.
 */
function formatArgs(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[ ${value.map(formatArgs).join(", ")} ]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length === 0
      ? "{}"
      : `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${formatArgs(v)}`).join(", ")} }`;
  }
  return JSON.stringify(value);
}

/** Badge label + palette per status — the mapping styles.css itself documents on `.badge--*`. */
const BADGE: Record<ApprovalStatus, { label: string; class: string }> = {
  pending: { label: "pending", class: "badge--warning" },
  approved: { label: "approved", class: "badge--warning" },
  rejected: { label: "rejected", class: "badge--danger" },
  expired: { label: "expired", class: "badge--muted" },
  used: { label: "executed", class: "badge--success" },
};

/**
 * The two key/value rows under the identity block. Active states (pending,
 * approved) still count down against `now`, so both a relative and an absolute
 * time render (ApprovalDetail.dc.html); terminal states (expired, rejected, used)
 * are a fixed record of what happened, so only the absolute time renders
 * (ApprovalStates.dc.html's EXPIRED card drops the relative prefix entirely).
 */
function timeRows(approval: ApprovalRow, now: string): { label: string; value: string }[] {
  switch (approval.status) {
    case "pending":
    case "approved":
      return [
        { label: "Requested", value: `${relative(approval.createdAt, now)} · ${absolute(approval.createdAt)}` },
        { label: "Expires", value: `${relative(approval.expiresAt, now)} · ${absolute(approval.expiresAt)}` },
      ];
    case "expired":
      return [
        { label: "Requested", value: absolute(approval.createdAt) },
        { label: "Expired", value: absolute(approval.expiresAt) },
      ];
    case "rejected":
    case "used":
      return [
        { label: "Requested", value: absolute(approval.createdAt) },
        { label: "Decided", value: approval.decidedAt ? absolute(approval.decidedAt) : "—" },
      ];
  }
}

/** The one line explaining the status — copy lifted from ApprovalStates.dc.html where it exists. */
function explanation(approval: ApprovalRow): string {
  switch (approval.status) {
    case "pending":
      return "Single use — lets the agent run this exact call once when it retries. Nothing runs until then; a different call needs a new approval.";
    case "approved":
      return `Approved — the agent can run this exact call once when it retries. Expires ${absolute(approval.expiresAt)}.`;
    case "expired":
      return "This request expired before it was decided. If the agent still needs it, its next attempt opens a fresh request.";
    case "rejected":
      return "Rejected — the agent's call was denied. If it still needs this, its next attempt opens a fresh request.";
    case "used":
      return "Spent — the agent already used this approval on its retry. A different call needs a new approval.";
  }
}

/**
 * The hub mark from the artboards. layout.tsx draws the identical icon but keeps it
 * unexported — chromeless pages render outside that shell entirely, so it is
 * repeated here rather than imported.
 */
const BrandMark: FC = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 8.5V3.5" />
    <path d="M14.5 14.5L18.5 18.5" />
    <path d="M9.5 14.5L5.5 18.5" />
  </svg>
);

export const ApprovalDetail: FC<ApprovalDetailProps> = ({ now, csrfToken, approval }) => {
  const badge = BADGE[approval.status];

  return (
    <>
      {html`<!doctype html>`}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="theme-color" content="#ffffff" />
          <title>Approve request · personal-mcps</title>
          <link rel="stylesheet" href={STYLESHEET} />
          <link rel="manifest" href={MANIFEST} />
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
          <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" />
        </head>
        <body>
          <div class="auth">
            <div class="brand">
              <BrandMark />
              <span>personal-mcps</span>
            </div>

            <div class="auth-card">
              <div>
                <div style="display: flex; align-items: center; gap: var(--space-4);">
                  <h1 class="card-title">Approve this request?</h1>
                  <span class={`badge ${badge.class}`}>{badge.label}</span>
                </div>
                <p class="card-desc">An agent wants to run an approval-gated tool.</p>
              </div>

              <div class="kv">
                <div class="kv-row">
                  <span class="kv-key">Principal</span>
                  <span class="mono">agent:{approval.agentSlug}</span>
                </div>
                <div class="kv-row">
                  <span class="kv-key">App</span>
                  <span>{approval.appSlug}</span>
                </div>
                <div class="kv-row">
                  <span class="kv-key">Tool</span>
                  <span class="mono">{approval.tool}</span>
                </div>
                {timeRows(approval, now).map((row) => (
                  <div class="kv-row">
                    <span class="kv-key">{row.label}</span>
                    <span>{row.value}</span>
                  </div>
                ))}
              </div>

              <div class="field">
                <div class="eyebrow">Arguments</div>
                <pre class="code">{formatArgs(approval.args)}</pre>
              </div>

              <p class="muted">{explanation(approval)}</p>

              {approval.status === "pending" ? (
                <form class="actions" method="post" action={paths.approvalDecide(approval.id)}>
                  <input type="hidden" name="csrf" value={csrfToken} />
                  <button type="submit" name="decision" value="reject" class="btn btn--danger-outline" style="flex: 1;">
                    Reject
                  </button>
                  <button type="submit" name="decision" value="approve" class="btn btn--primary" style="flex: 1;">
                    Approve
                  </button>
                </form>
              ) : null}
            </div>

            <p class="auth-foot">
              All requests: <a href={paths.approvals}>Approvals dashboard</a>
            </p>
          </div>
        </body>
      </html>
    </>
  );
};
