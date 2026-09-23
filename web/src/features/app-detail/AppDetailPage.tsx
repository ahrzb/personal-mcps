/**
 * `/apps/<slug>/<pane>` — one app as seven panes behind a rail.
 *
 * A port of `server/src/pages/app-detail.tsx` plus its props builder
 * (`pages/model.ts:appDetailProps`), and the ONE page in this client that owns more than its
 * own body: it holds all nine reads, because §13 makes the rail and the pane one page. The
 * rail's markers and the header's totals are drawn on every pane from the same four catalog
 * answers the Catalog pane lists, so a marker cannot disagree with the listing beside it —
 * which is the property the server-rendered page had by making one read pass, and which a
 * per-pane query would have quietly dropped.
 *
 * What the SSR page blocked its document on, this page no longer blocks anything on: the
 * four catalog reads are live upstream listings, each one now a query of its own with its
 * own five states. An app's Token pane renders immediately and issues no catalog request at
 * all; the Catalog pane's unread family says so in place rather than stalling the page.
 *
 * Every pane is a plain component taking `AppPaneProps`. Three of them live in sibling files
 * owned elsewhere (`RolesPane`, `RecordingPane`, `AccessPane`); they are imported by name
 * and take the same record.
 */

import { Link, useNavigate, useParams, useRouterState, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { ConfirmDialog, useDropSearchKeys } from "@/chrome/Confirm";
import { Kv, KvList } from "@/chrome/Kv";
import { Tiles } from "@/chrome/Listing";
import { Crumb, CrumbSep, Page, PageHead, PageSubtitle, PageTitle, Pane, TitleRow, Workspace } from "@/chrome/Page";
import { LevelHeader, PaneRail, paneGroups } from "@/chrome/Panes";
import type { PaneEntry, PaneMarker } from "@/chrome/Panes";
import { Shell, useDocumentTitle } from "@/chrome/Shell";
import { Skeleton } from "@/chrome/States";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DialogFooter } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { useAppEnv } from "@/lib/api-context";
import { formatLastSeen } from "@/lib/format";
import { ApiError } from "@/lib/http";
import { NoticeBanner, useFlash } from "@/chrome/Notice";
import type { Notice } from "@/lib/notice";
import { APP_PANES, APP_PANE_TABLE, DIMMED, paths } from "@/lib/paths";
import type { AppPane } from "@/lib/paths";
import {
  appCapabilitiesQuery,
  appCatalogQuery,
  appQuery,
  appRolesQuery,
  agentsQuery,
  keys,
  tokensQuery,
  useOp,
} from "@/lib/queries";
import type { AppRow, CatalogFamily, CatalogResponse, TokenInfo } from "@/lib/types";
import {
  CAPABILITY_OF_FAMILY,
  FAMILY_GROUPS,
  grantsOn,
  joinFamilies,
  countOf,
  familyMarker,
  liveAppTokens,
  liveTokenId,
  searchValue,
  searchValues,
  subjectsOf,
  tilesLine,
} from "./derive";
import type { AppPaneProps, FamilyView } from "./derive";
import { CatalogPane } from "./panes/CatalogPane";
import { OverviewPane } from "./panes/OverviewPane";
import { TokenPane } from "./panes/TokenPane";
import { DangerPane } from "./panes/DangerPane";
import { RolesPane } from "./panes/RolesPane";
import { RecordingPane } from "./panes/RecordingPane";
import { AccessPane } from "./panes/AccessPane";

/** The accessible name of this page's pane navigation — the rail, which below the split
 *  breakpoint is the landing level's list (§2's three levels). */
const RAIL_NAV_LABEL = "App panes";

/** No pill row on this page, deliberately: `/settings` is the only paned page that renders
 *  one, and neither app-detail nor agent-detail ever did. Here the phone's pane navigation
 *  is the RAIL at narrow level 1 (`chrome/Panes`' rail at `[data-level="1"]`) — which is why
 *  the bare `/apps/<slug>` URL has to keep existing. */

/** A status word's palette: green for the two live states, amber for the two that are
 *  waiting on the owner, muted for the rest. */
