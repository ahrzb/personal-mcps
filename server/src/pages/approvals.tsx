/**
 * approvals.tsx — /approvals: pending requests awaiting a decision, plus recent
 * decision history. Pixel reference: design/Approvals.dc.html (desktop),
 * design/MobileApprovals.dc.html (narrow), design/ApprovalStates.dc.html (badge
 * tones) and design/EmptyStates.dc.html ("Approvals — no pending" / "— no history").
 *
 * Pure: `(props: ApprovalsProps) => JSX`. No fetching, no cookies, no Date.now() —
 * every relative figure ("expires in 43 min") is derived from the row's own
 * ISO-8601 fields against `props.now`, and every URL comes from `paths` (./model).
 *
 * Three pieces, one template, responsive CSS only (no separate mobile markup):
 *  - Pending: one card per row. Approve and Reject POST into the SAME form —
 *    `paths.approvalDecide(id)`'s own doc comment says so — the decision riding
 *    the submit button's `value`, exactly like `paths.deviceDecide`.
 *  - History: decided/expired/spent rows, newest first, one <table> whose narrow
 *    breakpoint collapses via the existing `.wide-only` / `.cell-summary` pair
 *    (the same technique the services table review already verified against
 *    MobileServices) rather than a second markup tree.
 *  - The per-browser push opt-in: the one bit of client script this page ships,
 *    mirroring the service-worker registration script layout.tsx already embeds.
 *    Its wire format (a CSRF-carrying FormData POST to `paths.approvalsPush`) is
 *    this file's own choice — web.ts's checkCsrf is generic over any FormData.
 *
 * Empty pending and empty history are independent props states, not one big
 * "empty" flag — the `empty` fixture shows both at once, `noPending` only the
 * first, and each renders its own EmptyStates card.
 */

import type { FC } from "hono/jsx";
import { paths } from "./model";
import type { ApprovalRow, ApprovalStatus, ApprovalsProps, Notice } from "./model";
import { Layout } from "./layout";

/* ------------------------------------------------------------------ *
 * Formatting — pure functions of the row's own fields and `now`.
 * ------------------------------------------------------------------ */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** "Aug 24 14:29:55" — every timestamp in props is ISO-8601 UTC (model.ts). */
function formatStamp(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** Whole minutes from `now` to `target`, floored at 0 for an already-past instant. */
function minutesUntil(now: string, target: string): number {
  return Math.max(0, Math.round((Date.parse(target) - Date.parse(now)) / 60_000));
}

/** approvals.ts: "principal must be a service-account principal" — every row here is one. */
function principalOf(row: ApprovalRow): string {
  return `sa:${row.accountSlug}`;
}

type Tone = "warning" | "success" | "danger";

/**
 * Outcome label + badge tone, lifted from the artboards rather than guessed: a
 * spent pass reads "executed" (not "used"), rejected is the only danger row, and
 * pending / approved-but-unspent / expired-unused all stay in the same amber
 * family (Approvals.dc.html's history rows render all three identically).
 */
function outcome(status: ApprovalStatus): { label: string; tone: Tone } {
  if (status === "rejected") return { label: "rejected", tone: "danger" };
  if (status === "used") return { label: "executed", tone: "success" };
  if (status === "approved") return { label: "approved", tone: "warning" };
  if (status === "pending") return { label: "pending", tone: "warning" };
  return { label: "expired", tone: "warning" };
}

/** "info" needs no modifier — the bare `.alert` IS the muted #f4f4f5 tone
 * model.ts describes for it — the other three tones each have their own. */
const ALERT_CLASS: Record<Notice["tone"], string> = {
  info: "alert",
  success: "alert alert--success",
  warning: "alert alert--warning",
  danger: "alert alert--danger",
};

function alertClass(tone: Notice["tone"]): string {
  return ALERT_CLASS[tone];
}

/* ------------------------------------------------------------------ *
 * Icons — stroke="currentColor" so they inherit the surrounding tone.
 * ------------------------------------------------------------------ */

const BellIcon: FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
);

