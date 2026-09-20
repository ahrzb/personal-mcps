import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ConfirmDialog, useDropSearchKeys } from "@/chrome/Confirm";
import { NoticeBanner, useFlash } from "@/chrome/Notice";
import { Shell, useDocumentTitle } from "@/chrome/Shell";
import { QueryState, Refreshing, Skeleton } from "@/chrome/States";
import { useApi, useAppEnv } from "@/lib/api-context";
import { formatLastSeen } from "@/lib/format";
import { paths } from "@/lib/paths";
import { appsQuery, keys, tokensQuery, useOp } from "@/lib/queries";
import type { AppRow, AppsResponse } from "@/lib/types";
import {
  connectAction,
  deleteConfirmText,
  lastConnectedAt,
  listedApps,
  liveTokenCounts,
  metaLine,
  roleNamesOf,
  rolesText,
  searchOne,
} from "./derive";
import type { SearchBag } from "./derive";

/**
 * `/apps` — active and archived apps, per-kind status, and the
 * Connect/Reconnect/Disconnect/Archive/Delete row actions of §13's app management surface.
 *
 * The port of `server/src/pages/apps.tsx`, element for element and class for class: one
 * template serves both artboards, and `.wide-only`/`.narrow-only` still pick which markup
 * shows at which breakpoint. Three things are genuinely different, and each is the point of
 * the rewrite rather than a liberty:
 *
 *   - the rows come from a query, so the page draws a skeleton, a failure and a quiet
 *     refresh indicator the server-rendered page had no way to have;
 *   - Archive, Unarchive and Delete are OPTIMISTIC — the next state of a boolean on a row
 *     in hand, and of a row's absence, is fully known here, and a refusal rolls the list
 *     back and says so through the same flash the redirect-back used to carry;
 *   - Connect and Reconnect stay a real form POST, because `/apps/connect` answers a 303 to
 *     a third-party authorize URL and `fetch` cannot follow that into the address bar.
 */
export function AppsPage(): ReactNode {
  useDocumentTitle("Apps");
  const api = useApi();
  const search = useSearch({ strict: false }) as SearchBag;
  const notice = useFlash(search);
  const apps = useQuery(appsQuery(api));
  const tokens = useQuery(tokensQuery(api));
  // The render instant, read once so every row's "Last seen" is relative to one clock —
  // and so the preview gallery's frozen `Date.now` reaches all of them.
  const now = Date.now();

  return (
    <Shell active="apps">
      <main className="page--table">
        {notice === null ? null : <NoticeBanner notice={notice} />}
        <div className="page-head">
          <div>
            <h1 className="page-title">Apps</h1>
            <p className="page-subtitle wide-only">
              MCP apps in your namespace — tunneled bots and proxied endpoints.
            </p>
            <p className="page-subtitle narrow-only">Tunneled bots and proxied endpoints.</p>
            <Refreshing active={apps.isFetching && !apps.isPending} />
          </div>
          <Link className="btn btn--primary" to={paths.appNew}>
            <PlusIcon />
            <span>Add app</span>
          </Link>
        </div>

        <QueryState
          query={apps}
          skeleton={
            <div className="card">
              <Skeleton rows={6} />
            </div>
          }
          empty={{ when: (data) => listedApps(data.apps).length === 0, render: <EmptyApps /> }}
        >
          {(data: AppsResponse) => (
            /* A token read that has not landed yet would leave every count at zero, which
               reads as the dialog's no-token sentence — so `countsKnown` is what the dialog
               waits for rather than promising a count nobody has. */
            <Board
              rows={listedApps(data.apps)}
              counts={liveTokenCounts(tokens.data?.tokens ?? [], now)}
              countsKnown={!tokens.isPending}
              now={now}
              search={search}
            />
          )}
        </QueryState>
      </main>
    </Shell>
  );
}

