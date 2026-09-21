/**
 * The URLs the client navigates to, and the pane tables behind them.
 *
 * A COPY of `server/src/app-routes.ts`'s two pane lists and the `/apps` and `/agents` arms
 * of `pages/model.ts`'s `paths`, for the reason `web/src/lib/types.ts` states: the client is
 * outside the Worker's dependency closure, so nothing is imported across that line. The
 * spellings are load-bearing — an existing bookmark must keep resolving — so each is
 * written here exactly as the server writes it, and the router validates against these
 * tables rather than against a second list of its own.
 */

/**
 * The seven panes `/apps/<slug>/<pane>` serves, in §2's table order. Catalog is in the list
 * and is ALSO what the landing `/apps/<slug>` renders: identical above the breakpoint, and
 * below it the landing is level 1 (the rail as a list) while `/apps/<slug>/catalog` is
 * level 2 (the listing). `/apps/<slug>/tools` is deliberately not a pane — the families
 * moved into the Catalog, so it 404s, and `/prompts` and `/resources` 301 there.
 */
export const APP_PANES = ["catalog", "roles", "recording", "overview", "access", "token", "danger"] as const;
export type AppPane = (typeof APP_PANES)[number];

/**
 * The single-segment panes `/agents/<slug>/<pane>` serves, in rail order. The agent page's
 * OTHER pane — one app's grants — is two segments (`apps/<app>`) and is therefore absent:
 * it carries an argument, so it is a route of its own, and `/agents/<slug>` renders it for
 * the first granted app in place.
 */
export const AGENT_PANES = ["grant", "credentials", "activity", "danger"] as const;
export type AgentPane = (typeof AGENT_PANES)[number];

/**
 * The rail's own labels and grouping for the app page's seven panes — §13's table,
 * verbatim from `pages/model.ts:3863-3871`. `null` is the headless tail the Danger zone
 * sits in: no heading, but a rule above it, which is how the board separates it from the
 * groups without inventing a third heading.
 *
 * No `short` column: the app and agent pill rows draw the rail's own label (only
 * /settings shortens one, and /settings is not this client's).
 */
export const APP_PANE_TABLE: readonly { pane: AppPane; label: string; group: string | null }[] = [
  { pane: "catalog", label: "Catalog", group: "App" },
  { pane: "roles", label: "Roles", group: "App" },
  { pane: "recording", label: "Recording", group: "App" },
  { pane: "overview", label: "Overview", group: "App" },
  { pane: "access", label: "Agents", group: "Access" },
  { pane: "token", label: "Token", group: "Access" },
  { pane: "danger", label: "Danger zone", group: null },
];

/** The agent rail's fixed tail. Its HEAD is the agent's granted apps, one entry each under
 *  an `Apps · N` heading, so the table cannot be static the way the app one is — the page
 *  builds those entries from the grants it read. */
export const AGENT_GROUP = "Agent";

/** A search bag as a query string, or "" — the one spelling, so a hand-built `/audit?…` cannot
 *  differ from what `router.tsx`'s codec would write and read back. */
function query(search: Record<string, string | string[]>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (Array.isArray(value)) for (const each of value) params.append(key, each);
    else params.set(key, value);
  }
  const written = params.toString();
  return written === "" ? "" : `?${written}`;
}

export const paths = {
  apps: "/apps",
  appNew: "/apps/new",
  agents: "/agents",
  agentNew: "/agents/new",
  /**
   * The explorer, optionally carrying a selection. A FUNCTION rather than a bare string
   * because every link to this page carries state now: the agent page's `?principal=`, the
   * app page's `?app=`, a record's `?expand=` and the page's own `searchOf(selection)` are all
   * this one path plus keys — and `/audit` itself is `paths.audit()`.
   *
   * Repeated keys ride as arrays, exactly as `router.tsx`'s `stringifySearch` writes them.
   */
  audit: (search: Record<string, string | string[]> = {}): string => `/audit${query(search)}`,
  approvals: "/approvals",
  settings: "/settings",
  /** The SSR sign-out target — a real form POST, because it is better-auth's own route and
   *  answers with Set-Cookie and a redirect. */
  signOut: "/api/auth/sign-out",
  /** §8's one browser-only interaction, kept as a server route: it answers a 303 to a
   *  third-party authorize URL, and a `fetch` cannot follow a cross-origin redirect into
   *  the address bar — so the client renders a real `<form method="post">` at it. */
  appConnect: (slug: string): string => `/apps/connect?slug=${encodeURIComponent(slug)}`,
  appPane: (slug: string, pane: AppPane): string => `/apps/${encodeURIComponent(slug)}/${pane}`,
  appDetail: (slug: string): string => `/apps/${encodeURIComponent(slug)}`,
  agentPane: (slug: string, pane: AgentPane): string => `/agents/${encodeURIComponent(slug)}/${pane}`,
  agentDetail: (slug: string): string => `/agents/${encodeURIComponent(slug)}`,
  agentApp: (slug: string, app: string): string =>
    `/agents/${encodeURIComponent(slug)}/apps/${encodeURIComponent(app)}`,
  approval: (id: string): string => `/approvals/${encodeURIComponent(id)}`,
} as const;

/** §2's reserved role: granted like any other, declared by nobody, and the one the listing
 *  marks `built-in`. */
export const BUILTIN_ROLE = "all";

/** The wire spelling of approval mode in a grant entry (§8). */
export const APPROVAL_SUFFIX = ":approval";

/** The rail marker for "advertises none" — an em dash, and never the empty string, which
 *  means "could not be read" (§13: an unread count is not an empty set). */
export const DIMMED = "—";