/** Warning/danger reuse Device.dc.html's alert-triangle; success/info get their own. */
const NoticeIcon: FC<{ tone: Notice["tone"] }> = ({ tone }) => {
  if (tone === "success") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    );
  }
  if (tone === "info") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4" />
        <path d="M12 8h.01" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
};

/* ------------------------------------------------------------------ *
 * Pending card
 * ------------------------------------------------------------------ */

const PendingCard: FC<{ row: ApprovalRow; now: string; csrfToken: string }> = ({ row, now, csrfToken }) => (
  <form class="card approval" method="post" action={paths.approvalDecide(row.id)}>
    <input type="hidden" name="csrf" value={csrfToken} />
    <div class="approval-head">
      <div>
        {/* wide: "set_scene  on home" on one baseline; narrow: tool alone, then a
            single compact meta line — two spellings of the same fields (Approvals
            vs MobileApprovals), not two data shapes. */}
        <div class="wide-only" style="display: flex; align-items: baseline; gap: var(--space-4);">
          <div class="approval-tool">{row.tool}</div>
          <div class="approval-where">on {row.serviceSlug}</div>
        </div>
        <div class="approval-tool narrow-only">{row.tool}</div>
        <div class="approval-meta wide-only">
          {principalOf(row)} · requested {formatStamp(row.createdAt)}
        </div>
        <div class="note narrow-only">
          {row.serviceSlug} · {principalOf(row)} · {formatStamp(row.createdAt)}
        </div>
      </div>
      <div class="approval-status">
        <span class="badge badge--warning">pending</span>
        <div class="expiry">expires in {minutesUntil(now, row.expiresAt)} min</div>
      </div>
    </div>
    {/* A plain (non-<pre>) block: normal white-space collapses JSON.stringify's
        indentation to single spaces, which is exactly the compact
        `{ "scene": "movie_night" }` rendering the artboards show for small
        argument objects, while still wrapping (overflow-wrap: anywhere) instead
        of overflowing for the bulky ones (see fixtures.ts's `bulkyArgs`). */}
    <div class="code">{JSON.stringify(row.args, null, 2)}</div>
    <div class="actions">
      <button type="submit" name="decision" value="reject" class="btn btn--danger-outline btn--sm">
        Reject
      </button>
      <button type="submit" name="decision" value="approve" class="btn btn--primary btn--sm">
        Approve
      </button>
    </div>
  </form>
);

/* ------------------------------------------------------------------ *
 * History row
 * ------------------------------------------------------------------ */

const HistoryRow: FC<{ row: ApprovalRow }> = ({ row }) => {
  const out = outcome(row.status);
  // A row that lapsed unattended has no decidedAt; the artboard's "Decided"
  // column falls back to when it was requested rather than leaving it blank.
  const when = row.decidedAt ?? row.createdAt;
  return (
    <tr>
      <td class="wide-only cell-time">{formatStamp(when)}</td>
      <td class="wide-only cell-mono">{principalOf(row)}</td>
      <td class="wide-only">{row.serviceSlug}</td>
      <td class="wide-only cell-mono">
        <a href={paths.approval(row.id)}>{row.tool}</a>
      </td>
      <td class="wide-only">
        <span class={`badge badge--${out.tone}`}>{out.label}</span>
      </td>
      <td class="cell-summary">
        <div>
          <a class="list-title mono" href={paths.approval(row.id)}>
            {row.tool}
          </a>
          <div class="note">
            {formatStamp(when)} · {principalOf(row)} · {row.serviceSlug}
          </div>
        </div>
        <span class={`badge badge--${out.tone}`}>{out.label}</span>
      </td>
    </tr>
  );
};

/* ------------------------------------------------------------------ *
 * Push opt-in — the page's one client script.
 * ------------------------------------------------------------------ */