const STATUS_TONE: Record<string, "success" | "warning"> = {
  online: "success",
  connected: "success",
  "needs reconnect": "warning",
  archived: "warning",
};

/** Which pane each `?confirm=` belongs to (`model.ts:APP_CONFIRM_PANE`). A dialog rides the
 *  pane that draws its control, so the same key carried to another pane's URL opens nothing.
 *  `remove-agent` is in the table because the rule is the table's, but it is rendered by
 *  `AccessPane`, which owns the grant mutation it submits. */
const CONFIRM_PANE: Record<string, AppPane> = {
  "revoke-token": "token",
  "remove-agent": "access",
  archive: "danger",
  delete: "danger",
};

export function AppDetailPage(): ReactNode {
  const { api, bootstrap } = useAppEnv();
  const params = useParams({ strict: false }) as { slug?: string; pane?: string };
  const slug = params.slug ?? "";
  const pane = paneOf(params.pane);
  const search = useSearch({ strict: false }) as Record<string, string | string[] | undefined>;
  const location = useRouterState({ select: (state) => state.location });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const drop = useDropSearchKeys();

  const app = useQuery(appQuery(api, slug));
  const capabilities = useQuery(appCapabilitiesQuery(api, slug));
  const roles = useQuery(appRolesQuery(api, slug));
  const agents = useQuery(agentsQuery(api));
  const tokens = useQuery(tokensQuery(api));

  // The four family reads, at PAGE level and gated on the family-state rule: an app that
  // has never connected has no catalog at all, and a family it does not advertise has none
  // either — so neither issues a request, and the rail says which of the two it is rather
  // than drawing a zero for both.
  const advertised = capabilities.data;
  const families = {
    tools: useQuery({ ...appCatalogQuery(api, slug, "tools"), enabled: asks(advertised, "tools") }),
    prompts: useQuery({ ...appCatalogQuery(api, slug, "prompts"), enabled: asks(advertised, "prompts") }),
    resources: useQuery({ ...appCatalogQuery(api, slug, "resources"), enabled: asks(advertised, "resources") }),
    resourceTemplates: useQuery({
      ...appCatalogQuery(api, slug, "resourceTemplates"),
      enabled: asks(advertised, "resourceTemplates"),
    }),
  };

  // A tools listing IS §23.6's discovery boundary: it can commit a TypeScript name, and the
  // surfaces that print one (Overview, the Catalog rows) read it off the app ROW. So a
  // response that reports a moved name invalidates that row and nothing else.
  //
  // `exact` is required rather than tidy: `keys.app(slug)` is a PREFIX of the catalog keys,
  // so a prefix match would invalidate the tools query that just answered and loop forever.
  const toolsUpdatedAt = families.tools.dataUpdatedAt;
  const namesChanged = families.tools.data?.namesChanged;
  useEffect(() => {
    if (namesChanged !== true) return;
    void queryClient.invalidateQueries({ queryKey: keys.app(slug), exact: true });
  }, [toolsUpdatedAt, namesChanged, queryClient, slug]);

  const notice = useFlash(search);
  const row = app.data?.app ?? null;
  useDocumentTitle(row === null ? "Apps · personal-mcps" : `${row.name} · Apps · personal-mcps`);

  if (app.isError && app.error instanceof ApiError && app.error.status === 404) {
    return (
      <Shell active="apps">
        <NotFound notice={notice} />
      </Shell>
    );
  }
  if (row === null || app.data === undefined) {
    return (
      <Shell active="apps">
        <Page shape="workspace">
          {notice === null ? null : <NoticeBanner notice={notice} />}
          <Skeleton rows={8} />
        </Page>
      </Shell>
    );
  }

  const kind = app.data.kind;
  const now = Date.now();
  const views: Record<"tools" | "prompts" | "resources", FamilyView> = {
    tools: viewOf(families.tools, advertised, "tools"),
    prompts: viewOf(families.prompts, advertised, "prompts"),
    // §3: resources and templates are ONE keyspace, a template named by its raw
    // `uriTemplate`, so the two reads become one view here and every matcher below asks
    // about one family.
    resources: joinFamilies(
      viewOf(families.resources, advertised, "resources"),
      viewOf(families.resourceTemplates, advertised, "resourceTemplates"),
    ),
  };
  const refreshing = Object.values(families).some((query) => query.isFetching && !query.isPending);

  const granted = grantsOn(slug, agents.data?.agents ?? []);
  const live = liveAppTokens(tokens.data?.tokens ?? [], slug, now);
  // Which key the live socket presented is not stored, so it is derived: when the app is
  // online, the most recently used live key is the one that opened it.
  const holdingSocket = liveTokenId(live, kind === "tunnel" && row.status === "online" && !row.archived);

  const paneProps: AppPaneProps = {
    slug,
    app: row,
    kind,
    capabilities: advertised ?? null,
    views,
    refreshing,
    roles: roles.data ?? null,
    agents: agents.data?.agents ?? [],
    tokens: live,
    now,
    diagnostics: app.data.diagnostics,
  };

  const entries = railEntries({
    slug,
    current: pane,
    proxied: kind === "proxy",
    logBodies: row.logBodies,
    catalog: familyMarker(views.tools, views.prompts, views.resources),
    roleCount: roles.data === undefined ? null : Object.keys(roles.data.effective).length,
    agentCount: agents.data === undefined ? null : granted.agents.length,
    tokenCount: tokens.data === undefined ? null : live.length,
  });

  const label = APP_PANE_TABLE.find((entry) => entry.pane === pane)?.label ?? pane;
  const picked = selectedRow({ pane, search, views, paneProps, granted: granted.agents, live });
  const level = levelOf(location.pathname === paths.appDetail(slug), picked);
  const header =
    level === 1
      ? { backHref: paths.apps, backLabel: "Apps", title: row.name }
      : level === 2
        ? { backHref: paths.appDetail(slug), backLabel: row.name, title: label }
        : { backHref: paneHref(slug, pane, search), backLabel: label, title: picked ?? label };

  const lastSeen = kind === "tunnel" ? formatLastSeen(row.lastSeen ?? null, now) : null;
  const tiles = tilesLine(
    row,
    { tools: countOf(views.tools), prompts: countOf(views.prompts), resources: countOf(views.resources) },
    granted.agents.length,
    lastSeen,
  );
  const status = statusWord(row, kind);

  return (
    <Shell active="apps">
      {/* `level` is read by the narrow layout ALONE: it shows one of the rail, the listing
          and the details by it, and the wide one never looks. */}
      <Page shape="workspace" level={level}>
        <LevelHeader header={header} />

        <PageHead>
          <div>
            {/* ONE row: where the page sits, what it is, and what it is called. */}
            <TitleRow>
              <Crumb render={<Link to={paths.apps} />}>Apps</Crumb>
              <CrumbSep />
              <PageTitle>{row.name}</PageTitle>
              <div className="flex flex-wrap items-center gap-1">
                <Badge variant="mono" size="title">
                  {slug}
                </Badge>
                <Badge variant="mono" size="title">
                  {kind}
                </Badge>
                {status === null ? null : (
                  <Badge variant={STATUS_TONE[status] ?? "muted"} size="title">
                    {status}
                  </Badge>
                )}
              </div>
            </TitleRow>
            {row.description === "" ? null : <PageSubtitle>{row.description}</PageSubtitle>}
          </div>
          {/* ONE line, the parts separated by the hub's own middot — five tiles side by side
              would read as five independent facts rather than one partition. */}
          <Tiles>{tiles}</Tiles>
        </PageHead>

        {/* §13's archived banner, on every pane rather than on the danger zone alone: an
            archived app's page stays reachable and everything on it is still listed, so the
            one thing a reader needs on any of them is why nothing connects. */}
        {row.archived ? (
          <Alert variant="warning" role="status">
            <AlertDescription>
              Archived apps refuse connections; everything is kept — tokens, grants and audit history.
            </AlertDescription>
          </Alert>
        ) : null}

        {/* The flash sits where the server-rendered page drew it: after the archived banner
            and before the upstream card, NOT as `<main>`'s first child. On this page the
            first child is the level header, which is full-bleed and negates the page's own
            top padding — a banner above it would be a different screen. */}
        {notice === null ? null : <NoticeBanner notice={notice} />}

        {/* The proxied header card sits ABOVE the framed box on every pane except Overview,
            which prints those same three facts as its own first rows (§2). */}
        {kind === "proxy" ? <UpstreamCard row={row} slug={slug} rows={pane !== "overview"} csrf={bootstrap.csrf} /> : null}

        {/* The rail and the panes are ONE framed box here as they are on the agent page, so
            the paned pages read as one family. */}
        <Workspace>
          <PaneRail label={RAIL_NAV_LABEL} groups={paneGroups(entries)} />
          <Pane split>
            <PaneBody pane={pane} props={paneProps} />
          </Pane>
        </Workspace>
      </Page>
      <AppConfirm
        pane={pane}
        slug={slug}
        search={search}
        tokens={live}
        holdingSocket={holdingSocket}
        onDone={() => navigate({ to: paths.apps })}
        onClose={() => drop(["confirm", "id"])}
      />
    </Shell>
  );
}