/**
 * The two sections, their footnote, and the one destructive dialog — everything that needs
 * the rows in hand.
 *
 * `active` and `archived` are two sections because they are two sections with different
 * actions, not one list with a flag; `archived` is still on every row, so the dialog can
 * draw a row outside its own section.
 */
function Board({
  rows,
  counts,
  countsKnown,
  now,
  search,
}: {
  rows: AppRow[];
  /** App slug → its live token count, for the delete dialog's sentence. */
  counts: Map<string, number>;
  /** Whether the token read has settled. False means the counts are not yet a fact. */
  countsKnown: boolean;
  /** The render instant, epoch ms. */
  now: number;
  search: SearchBag;
}): ReactNode {
  const drop = useDropSearchKeys();
  const active = rows.filter((row) => !row.archived);
  const archived = rows.filter((row) => row.archived);
  // `?confirm=delete&slug=` validated against the rows actually held, exactly as the loader
  // validated it: a confirm naming no row of this owner's opens nothing at all.
  const confirmSlug = searchOne(search, "confirm") === "delete" ? searchOne(search, "slug") : null;
  const confirmed = rows.find((row) => row.slug === confirmSlug);

  return (
    <>
      {active.length > 0 ? (
        <div className="card">
          <table className="table">
            <TableHead />
            <tbody>
              {active.map((row) => (
                <AppTableRow key={row.slug} row={row} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {archived.length > 0 && (
        <section className="section">
          <h2 className="section-title">Archived</h2>
          <div className="card">
            <table className="table">
              <TableHead />
              <tbody>
                {archived.map((row) => (
                  <AppTableRow key={row.slug} row={row} now={now} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <p className="note wide-only">
        Deleting an app revokes its tokens and removes its grants. Archived apps keep everything and refuse
        connections.
      </p>
      <p className="note narrow-only center">
        Deleting revokes tokens and removes grants. Archived apps keep everything.
      </p>

      {confirmed !== undefined && countsKnown && (
        <DeleteConfirmDialog
          row={confirmed}
          tokenCount={counts.get(confirmed.slug) ?? 0}
          onClose={() => drop(["confirm", "slug"])}
        />
      )}
    </>
  );
}

const TableHead = (): ReactNode => (
  <thead>
    <tr>
      <th>App</th>
      <th className="wide-only">Kind</th>
      <th className="wide-only">Status</th>
      <th className="wide-only">Roles</th>
      <th className="wide-only">Last seen</th>
      <th></th>
    </tr>
  </thead>
);

/**
 * One row: the name as the row-wide link, the kind, the status badge, the declared roles,
 * the last-seen stamp, and the actions that apply to this kind and this archived state.
 *
 * The ops are hooked HERE rather than on the page so each one carries its own row's slug as
 * the invalidation subject — `app_archive` touches `['apps']` and `['app', slug]`, and a
 * single page-level hook would have no slug to name.
 */
function AppTableRow({ row, now }: { row: AppRow; now: number }): ReactNode {
  const { bootstrap } = useAppEnv();
  const optimistically = useOptimisticApps();
  const flash = useRefusalFlash();
  const archive = useOp<{ slug: string }>("app_archive", { app: row.slug });
  const unarchive = useOp<{ slug: string }>("app_unarchive", { app: row.slug });
  const disconnect = useOp<{ slug: string }>("app_disconnect", { app: row.slug });

  const badge = statusBadge(row);
  const connect = row.archived ? null : connectAction(row);
  const roleNames = roleNamesOf(row);

  /**
   * Archive and Unarchive, optimistically.
   *
   * `mutateAsync` and a `catch` rather than the per-call `onError`: an optimistic archive
   * moves the row to the other section, which unmounts THIS component — and a per-call
   * callback belongs to the observer that just went away, while the promise settles either
   * way. The rollback has to outlive the row it acts on.
   */
  const toggleArchive = async (): Promise<void> => {
    const next = !row.archived;
    const rollback = optimistically((apps) =>
      apps.map((app) => (app.slug === row.slug ? { ...app, archived: next } : app)),
    );
    try {
      await (next ? archive : unarchive).mutateAsync({ slug: row.slug });
    } catch (error) {
      rollback();
      flash(next ? "app_archive" : "app_unarchive", error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <tr className="app-row">
      <td>
        {/* Every row IS the link to its detail page, archived rows included — the anchor
            stretched over the row by styles.css; the row's own actions sit above it in the
            stacking order, so they still act. */}
        <div className="cell-name">
          <Link className="row-link" to={paths.appDetail(row.slug)}>
            {row.name}
          </Link>
        </div>
        <div className="cell-slug wide-only">{row.slug}</div>
        <div className="narrow-only">
          <div className="badge-row">
            <span className="badge badge--mono">{row.kind}</span>
            {badge}
          </div>
          <div className="note">{metaLine(row, now)}</div>
        </div>
      </td>
      <td className="wide-only">
        <span className="badge badge--mono">{row.kind}</span>
      </td>
      <td className="wide-only">{badge ?? <span className="muted">—</span>}</td>
      <td className="wide-only muted mono">{rolesText(roleNames)}</td>
      <td className="wide-only muted">{formatLastSeen(lastConnectedAt(row), now)}</td>
      <td className="cell-actions">
        {/* Connect and Reconnect are the one row action that is still a form: `/apps/connect`
            answers a 303 into a third party's address bar. `.contents` lets its button sit as
            a flex item of .cell-actions beside the others, matching both artboards' row. */}
        {connect !== null && connect.action === "connect" && (
          <form method="post" action={paths.appConnect(row.slug)} className="contents">
            <input type="hidden" name="csrf" value={bootstrap.csrf} />
            <button type="submit" className="btn btn--outline btn--sm">
              {connect.label}
            </button>
          </form>
        )}
        {connect !== null && connect.action === "disconnect" && (
          <button
            type="button"
            className="btn btn--outline btn--sm"
            onClick={() => {
              disconnect.mutate(
                { slug: row.slug },
                { onError: (error) => flash("app_disconnect", error.message) },
              );
            }}
          >
            {connect.label}
          </button>
        )}
        <button
          type="button"
          className={row.archived ? "btn btn--outline btn--sm" : "btn btn--ghost btn--sm"}
          onClick={() => void toggleArchive()}
        >
          {row.archived ? "Unarchive" : "Archive"}
        </button>
        {/* Delete never mutates directly — it opens the same page with the confirm dialog,
            which is a URL and therefore shareable and previewable. */}
        <Link
          className="btn btn--danger-outline btn--sm"
          to={paths.apps}
          search={{ confirm: "delete", slug: row.slug }}
        >
          Delete
        </Link>
        <span className="row-chevron">
          <Chevron />
        </span>
      </td>
    </tr>
  );
}

/**
 * The row's status badge, or null where the row has none to state: archived first, then the
 * tunnel's live socket, then the upstream credential's state. A headers-auth proxy has
 * nothing to connect, so it answers null and the Status cell reads the dash — which is a
 * different statement from an empty badge.
 *
 * A value rather than a component because both artboards draw the SAME badge twice, once in
 * the narrow badge row and once in the Status column, and two renders of one fact are what
 * this avoids.
 */
function statusBadge(row: AppRow): ReactNode {
  if (row.archived) return <span className="badge badge--warning">archived</span>;
  if (row.kind === "tunnel") {
    return row.status === "online" ? (
      <span className="badge badge--success">
        <span className="dot"></span>online
      </span>
    ) : (
      <span className="badge badge--muted">
        <span className="dot dot--idle"></span>offline
      </span>
    );
  }
  if (row.auth === "oauth") {
    if (row.connection === "connected") {
      return (
        <span className="badge badge--success">
          <span className="dot"></span>connected
        </span>
      );
    }
    if (row.connection === "needs_reconnect") return <span className="badge badge--warning">needs reconnect</span>;
    return <span className="badge badge--muted">not connected</span>;
  }
  return null;
}

/** §13's Delete app confirmation. The removal is optimistic: the row leaves the list as the
 *  dialog closes, and a refusal puts it back and says why through the page's flash. */
function DeleteConfirmDialog({
  row,
  tokenCount,
  onClose,
}: {
  row: AppRow;
  /** Live tokens bound to this app — the number the copy names. */
  tokenCount: number;
  onClose: () => void;
}): ReactNode {
  const optimistically = useOptimisticApps();
  const flash = useRefusalFlash();
  const remove = useOp<{ slug: string }>("app_delete", { app: row.slug });

  /* `mutateAsync` and a `catch`, for `toggleArchive`'s reason and more sharply: closing the
   * dialog unmounts this component before the answer lands, and the rollback has to outlive
   * it. The promise settles regardless of who is still listening. */
  const confirm = async (): Promise<void> => {
    const rollback = optimistically((apps) => apps.filter((app) => app.slug !== row.slug));
    onClose();
    try {
      await remove.mutateAsync({ slug: row.slug });
    } catch (error) {
      rollback();
      flash("app_delete", error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <ConfirmDialog title={`Delete ${row.name}?`} text={deleteConfirmText(tokenCount)} onClose={onClose}>
      <div className="actions">
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn--danger" onClick={() => void confirm()}>
          Delete
        </button>
      </div>
    </ConfirmDialog>
  );
}

/**
 * Applies a change to the held `['apps']` list and answers with its rollback.
 *
 * This is the whole of the optimism on this page, and it is deliberately narrow: archive,
 * unarchive and delete are the three writes whose next state is fully known from a row
 * already on screen, so showing it immediately cannot be wrong in a way the rollback does
 * not undo. Every other write here awaits the server, because its answer carries something
 * the client cannot predict.
 *
 * In-flight refetches are cancelled first, so an answer already on the wire cannot land on
 * top of the optimistic list and undo it.
 */
function useOptimisticApps(): (next: (apps: AppRow[]) => AppRow[]) => () => void {
  const client = useQueryClient();
  return (next) => {
    void client.cancelQueries({ queryKey: keys.apps() });
    const held = client.getQueryData<AppsResponse>(keys.apps());
    if (held === undefined) return () => undefined;
    client.setQueryData<AppsResponse>(keys.apps(), { apps: next(held.apps) });
    return () => client.setQueryData<AppsResponse>(keys.apps(), held);
  };
}

/**
 * A refused OPTIMISTIC write as the page's own flash — the same two search keys the server's
 * redirect-back wrote, so `chrome/Notice`'s `useFlash` reads it, `NoticeBanner` draws it at
 * the top of this `<main>`, and the keys are stripped once shown. A refusal therefore reads
 * identically whichever rendering produced it.
 *
 * Replacing rather than pushing: a rolled-back change is not a place Back should return to.
 */
function useRefusalFlash(): (op: string, reason: string) => void {
  const navigate = useNavigate();
  return (op, reason) => {
    void navigate({ to: paths.apps, search: { failed: op, reason }, replace: true });
  };
}

/** The chevron at the row's end — decoration for where the row goes; the anchor is the thing
 *  that goes there, so this is hidden from anyone listing the page's links. */
const Chevron = (): ReactNode => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m9 6 6 6-6 6" />
  </svg>
);

const PlusIcon = (): ReactNode => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M5 12h14"></path>
    <path d="M12 5v14"></path>
  </svg>
);

/** A fresh namespace (EmptyStates "Apps — empty"): the two kinds named, and the one control
 *  that does anything about it. */
const EmptyApps = (): ReactNode => (
  <div className="empty">
    <div className="empty-title">No apps yet</div>
    <div className="empty-text">
      Tunneled bots dial in with an app token; proxied endpoints are forwarded by the hub.
    </div>
    <Link className="btn btn--primary" to={paths.appNew}>
      <PlusIcon />
      <span>Add app</span>
    </Link>
  </div>
);
