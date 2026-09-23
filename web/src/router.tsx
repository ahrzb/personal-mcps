import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import type { Router } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppsPage } from "@/features/apps/AppsPage";
import { AppNewPage } from "@/features/apps/AppNewPage";
import { AppDetailPage } from "@/features/app-detail/AppDetailPage";
import { AgentsPage } from "@/features/agents/AgentsPage";
import { AgentNewPage } from "@/features/agents/AgentNewPage";
import { AgentDetailPage } from "@/features/agents/AgentDetailPage";
import { AgentAppPage } from "@/features/agents/AgentAppPage";
import { AuditPage } from "@/features/audit/AuditPage";
import { ApprovalsPage } from "@/features/approvals/ApprovalsPage";
import { ApprovalDetailPage } from "@/features/approvals/ApprovalDetailPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { settingsPaneOf } from "@/features/settings/derive";
import { DevicePage } from "@/features/device/DevicePage";
import { ConsentPage } from "@/features/consent/ConsentPage";
import { APP_PANES, AGENT_PANES, paths } from "@/lib/paths";
import type { AppPane, AgentPane } from "@/lib/paths";

/**
 * The route families this client owns, and nothing else. `/login` is still a server-rendered
 * page — the router never sees it, and nothing the shell draws links to it.
 *
 * Adding a family here is adding a page, and a page the Worker does not serve a shell for is
 * unreachable — so each one arrives with its shell route. `/audit` became the third on
 * 2026-09-21 (decision 36); `/approvals` and `/approvals/<id>` the fourth on 2026-09-23, the
 * first of decision 38's move of every page onto the SPA, then `/settings`, `/device` and
 * `/oauth/consent`.
 */

/**
 * SEARCH PARAMS ARE PART OF THE CONTRACT, not incidental state. Every key the routes below
 * accept is spelled exactly as `pages/model.ts` spelled it, because existing deep links
 * carry these names: `?confirm=` opens a dialog, `?sel=` selects a row, `?q=` filters a
 * listing, `?which=` expands a mask row. Keeping them in the URL rather than in component
 * state is what makes a shared link open the same screen — and is what lets the preview
 * gallery show a dialog at all.
 */
export type SearchBag = Record<string, string | string[] | undefined>;

/**
 * The search string as `URLSearchParams` reads it: every value a STRING, a repeated key an
 * array of strings.
 *
 * This replaces TanStack Router's default parser, which JSON-parses each value — and that
 * default is wrong here, not merely different. The server read these keys with
 * `URLSearchParams` and treated every one as opaque text, so `?id=123` is the id `"123"`,
 * `?slug=2024` is that slug, and `?confirm=true` is that word. Under JSON parsing each
 * arrives as a number or a boolean, and a pass-through validator that kept only strings
 * would drop the key entirely: a token whose id happens to be digits would open no dialog,
 * and `?calls=40` would silently read as the default page size.
 */
export function parseSearch(search: string): SearchBag {
  const out: SearchBag = {};
  for (const [key, value] of new URLSearchParams(search)) {
    const held = out[key];
    if (held === undefined) out[key] = value;
    else if (Array.isArray(held)) held.push(value);
    else out[key] = [held, value];
  }
  return out;
}

/** The inverse, so a navigation writes back exactly what `parseSearch` would read. */
export function stringifySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const each of value) params.append(key, String(each));
    else params.set(key, String(value));
  }
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

/**
 * The validator every route uses: a PASS-THROUGH rather than a schema, deliberately. An
 * unknown key is a stale link, and dropping it would change a URL a reader pasted. The
 * values each page acts on are validated by that page against the rows it holds, exactly as
 * the loaders did — a `?confirm=` naming no row opens nothing.
 */
function passThroughSearch(search: Record<string, unknown>): SearchBag {
  const out: SearchBag = {};
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === "string") out[key] = value;
    else if (Array.isArray(value)) out[key] = value.map((each) => String(each));
    else if (value !== undefined && value !== null) out[key] = String(value);
  }
  return out;
}