/** Whichever pane the URL asked for. A segment outside the seven never reaches here — the
 *  Worker 404s the document and the router redirects a client navigation — so this is a
 *  narrow, not a validation. */
function paneOf(segment: string | undefined): AppPane {
  return (APP_PANES as readonly string[]).includes(segment ?? "") ? (segment as AppPane) : "catalog";
}

/**
 * Whether a family is worth asking for. `undefined` while the capability read is in flight,
 * so the catalog request waits for the answer that says whether it is even declared rather
 * than racing it.
 */
function asks(
  advertised: { capabilities: string[]; neverConnected: boolean } | undefined,
  family: CatalogFamily,
): boolean {
  if (advertised === undefined || advertised.neverConnected) return false;
  return advertised.capabilities.includes(CAPABILITY_OF_FAMILY[family]);
}

/**
 * One catalog query as a `FamilyView` — the client-side half of the family-state rule, which
 * the server does not report because it is a reading of two other answers.
 *
 * Every read failure collapses to `unread`, the 503 arm included: the API answers `unread`
 * for a refused or unanswered listing, and a transport failure is the same fact about the
 * same family — nothing is known about it, which is not the same as it being empty.
 */
function viewOf(
  query: UseQueryResult<CatalogResponse>,
  advertised: { capabilities: string[]; neverConnected: boolean } | undefined,
  family: CatalogFamily,
): FamilyView {
  if (advertised === undefined) return { state: "pending" };
  if (advertised.neverConnected) return { state: "unconnected" };
  if (!advertised.capabilities.includes(CAPABILITY_OF_FAMILY[family])) return { state: "undeclared" };
  if (query.isError) return { state: "unread" };
  if (query.data === undefined) return { state: "pending" };
  return { state: "listed", items: query.data.items, derived: query.data.derived };
}

