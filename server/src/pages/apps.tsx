/**
 * /apps — active and archived MCP apps, per-kind status, and the
 * Connect/Reconnect/Disconnect/Archive/Delete actions of §13's app
 * management surface.
 *
 * Pure: (props) => JSX. Every URL comes from `paths`; every relative-time
 * string is computed from `now`, never from a clock of its own. Desktop
 * (Apps.dc.html) and mobile (MobileApps.dc.html) are this one
 * template — the `.wide-only`/`.narrow-only` utility classes in styles.css
 * pick which markup shows at which breakpoint, exactly as the class
 * inventory documents them.
 */

import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import { paths } from "./model";
import type { Notice, AppRow, AppsConfirm, AppsProps } from "./model";

/* ------------------------------------------------------------------ *
 * Time and copy helpers — pure functions of `now` and the row, never a
 * clock or a string built by concatenation of a `paths` URL.
 * ------------------------------------------------------------------ */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "now" / "12m ago" / "3h ago" / "Aug 20" — the Apps table's "Last seen" column. */
function formatLastSeen(lastConnectedAt: number | null, nowIso: string): string {
  if (lastConnectedAt === null) return "—";
  const diff = Date.parse(nowIso) - lastConnectedAt;
  if (diff < MINUTE) return "now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  const d = new Date(lastConnectedAt);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** The DECLARED roles, or "all" for the empty list (§'s built-in role, never stored). */
function rolesText(roleNames: string[]): string {
  return roleNames.length === 0 ? "all" : roleNames.join(", ");
}

/** The mobile card's one meta line: "slug · roles · seen …", "seen" omitted when never connected. */
function metaLine(row: AppRow, nowIso: string): string {
  const parts = [row.slug, rolesText(row.roleNames)];
  if (row.lastConnectedAt !== null) parts.push(`seen ${formatLastSeen(row.lastConnectedAt, nowIso)}`);
  return parts.join(" · ");
}

/** Dialogs.dc.html's "Delete app" copy — grammatical whether or not there are tokens to name. */
function deleteConfirmText(row: AppRow): string {
  if (row.tokenCount > 0) {
    const plural = row.tokenCount === 1 ? "" : "s";
    const verb = row.tokenCount === 1 ? "is" : "are";
    return `Its ${row.tokenCount} token${plural} ${verb} revoked, its grants removed, and its live connection closed. This cannot be undone.`;
  }
  return "Its grants are removed and its live connection closed. This cannot be undone.";
}

/* ------------------------------------------------------------------ *
 * Row-level presentation — one row shape, kind and archived state decide
 * both the status badge and which actions apply (model.ts's AppRow doc
 * comment spells the four cases this switches on).
 * ------------------------------------------------------------------ */

/** null when the row has nothing to connect (tunnel, or a headers-auth proxy). */
function statusBadge(row: AppRow) {
  if (row.archived) return <span class="badge badge--warning">archived</span>;
  if (row.kind === "tunnel") {
    return row.connection === "online" ? (
      <span class="badge badge--success">
        <span class="dot"></span>online
      </span>
    ) : (
      <span class="badge badge--muted">
        <span class="dot dot--idle"></span>offline
      </span>
    );
  }
  if (row.upstreamAuthMode === "oauth") {
    if (row.upstream === "connected") {
      return (
        <span class="badge badge--success">
          <span class="dot"></span>connected
        </span>
      );
    }
    if (row.upstream === "needs_reconnect") return <span class="badge badge--warning">needs reconnect</span>;
    return <span class="badge badge--muted">not connected</span>;
  }
  return null;
}

/** null for a tunnel row or a headers-auth proxy — nothing to Connect/Reconnect/Disconnect. */
function connectAction(row: AppRow): { label: string; href: string } | null {
  if (row.kind !== "proxy" || row.upstreamAuthMode !== "oauth") return null;
  if (row.upstream === "connected") return { label: "Disconnect", href: paths.appDisconnect(row.slug) };
  if (row.upstream === "needs_reconnect") return { label: "Reconnect", href: paths.appConnect(row.slug) };
  return { label: "Connect", href: paths.appConnect(row.slug) };
}

const TableHead: FC = () => (
  <thead>
    <tr>
      <th>App</th>
      <th class="wide-only">Kind</th>
      <th class="wide-only">Status</th>
      <th class="wide-only">Roles</th>
      <th class="wide-only">Last seen</th>
      <th></th>
    </tr>
  </thead>
);

const AppTableRow: FC<{ row: AppRow; csrfToken: string; now: string }> = ({ row, csrfToken, now }) => {
  const badge = statusBadge(row);
  const connect = row.archived ? null : connectAction(row);
  return (
    <tr>
      <td>
        <div class="cell-name">{row.name}</div>
        <div class="cell-slug wide-only">{row.slug}</div>
        <div class="narrow-only">
          <div class="badge-row">
            <span class="badge badge--mono">{row.kind}</span>
            {badge}
          </div>
          <div class="note">{metaLine(row, now)}</div>
        </div>
      </td>
      <td class="wide-only">
        <span class="badge badge--mono">{row.kind}</span>
      </td>
      <td class="wide-only">{badge ?? <span class="muted">—</span>}</td>
      <td class="wide-only muted mono">{rolesText(row.roleNames)}</td>
      <td class="wide-only muted">{formatLastSeen(row.lastConnectedAt, now)}</td>
      <td class="cell-actions">
        {/* One mutation form per row: Connect/Reconnect/Disconnect and Archive/Unarchive are
            direct, unconfirmed POSTs, so a single form with a per-button `formaction` covers
            both without duplicating the CSRF field. `.contents` lets the form's buttons sit
            as flex items of .cell-actions alongside the Delete link, matching both
            artboards' button row exactly. */}
        <form
          method="post"
          action={row.archived ? paths.appUnarchive(row.slug) : paths.appArchive(row.slug)}
          class="contents"
        >
          <input type="hidden" name="csrf" value={csrfToken} />
          {connect && (
            <button type="submit" formaction={connect.href} class="btn btn--outline btn--sm">
              {connect.label}
            </button>
          )}
          <button type="submit" class={row.archived ? "btn btn--outline btn--sm" : "btn btn--ghost btn--sm"}>
            {row.archived ? "Unarchive" : "Archive"}
          </button>
        </form>
        {/* Delete never mutates directly — it opens the same page with the confirm dialog. */}
        <a class="btn btn--danger-outline btn--sm" href={paths.appsConfirmDelete(row.slug)}>
          Delete
        </a>
      </td>
    </tr>
  );
};

/* ------------------------------------------------------------------ *
 * Page furniture: the "+" glyph, the notice banner, the empty state, and
 * the delete-confirm dialog.
 * ------------------------------------------------------------------ */

const PlusIcon: FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
    <path d="M5 12h14"></path>
    <path d="M12 5v14"></path>
  </svg>
);

