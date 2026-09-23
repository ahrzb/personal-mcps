import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ConfirmDialog, useDropSearchKeys } from "@/chrome/Confirm";
import { NoticeBanner, useFlash } from "@/chrome/Notice";
import { Page, PageHead, PageSubtitle, PageTitle } from "@/chrome/Page";
import { Shell, useDocumentTitle } from "@/chrome/Shell";
import { QueryState, Refreshing, Skeleton } from "@/chrome/States";
import { Badge, BadgeDot } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DialogFooter } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApi, useAppEnv } from "@/lib/api-context";
import { cn } from "@/lib/cn";
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
 * The port of `server/src/pages/apps.tsx`, element for element: one template serves both
 * artboards, and `max-md:hidden` / `hidden max-md:block` pick which markup shows at which
 * breakpoint, as `.wide-only`/`.narrow-only` did. Three things are genuinely different, and
 * each is the point of the rewrite rather than a liberty:
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
      <Page shape="table">
        {notice === null ? null : <NoticeBanner notice={notice} />}
        <PageHead>
          <div>
            <PageTitle>Apps</PageTitle>
            <PageSubtitle className="max-md:hidden">
              MCP apps in your namespace — tunneled bots and proxied endpoints.
            </PageSubtitle>
            <PageSubtitle className="hidden max-md:block">Tunneled bots and proxied endpoints.</PageSubtitle>
            <Refreshing active={apps.isFetching && !apps.isPending} />
          </div>
          <Link className={buttonVariants({ className: "max-md:flex-[1_1_100%]" })} to={paths.appNew}>
            <PlusIcon />
            <span>Add app</span>
          </Link>
        </PageHead>

        <QueryState
          query={apps}
          skeleton={
            <Card size="flush">
              <Skeleton rows={6} />
            </Card>
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
      </Page>
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
      {active.length > 0 ? <AppTable rows={active} now={now} /> : null}

      {archived.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Archived</h2>
          <AppTable rows={archived} now={now} />
        </section>
      )}

      <p className={`${NOTE} max-md:hidden`}>
        Deleting an app revokes its tokens and removes its grants. Archived apps keep everything and refuse
        connections.
      </p>
      <p className={`${NOTE} hidden text-center max-md:block`}>
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

/** One section's rows in their card. The header row is gone below 768px, where each row
 *  stacks into a card of its own (`components/ui/table`). */
const AppTable = ({ rows, now }: { rows: AppRow[]; now: number }): ReactNode => (
  <Card size="flush">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>App</TableHead>
          <TableHead>Kind</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Roles</TableHead>
          <TableHead>Last seen</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <AppTableRow key={row.slug} row={row} now={now} />
        ))}
      </TableBody>
    </Table>
  </Card>
);

/** legacy.css's `.note`: the 12px muted aside, capped at a readable measure. */
const NOTE = "max-w-[72ch] text-xs text-muted-foreground";

/** A row action's size in `.cell-actions`: 32px and 13px beside the row; below 768px an
 *  equal 44px share of the row's own action line. */
const ROW_ACTION = "ml-1 px-2.5 max-md:ml-0 max-md:flex-1 max-md:px-3";

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
    <TableRow className="relative cursor-pointer hover:bg-muted">
      <TableCell>
        {/* Every row IS the link to its detail page, archived rows included — the anchor's
            `after:` overlay fills the nearest positioned box, the row; the row's own actions
            are raised above it, so they still act. */}
        <div className="text-base font-medium">
          <Link className="after:absolute after:inset-0" to={paths.appDetail(row.slug)}>
            {row.name}
          </Link>
        </div>
        <div className="font-mono text-xs text-muted-foreground max-md:hidden">{row.slug}</div>
        <div className="hidden max-md:block">
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant="mono">{row.kind}</Badge>
            {badge}
          </div>
          <div className={NOTE}>{metaLine(row, now)}</div>
        </div>
      </TableCell>
      <TableCell className="max-md:hidden">
        <Badge variant="mono">{row.kind}</Badge>
      </TableCell>
      <TableCell className="max-md:hidden">{badge ?? <span className="text-muted-foreground">—</span>}</TableCell>
      <TableCell className="font-mono text-muted-foreground max-md:hidden">{rolesText(roleNames)}</TableCell>
      <TableCell className="text-muted-foreground max-md:hidden">
        {formatLastSeen(lastConnectedAt(row), now)}
      </TableCell>
      {/* Right-aligned beside the row wide; its own line under the card on a phone. `z-1`
          raises it over the row's link. */}
      <TableCell className="relative z-1 text-right whitespace-nowrap max-md:mt-2.5 max-md:flex max-md:gap-2.5 max-md:text-left">
        {/* Connect and Reconnect are the one row action that is still a form: `/apps/connect`
            answers a 303 into a third party's address bar. `contents` lets its button sit as
            a flex item of the cell beside the others, matching both artboards' row. */}
        {connect !== null && connect.action === "connect" && (
          <form method="post" action={paths.appConnect(row.slug)} className="contents">
            <input type="hidden" name="csrf" value={bootstrap.csrf} />
            <Button type="submit" variant="outline" size="sm" className={ROW_ACTION}>
              {connect.label}
            </Button>
          </form>
        )}
        {connect !== null && connect.action === "disconnect" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={ROW_ACTION}
            onClick={() => {
              disconnect.mutate(
                { slug: row.slug },
                { onError: (error) => flash("app_disconnect", error.message) },
              );
            }}
          >
            {connect.label}
          </Button>
        )}
        <Button
          type="button"
          variant={row.archived ? "outline" : "ghost"}
          size="sm"
          className={ROW_ACTION}
          onClick={() => void toggleArchive()}
        >
          {row.archived ? "Unarchive" : "Archive"}
        </Button>
        {/* Delete never mutates directly — it opens the same page with the confirm dialog,
            which is a URL and therefore shareable and previewable. */}
        <Link
          className={cn(buttonVariants({ variant: "danger-outline", size: "sm" }), ROW_ACTION)}
          to={paths.apps}
          search={{ confirm: "delete", slug: row.slug }}
        >
          Delete
        </Link>
        <span className="inline-flex items-center text-ring">
          <Chevron />
        </span>
      </TableCell>
    </TableRow>
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
  if (row.archived) return <Badge variant="warning">archived</Badge>;
  if (row.kind === "tunnel") {
    return row.status === "online" ? (
      <Badge variant="success">
        <BadgeDot />
        online
      </Badge>
    ) : (
      <Badge variant="muted">
        <BadgeDot idle />
        offline
      </Badge>
    );
  }
  if (row.auth === "oauth") {
    if (row.connection === "connected") {
      return (
        <Badge variant="success">
          <BadgeDot />
          connected
        </Badge>
      );
    }
    if (row.connection === "needs_reconnect") return <Badge variant="warning">needs reconnect</Badge>;
    return <Badge variant="muted">not connected</Badge>;
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
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" variant="danger" onClick={() => void confirm()}>
          Delete
        </Button>
      </DialogFooter>
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
  <Empty>
    <EmptyTitle>No apps yet</EmptyTitle>
    <EmptyDescription>
      Tunneled bots dial in with an app token; proxied endpoints are forwarded by the hub.
    </EmptyDescription>
    <Link className={buttonVariants({ className: "mt-4" })} to={paths.appNew}>
      <PlusIcon />
      <span>Add app</span>
    </Link>
  </Empty>
);