/** The status WORD §8's row already reports — a tunnel's `status`, a proxied oauth app's
 *  `connection` — said in words rather than in the op's snake case, so the page names no
 *  state of its own. */
function statusWord(row: AppRow, kind: "tunnel" | "proxy"): string | null {
  if (row.archived) return "archived";
  if (kind === "tunnel") return row.status ?? null;
  return row.auth === "oauth" ? (row.connection ?? "not_connected").replace(/_/g, " ") : null;
}

/* ---------------------------------------------------------------- the rail --- */

/**
 * §2's rail table as entries, with the marker each one earns.
 *
 * A count that is not read yet is the EMPTY marker rather than a zero, for the same reason
 * an unread catalog family is: a zero is a fact, and there is no fact yet. `null` on the
 * three counts means exactly that.
 */
function railEntries(at: {
  slug: string;
  current: AppPane;
  proxied: boolean;
  logBodies: boolean;
  catalog: string;
  roleCount: number | null;
  agentCount: number | null;
  tokenCount: number | null;
}): PaneEntry[] {
  const marker: Record<AppPane, string> = {
    catalog: at.catalog,
    roles: at.roleCount === null ? "" : at.roleCount === 0 ? "none" : String(at.roleCount),
    recording: at.logBodies ? "on" : "off",
    overview: "",
    access: at.agentCount === null ? "" : String(at.agentCount),
    // §2's reason, not a missing feature: nothing dials in to a proxied app, so it has no
    // token to hold and its entry dims like a family it does not advertise.
    token: at.proxied ? DIMMED : at.tokenCount === null ? "" : String(at.tokenCount),
    danger: "",
  };
  return APP_PANE_TABLE.map((entry) => ({
    href: paths.appPane(at.slug, entry.pane),
    label: entry.label,
    short: entry.label,
    marker: markerOf(marker[entry.pane], entry.pane === "recording" ? (at.logBodies ? "on" : "off") : null),
    current: entry.pane === at.current,
    group: entry.group,
  }));
}