/** Tone-appropriate glyph; stroke="currentColor" so it always matches the alert's own text color. */
const NoticeIcon: FC<{ tone: Notice["tone"] }> = ({ tone }) => {
  if (tone === "danger") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10"></circle>
        <path d="m15 9-6 6"></path>
        <path d="m9 9 6 6"></path>
      </svg>
    );
  }
  if (tone === "warning") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2Z"></path>
        <path d="M12 9v4"></path>
        <path d="M12 17h.01"></path>
      </svg>
    );
  }
  if (tone === "success") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10"></circle>
        <path d="m9 12 2 2 4-4"></path>
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10"></circle>
      <path d="M12 16v-4"></path>
      <path d="M12 8h.01"></path>
    </svg>
  );
};

const TONE_CLASS: Record<Notice["tone"], string> = {
  info: "alert",
  success: "alert alert--success",
  warning: "alert alert--warning",
  danger: "alert alert--danger",
};

const NoticeBanner: FC<{ notice: Notice }> = ({ notice }) => {
  const toneClass = TONE_CLASS[notice.tone];
  return (
    <div class={toneClass} role={notice.tone === "danger" ? "alert" : "status"}>
      <NoticeIcon tone={notice.tone} />
      <div>
        {notice.title ? <div class="alert-title">{notice.title}</div> : null}
        <div class="alert-text">{notice.message}</div>
      </div>
    </div>
  );
};