const rootRoute = createRootRoute({ component: Outlet });

const appsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/apps",
  validateSearch: passThroughSearch,
  component: AppsPage,
});

const appNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/apps/new",
  validateSearch: passThroughSearch,
  component: AppNewPage,
});

/**
 * `/apps/<slug>` RENDERS the Catalog in place; it does not redirect to `/apps/<slug>/catalog`.
 *
 * This looked like a place to tidy — one URL per screen — and it is not. §2's narrow shell
 * has three levels, and the bare URL is the only one that produces LEVEL 1, the rail as a
 * list: `styles.css`'s `[data-level="1"] .rail` is the only rule that shows it below the
 * breakpoint, and every pane URL is level 2. Redirecting would delete the phone's top level
 * outright. Above the breakpoint the two URLs are identical renders, which is what made the
 * mistake easy to miss and is exactly why it is written down here.
 *
 * The two segments the server 301'd — `/prompts` and `/resources` — are still the Worker's
 * 301s and never reach this router.
 */
const appDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/apps/$slug",
  validateSearch: passThroughSearch,
  component: AppDetailPage,
});

const appPaneRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/apps/$slug/$pane",
  validateSearch: passThroughSearch,
  // A segment outside the seven panes is not a pane. The Worker already 404s the document
  // for `/apps/<slug>/tools`, so this arm only catches a client-side navigation — and it
  // answers the same way, by leaving the URL space rather than rendering an eighth pane.
  beforeLoad: ({ params }) => {
    if (!(APP_PANES as readonly string[]).includes(params.pane)) {
      throw redirect({ to: paths.appPane(params.slug, "catalog"), replace: true });
    }
  },
  component: AppDetailPage,
});

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents",
  validateSearch: passThroughSearch,
  component: AgentsPage,
});

const agentNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents/new",
  validateSearch: passThroughSearch,
  component: AgentNewPage,
});

/** `/agents/<slug>` lands on the Grant pane for `appDetailRoute`'s reason. The server drew
 *  the first granted app in place; the client navigates to a URL that names it, which the
 *  page itself does once it knows which app that is. */
const agentDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents/$slug",
  validateSearch: passThroughSearch,
  component: AgentDetailPage,
});

const agentPaneRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents/$slug/$pane",
  validateSearch: passThroughSearch,
  beforeLoad: ({ params }) => {
    if (!(AGENT_PANES as readonly string[]).includes(params.pane)) {
      throw redirect({ to: paths.agentPane(params.slug, "grant"), replace: true });
    }
  },
  component: AgentDetailPage,
});

/**
 * `/audit` — the explorer, and the one family that is a single route.
 *
 * It has no segments because it has no panes: the three views, the brush, the facets, the open
 * record and the open session are all SEARCH keys, which is what §13's "one state, in the URL"
 * means here. A `view=` segment would have been the alternative and is wrong for a concrete
 * reason: the three views are three readings of one filtered set, so every key but `view` has
 * to survive switching one, and a path segment would invite a route-level loader per view and
 * a second read with it.
 *
 * Every legacy deep link therefore lands on this route and is read by `derive.selectionOf`:
 * `?principal=`, `?app=`, `?session=`, `?expand=<id>#event-<id>`, `?since=`/`?until=`,
 * `?range=`, and the `?limit=` / `?offset=` that are now ignored.
 */
const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/audit",
  validateSearch: passThroughSearch,
  component: AuditPage,
});

/** The one pane carrying an argument, which is why it is two segments and not in
 *  `AGENT_PANES`. */
const agentAppRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents/$slug/apps/$app",
  validateSearch: passThroughSearch,
  component: AgentAppPage,
});

/**
 * `/approvals` — pending requests, history, and the push opt-in. `?limit=` is the one key it
 * reads (the history cap, `derive.historyLimitOf`), plus the decision flash.
 */
const approvalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/approvals",
  validateSearch: passThroughSearch,
  component: ApprovalsPage,
});

/**
 * `/approvals/<id>` — the chromeless page every -32003's `data.approvalUrl` and every push
 * notification link to. The Worker 404s the document for an id outside this owner's listing
 * before any of this loads, so the route itself checks nothing.
 */
const approvalDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/approvals/$id",
  validateSearch: passThroughSearch,
  component: ApprovalDetailPage,
});

/**
 * `/settings` — the landing pane, Password. It has no `/settings/password` alias (the Worker
 * 404s that document), which is why it is a route of its own rather than a `$pane` value.
 *
 * Every pane is keyed by its name, so a pane switch mounts a fresh page exactly as a GET drew
 * a fresh document: no notice held over, no typed password kept, no enrolment carried along.
 */
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  validateSearch: passThroughSearch,
  component: () => <SettingsPage key="password" pane="password" />,
});

/** `/settings/<pane>` — the other six. A segment that is not one leaves the pane space, as
 *  the Worker's 404 does for the document. */
const settingsPaneRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/$pane",
  validateSearch: passThroughSearch,
  beforeLoad: ({ params }) => {
    if (settingsPaneOf(params.pane) === null) throw redirect({ to: paths.settings, replace: true });
  },
  component: SettingsPaneRoute,
});

function SettingsPaneRoute(): ReactNode {
  const pane = settingsPaneOf(settingsPaneRoute.useParams().pane) ?? "password";
  return <SettingsPage key={pane} pane={pane} />;
}

/**
 * `/device` — the device-flow verdict page, chromeless. One route for its three moments:
 * `?decided=`, `?user_code=` and `?error=` are search keys the page reads, exactly as the
 * server's `deviceStep` read them.
 */
const deviceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/device",
  validateSearch: passThroughSearch,
  component: DevicePage,
});

/**
 * `/oauth/consent` — §19.5's consent screen, chromeless. Its query is the provider's SIGNED
 * request, which the page reads raw off the history (`ConsentPage` says why), so the route's
 * pass-through validator only ever sees it and never feeds it back.
 */
const consentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/oauth/consent",
  validateSearch: passThroughSearch,
  component: ConsentPage,
});

/** The tree both mounts share: `main.tsx` builds a browser-history router over it, and the
 *  preview gallery a memory-history one — which is what lets the gallery show a ROUTE
 *  rather than a component. */
export const routeTree = rootRoute.addChildren([
  appNewRoute,
  appPaneRoute,
  appDetailRoute,
  appsRoute,
  agentNewRoute,
  agentAppRoute,
  agentPaneRoute,
  agentDetailRoute,
  agentsRoute,
  auditRoute,
  approvalsRoute,
  approvalDetailRoute,
  settingsRoute,
  settingsPaneRoute,
  deviceRoute,
  consentRoute,
]);

/** The router, built once. No lazy routes: the build is one file by configuration (the
 *  Worker serves `/app.js` by name and cannot read a Vite manifest), so a code-split
 *  boundary would have nothing to split into. */
export function buildRouter(): Router<typeof routeTree, "never", true> {
  return createRouter({
    routeTree,
    defaultPreload: false,
    parseSearch,
    stringifySearch,
  }) as Router<typeof routeTree, "never", true>;
}

/** Which pane a route's params name, narrowed — the pages take the union, not a string. */
export function appPaneOf(pane: string): AppPane {
  return (APP_PANES as readonly string[]).includes(pane) ? (pane as AppPane) : "catalog";
}

export function agentPaneOf(pane: string): AgentPane {
  return (AGENT_PANES as readonly string[]).includes(pane) ? (pane as AgentPane) : "grant";
}

export {
  appsRoute,
  appNewRoute,
  appPaneRoute,
  agentsRoute,
  agentNewRoute,
  agentDetailRoute,
  agentPaneRoute,
  agentAppRoute,
  auditRoute,
};