/** A marker string as the rail draws it: the recording switch is a STATUS and carries the
 *  dot, the em dash recedes its whole entry, and the empty string is no marker element at
 *  all — which is what makes its absence readable. */
function markerOf(text: string, dot: "on" | "off" | null): PaneMarker {
  if (dot !== null) return { text, dot };
  if (text === "") return null;
  return { text, dim: text === DIMMED };
}

/* --------------------------------------------------------------- the levels --- */

/**
 * §2's three narrow levels, from the URL alone: the landing is 1, a pane 2, a pane with a
 * `sel` that names a real row 3. The level is the URL's, never the viewport's — CSS decides
 * whether it matters, so one render serves both widths and a bookmark keeps its level.
 *
 * The landing is the bare `/apps/<slug>`, which is level 1 because the Catalog has a URL of
 * its own to be level 2 at. The router currently answers that URL with a redirect to the
 * Catalog pane — one URL per screen — so this arm is the rule rather than a screen anyone
 * reaches today, and the pill row is what gives the phone its way between panes.
 */
function levelOf(landing: boolean, picked: string | null): 1 | 2 | 3 {
  if (landing) return 1;
  return picked === null ? 2 : 3;
}

/**
 * The row `?sel=` picked, as the level header names it — validated against the rows the page
 * is HOLDING, exactly as the loader validated it, so a `sel` naming nothing falls back to
 * the pane rather than titling the screen after a guess.
 *
 * The three wide panes have no level 3 at all: they draw the listing alone, so there is
 * nothing for a selection to reveal.
 */
function selectedRow(at: {
  pane: AppPane;
  search: Record<string, string | string[] | undefined>;
  views: Record<"tools" | "prompts" | "resources", FamilyView>;
  paneProps: AppPaneProps;
  granted: { slug: string }[];
  live: TokenInfo[];
}): string | null {
  const sel = searchValue(at.search, "sel");
  if (sel === "") return null;
  if (at.pane === "overview" || at.pane === "danger") return null;
  if (at.pane === "token" && at.paneProps.kind === "proxy") return null;
  const cut = sel.indexOf(":");
  if (cut < 0) return null;
  const one = sel.slice(0, cut);
  const name = sel.slice(cut + 1);
  if (at.pane === "catalog") {
    const group = FAMILY_GROUPS.find((entry) => entry.one === one);
    if (group === undefined) return null;
    return subjectsOf(at.views[group.family]).includes(name) ? name : null;
  }
  if (at.pane === "roles") {
    if (one !== "role") return null;
    const declared = at.paneProps.roles;
    if (declared === null) return null;
    return name === "all" || name in declared.effective ? name : null;
  }
  if (at.pane === "access") {
    if (one !== "agent") return null;
    return at.granted.some((agent) => agent.slug === name) ? name : null;
  }
  if (at.pane === "token") {
    if (one !== "token") return null;
    return at.live.find((token) => token.id === name)?.prefix ?? null;
  }
  // Recording draws paths, not rows: its `?which=` expands one in place and never opens a
  // third level.
  return null;
}