const EmptyApps: FC = () => (
  <div class="empty">
    <div class="empty-title">No apps yet</div>
    <div class="empty-text">Tunneled bots dial in with an app token; proxied endpoints are forwarded by the hub.</div>
    <a class="btn btn--primary" href={paths.appNew}>
      <PlusIcon />
      <span>Add app</span>
    </a>
  </div>
);

const DeleteConfirmDialog: FC<{ confirm: AppsConfirm; csrfToken: string }> = ({ confirm, csrfToken }) => (
  <>
    <dialog id="confirm-delete" open aria-labelledby="confirm-delete-title">
      <div class="dialog-body">
        <div>
          <div class="dialog-title" id="confirm-delete-title">
            Delete {confirm.row.name}?
          </div>
          <div class="dialog-text">{deleteConfirmText(confirm.row)}</div>
        </div>
        <div class="actions">
          <a class="btn btn--ghost" href={paths.apps}>
            Cancel
          </a>
          <form method="post" action={paths.appDelete(confirm.row.slug)}>
            <input type="hidden" name="csrf" value={csrfToken} />
            <button type="submit" class="btn btn--danger">
              Delete
            </button>
          </form>
        </div>
      </div>
    </dialog>
    {/* Progressive enhancement only: the `open` attribute above is the whole story with
        scripting off. Where JS runs, re-open as a real modal so it gets centered and
        styles.css's `dialog::backdrop` — otherwise unreachable from a plain `open`
        attribute, which never produces a backdrop — actually applies. */}
    <script
      dangerouslySetInnerHTML={{
        __html:
          'var d=document.getElementById("confirm-delete");if(d&&d.open){d.removeAttribute("open");d.showModal();}',
      }}
    />
  </>
);

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export const AppsPage: FC<AppsProps> = ({
  now,
  username,
  pendingApprovals,
  notice,
  csrfToken,
  active,
  archived,
  confirm,
}) => {
  const nothingAtAll = active.length === 0 && archived.length === 0;

  return (
    <Layout title="Apps" active="apps" username={username} pendingApprovals={pendingApprovals}>
      <div class="page">
        {notice && <NoticeBanner notice={notice} />}

        <div class="page-head">
          <div>
            <h1 class="page-title">Apps</h1>
            <p class="page-subtitle wide-only">MCP apps in your namespace — tunneled bots and proxied endpoints.</p>
            <p class="page-subtitle narrow-only">Tunneled bots and proxied endpoints.</p>
          </div>
          <a class="btn btn--primary" href={paths.appNew}>
            <PlusIcon />
            <span>Add app</span>
          </a>
        </div>

        {active.length > 0 ? (
          <div class="card">
            <table class="table">
              <TableHead />
              <tbody>
                {active.map((row) => (
                  <AppTableRow row={row} csrfToken={csrfToken} now={now} />
                ))}
              </tbody>
            </table>
          </div>
        ) : archived.length === 0 ? (
          <EmptyApps />
        ) : null}

        {archived.length > 0 && (
          <section class="section">
            <h2 class="section-title">Archived</h2>
            <div class="card">
              <table class="table">
                <TableHead />
                <tbody>
                  {archived.map((row) => (
                    <AppTableRow row={row} csrfToken={csrfToken} now={now} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {!nothingAtAll && (
          <>
            <p class="note wide-only">
              Deleting an app revokes its tokens and removes its grants. Archived apps keep everything and refuse
              connections.
            </p>
            <p class="note narrow-only center">Deleting revokes tokens and removes grants. Archived apps keep everything.</p>
          </>
        )}
      </div>

      {confirm && confirm.kind === "delete-app" && <DeleteConfirmDialog confirm={confirm} csrfToken={csrfToken} />}
    </Layout>
  );
};