const PUSH_SCRIPT = `(function () {
  var btn = document.getElementById("approvals-push-toggle");
  if (!btn) return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    btn.setAttribute("disabled", "true");
    btn.setAttribute("aria-disabled", "true");
    return;
  }
  function urlBase64ToUint8Array(base64) {
    var padding = "=".repeat((4 - (base64.length % 4)) % 4);
    var safe = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
    var raw = atob(safe);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function markEnabled() {
    btn.setAttribute("disabled", "true");
    btn.setAttribute("aria-disabled", "true");
    var labels = btn.querySelectorAll("span");
    for (var i = 0; i < labels.length; i++) labels[i].textContent = "Notifications on";
  }
  navigator.serviceWorker.ready
    .then(function (reg) { return reg.pushManager.getSubscription(); })
    .then(function (sub) { if (sub) markEnabled(); })
    .catch(function () {});
  btn.addEventListener("click", function () {
    navigator.serviceWorker.ready
      .then(function (reg) {
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(btn.dataset.vapidKey),
        });
      })
      .then(function (sub) {
        var body = new FormData();
        body.append("csrf", btn.dataset.csrf);
        body.append("subscription", JSON.stringify(sub.toJSON()));
        return fetch(btn.dataset.pushUrl, { method: "POST", body: body });
      })
      .then(markEnabled)
      .catch(function () {});
  });
})();`;

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export function ApprovalsPage(props: ApprovalsProps) {
  const { notice, pending, history, historyLimit, hasMoreHistory, now, csrfToken, vapidPublicKey } = props;

  return (
    <Layout title="Approvals" active="approvals" username={props.username} pendingApprovals={props.pendingApprovals}>
      <div class="page page--narrow">
        {notice ? (
          <div class={alertClass(notice.tone)}>
            <NoticeIcon tone={notice.tone} />
            <div>
              {notice.title ? <div class="alert-title">{notice.title}</div> : null}
              <div class={notice.title ? "alert-text" : undefined}>{notice.message}</div>
            </div>
          </div>
        ) : null}

        <div class="page-head">
          <div>
            <h1 class="page-title">Approvals</h1>
            <p class="page-subtitle wide-only">
              Approval-gated requests from your service accounts. Approving lets the agent retry the exact call once;
              approvals expire after an hour.
            </p>
            <p class="page-subtitle narrow-only">Single use · expire after an hour</p>
          </div>
          <button
            type="button"
            id="approvals-push-toggle"
            class="btn btn--outline btn--sm"
            data-vapid-key={vapidPublicKey}
            data-push-url={paths.approvalsPush}
            data-csrf={csrfToken}
          >
            <BellIcon />
            <span class="wide-only">Enable notifications</span>
            <span class="narrow-only">Notifications</span>
          </button>
        </div>

        <section class="section">
          <h2 class="section-title">Pending</h2>
          {pending.length === 0 ? (
            <div class="empty">
              <div class="empty-title">No pending requests</div>
              <div class="empty-text">Approval-gated calls appear here the moment an agent hits one.</div>
            </div>
          ) : (
            pending.map((row) => <PendingCard row={row} now={now} csrfToken={csrfToken} />)
          )}
        </section>

        <section class="section">
          <h2 class="section-title">History</h2>
          {history.length === 0 ? (
            <div class="empty">
              <div class="empty-title">No decisions yet</div>
              <div class="empty-text">Approved and rejected requests are kept here for 7 days.</div>
            </div>
          ) : (
            <div class="card">
              <table class="table">
                <thead>
                  <tr>
                    <th>Decided</th>
                    <th>Principal</th>
                    <th>Service</th>
                    <th>Tool</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((row) => (
                    <HistoryRow row={row} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {history.length > 0 ? (
            <div class="muted">
              {hasMoreHistory ? (
                <>
                  Showing last {historyLimit} decisions ·{" "}
                  <a href={paths.approvalsWith({ limit: historyLimit * 2 })}>Older →</a>
                </>
              ) : (
                <>
                  Showing {history.length} decision{history.length === 1 ? "" : "s"}
                </>
              )}
            </div>
          ) : null}
          <div class="note">History prunes with the audit trail after 7 days. Times are local.</div>
        </section>
      </div>

      <script dangerouslySetInnerHTML={{ __html: PUSH_SCRIPT }} />
    </Layout>
  );
}

export default ApprovalsPage;