/** The pane's own URL — level 3's way back, minus the `sel` that put it there and plus the
 *  reading state a pane carries, so going up drops the row and keeps the filter. */
function paneHref(slug: string, pane: AppPane, search: Record<string, string | string[] | undefined>): string {
  const kept = new URLSearchParams();
  for (const key of ["q", "new"]) {
    const value = searchValue(search, key);
    if (value !== "") kept.set(key, value);
  }
  for (const value of searchValues(search, "which")) kept.append("which", value);
  const query = kept.toString();
  return query === "" ? paths.appPane(slug, pane) : `${paths.appPane(slug, pane)}?${query}`;
}

/* ---------------------------------------------------------------- the panes --- */

function PaneBody({ pane, props }: { pane: AppPane; props: AppPaneProps }): ReactNode {
  if (pane === "catalog") return <CatalogPane {...props} />;
  if (pane === "roles") return <RolesPane {...props} />;
  if (pane === "recording") return <RecordingPane {...props} />;
  if (pane === "overview") return <OverviewPane {...props} />;
  if (pane === "access") return <AccessPane {...props} />;
  if (pane === "token") return <TokenPane {...props} />;
  return <DangerPane {...props} />;
}

/* -------------------------------------------------------------- the header --- */

/**
 * The proxied half of §2's header: what the hub dials, how it authenticates, and whether it
 * forwards the caller's identity — plus, for `auth: oauth` alone, the same
 * Connect/Reconnect and Disconnect controls /apps draws.
 *
 * `rows` is off on the Overview pane alone: those three facts belong to the header AND to
 * Overview, so there they would be the pane's own first rows printed again with nothing
 * between them. The controls stay on all seven — they belong to the header, not to a pane.
 *
 * Connect is a REAL form POST and not a fetch, for the one reason §8 gives: the route
 * answers a 303 to a third-party authorize URL, and a `fetch` cannot follow a cross-origin
 * redirect into the address bar. So it carries the form-field CSRF carrier rather than the
 * header one.
 */
