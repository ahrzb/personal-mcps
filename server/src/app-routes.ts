// app-routes.ts — what the router mounts under `/apps/` and `/agents/`, as data: the seven
// non-landing panes of `/apps/<slug>`, the four of `/agents/<slug>`, and the slugs an app
// may therefore never take.
//
// Two modules read this and neither may import the other's layer: `web.ts` mounts the panes
// and the static segments from it, and `admin.ts` refuses `app_create` the segments (§8 —
// "because `/apps/<slug>` is a page"). A leaf is the only place both can reach, since
// `admin.ts` must not import `pages/*` and `registry.ts` must not import `web.ts`.
//
// The reservation is DERIVED, never hand-kept (§2's own rule for usernames, applied one
// level down): the static segments are listed once, here, and the reserved set is the
// charset-legal ones — the op-named POST targets under `/apps/` carry `_` and fall outside
// SLUG_CHARSET already, so nothing has to remember to leave them out.
// server/test/worker/routes.test.ts walks the running router against this set.
//
// deps: registry.SLUG_CHARSET

import { SLUG_CHARSET } from "./registry";

/**
 * The seven panes `/apps/<slug>/<pane>` serves, in §2's own table order. Catalog is in the
 * list and is ALSO what the landing `/apps/<slug>` renders — the agent page's shape, where
 * the landing renders a pane that has a URL of its own: the two answers are identical
 * above the breakpoint, and below it the landing is level 1 (the rail as a list) while
 * `/apps/<slug>/catalog` is level 2 (the listing). `/apps/<slug>/tools` stays a 404: the
 * families moved INTO the Catalog on 2026-09-17, so it is not an alias of anything, and
 * `/prompts` and `/resources` 301 to `/apps/<slug>/catalog` for the same reason.
 *
 * `access` is the Agents pane — the rail groups it under `Access`, and the URL is the
 * group's.
 */
export const APP_PANES = ["catalog", "roles", "recording", "overview", "access", "token", "danger"] as const;

/** One of the seven pane segments — the type `paths.appPane` and the page take. */
export type AppPane = (typeof APP_PANES)[number];

/**
 * The single-segment panes `/agents/<slug>/<pane>` serves, in the rail's own order. The
 * agent page's OTHER pane — one app's grants — is two segments (`apps/<app>`) and is
 * therefore deliberately absent: it carries an argument, so it is a route of its own
 * rather than a member of this set, and `/agents/<slug>` renders it for the first granted
 * app in place (no alias URL for a landing pane, §13).
 *
 * No reservation is derived from this list, unlike the app one: these sit one segment
 * BELOW an agent's slug, so none of them can shadow an agent. `/agents/new` is the only
 * segment an agent slug could collide with, and `agent_create` refuses it by name.
 */
export const AGENT_PANES = ["grant", "credentials", "activity", "danger"] as const;

/** One of the four agent pane segments — `paths.agentPane` and the page take it. */
export type AgentPane = (typeof AGENT_PANES)[number];

/**
 * The segments the router mounts DIRECTLY under `/apps/`, ahead of the `:slug` route. Both
 * are pages/flows of their own, so a slug of the same name would be unreachable at its own
 * URL. The op-named targets (`app_create`, `app_archive`, …) are mounted under the same
 * prefix and are not listed here for the reason they need not be: they carry `_`.
 */
const APP_STATIC_SEGMENTS = ["new", "connect"] as const;

/**
 * The app slugs `app_create` refuses (§8/§13): the static segments above that a slug could
 * actually collide with. Derived through the charset, so adding an op-named target reserves
 * nothing and adding a page segment reserves it with no second edit.
 */
export const RESERVED_APP_SLUGS: ReadonlySet<string> = new Set(
  APP_STATIC_SEGMENTS.filter((segment) => SLUG_CHARSET.test(segment)),
);