function UpstreamCard({
  row,
  slug,
  rows,
  csrf,
}: {
  row: AppRow;
  slug: string;
  rows: boolean;
  csrf: string;
}): ReactNode {
  const oauth = row.auth === "oauth";
  const disconnect = useOp<{ slug: string }>("app_disconnect", { app: slug });
  if (!rows && !oauth) return null;
  return (
    <Card>
      {rows ? (
        <KvList variant="block">
          <Kv k="Endpoint">
            <span className="font-mono">{row.endpoint ?? ""}</span>
          </Kv>
          <Kv k="Auth">
            <span className="font-mono">{row.auth ?? ""}</span>
          </Kv>
          <Kv k="Forward identity">{row.forwardIdentity === true ? "On" : "Off"}</Kv>
        </KvList>
      ) : null}
      {oauth ? (
        // On a phone the bare Disconnect takes the row's free width; the Connect form keeps
        // its own, as it always has.
        <div className="flex flex-wrap items-center justify-end gap-3">
          <form method="post" action={paths.appConnect(slug)}>
            <input type="hidden" name="csrf" value={csrf} />
            <Button type="submit" variant="outline" size="sm">
              {row.connection !== undefined && row.connection !== "not_connected" ? "Reconnect" : "Connect"}
            </Button>
          </form>
          <Button
            variant="ghost"
            size="sm"
            className="max-md:flex-1"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate({ slug })}
          >
            Disconnect
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

/* -------------------------------------------------------------- the dialogs --- */

/**
 * The destructive confirmations this page raises, as URL-addressed state: each rides, and
 * cancels back to, the pane that drew its control (§13's "confirm-dialog state rides the
 * owning pane's URL"), and each is validated against the rows in hand — a `revoke-token`
 * naming no listed key opens nothing, exactly as the loader decided.
 *
 * `remove-agent` is deliberately absent: its confirmation submits the Agents pane's own
 * grant editor with the whole set cleared, so `AccessPane` renders it where that mutation
 * lives. Unarchive has no dialog at all, for §2's reason — it destroys nothing.
 */
function AppConfirm({
  pane,
  slug,
  search,
  tokens,
  holdingSocket,
  onDone,
  onClose,
}: {
  pane: AppPane;
  slug: string;
  search: Record<string, string | string[] | undefined>;
  tokens: TokenInfo[];
  /** The id of the key the live socket presented, so the revoke dialog can say that
   *  revoking it closes the connection. */
  holdingSocket: string | null;
  /** Called after a delete, which leaves no page to return to. */
  onDone: () => void;
  onClose: () => void;
}): ReactNode {
  const archive = useOp<{ slug: string }>("app_archive", { app: slug });
  const remove = useOp<{ slug: string }>("app_delete", { app: slug });
  const revoke = useOp<{ id: string }>("token_revoke", { app: slug });

  const kind = searchValue(search, "confirm");
  if (!Object.prototype.hasOwnProperty.call(CONFIRM_PANE, kind)) return null;
  if (CONFIRM_PANE[kind] !== pane) return null;
  if (kind === "remove-agent") return null;

  if (kind === "archive") {
    return (
      <ConfirmDialog
        title={`Archive “${slug}”?`}
        text="It refuses connections and leaves the list — tokens, grants and history are kept."
        onClose={onClose}
      >
        <Actions
          word="Archive"
          pending={archive.isPending}
          onCancel={onClose}
          onConfirm={() => archive.mutate({ slug }, { onSuccess: onClose })}
        />
      </ConfirmDialog>
    );
  }
  if (kind === "delete") {
    return (
      <ConfirmDialog
        title={`Delete “${slug}”?`}
        text="Revokes its tokens, closes the live connection and removes every grant. This cannot be undone."
        onClose={onClose}
      >
        <Actions
          word="Delete"
          pending={remove.isPending}
          onCancel={onClose}
          onConfirm={() => remove.mutate({ slug }, { onSuccess: onDone })}
        />
      </ConfirmDialog>
    );
  }
  const id = searchValue(search, "id");
  const row = tokens.find((token) => token.id === id);
  if (row === undefined) return null;
  return (
    <ConfirmDialog
      title={`Revoke “${row.prefix}”?`}
      text={
        row.id === holdingSocket
          ? "Revoking closes the app's live connection."
          : "The app can no longer connect with it."
      }
      onClose={onClose}
    >
      <Actions
        word="Revoke"
        pending={revoke.isPending}
        onCancel={onClose}
        onConfirm={() => revoke.mutate({ id: row.id }, { onSuccess: onClose })}
      />
    </ConfirmDialog>
  );
}

/** Every dialog's foot: Cancel, then the one destructive verb. Shared because the only
 *  thing that differs between four confirmations is the question above it. */
function Actions({
  word,
  pending,
  onCancel,
  onConfirm,
}: {
  word: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode {
  return (
    <DialogFooter>
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <Button variant="danger" disabled={pending} onClick={onConfirm}>
        {word}
      </Button>
    </DialogFooter>
  );
}

/**
 * The 404 the server-rendered page answered as a document. The client draws it INSIDE the
 * shell instead of redirecting, because the reader is already signed in and on a page: the
 * one thing they need is that this slug names nothing of theirs, and the way back.
 *
 * One answer for three cases — an unknown slug, another namespace's app, and the builtin
 * `pmcp` — because a page reads only the session owner's namespace and a probe must not be
 * able to tell them apart.
 */
function NotFound({ notice }: { notice: Notice | null }): ReactNode {
  return (
    // No page shape: the retired `.page` class this carried matched no rule, so a bare `<main>`
    // is exactly its look today. Giving it one is a look change (pass 2 inventory §1.3).
    <main>
      {notice === null ? null : <NoticeBanner notice={notice} />}
      <Empty>
        <EmptyTitle>No such app</EmptyTitle>
        <EmptyDescription>
          Nothing in your namespace is called that. It may have been deleted, or the link may name someone else's
          app.
        </EmptyDescription>
        <Link className={buttonVariants({ variant: "outline", className: "mt-4" })} to={paths.apps}>
          Back to Apps
        </Link>
      </Empty>
    </main>
  );
}
