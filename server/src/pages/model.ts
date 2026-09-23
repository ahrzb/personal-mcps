// model.ts — the view-model contract between the page handlers (web.ts) and the
// templates in this directory, plus the ONE definition of the hub's browser URL
// space, plus the READS that fill those props in.
//
// OWNS: one Props type per SERVER-RENDERED page of §13 (/login, /device, /settings,
// /approvals, /approvals/<id>, /oauth/consent), the shared chrome those pages
// render inside, the `paths` object every link, form action and client route is built
// from, and one loader per such page — the seam where a props value stops being a
// fixture and becomes a real read. /apps/*, /agents/* and — since 2026-09-21, decision 36
// — /audit have no props here: they are a
// React SPA served from a shell document, and what this file still owns for them is
// `paths` (the URL space they mirror), the pure FORM COMPOSERS the JSON API calls
// (api.ts) — `composeOwnerRoles`, `composeRedaction`, `composeRoles`,
// `composeTypescriptAliases`, `grantChoicesOf` — which stay on the server because they
// are the rule a save is composed by, not a rendering concern, and the audit READ shapes
// (`AuditEventRow`, `eventRow`, `noBodiesReason`, `auditFilters`, `auditExportQuery`),
// which api.ts and web.ts answer their audit routes from.
//
// HIDES: nothing about the domain — every field here is either lifted straight from a
// read model (registry / approvals / audit, via type-only imports) or is an explicitly
// derived projection of one. Where a page needs less than a read model offers, it says
// so with Pick/Omit rather than restating a shape that could then drift.
//
// The loaders CONSUME and never reimplement: every one of them reads through
// `admin.ops` — the same handlers the `pmcp` tools and the CLI front (§8's
// parity invariant), so a page can show nothing a tool cannot, and a filter or
// default the tool applies is applied here by construction rather than by
// agreement. The exceptions are named where they are made: the VAPID public
// key and the retention window are configuration, not a read, and /settings's
// credential state is better-auth's, reached through identity's own mounted
// endpoints because §4 gives that module sole custody.
//
// The parity exception this file used to carry is CLOSED (2026-09-21, decision 36): the
// four summary tiles and the histogram were aggregations computed here over `audit_query`
// rows, and so were something the CLI could not show. They went with the server-rendered
// page. §13's explorer derives its own tiles, lanes and facets in the browser over rows
// `audit_query` answered, so nothing on this side aggregates anything the tools cannot
// read — and the JSONL export is once again the only named exception.
//
// Two rules the templates depend on, stated once here:
//
//  1. Templates are pure `(props) => JSX`. They never fetch, never read cookies,
//     never call Date.now(), and never build a URL by concatenation — the render
//     instant arrives as `now` and every URL comes from `paths`. That is what
//     makes a template renderable from a fixture (server/dev/fixtures.ts) and
//     from a request with identical results.
//  2. Desktop and mobile are ONE template. The Mobile*.dc.html artboards are the
//     narrow breakpoint of these same props — e.g. /approvals' wide rows and its
//     narrow stack are two presentations of one approval list, never two view models.
//
// Timestamps are mixed on purpose and the mix is inherited, not invented: the
// skeleton read models spell time two ways — ISO-8601 strings in approvals
// (ApprovalRow) and epoch milliseconds in registry/audit (AuditRow, TokenInfo) — and
// this file keeps each field exactly as its source states it.
// `now` is ISO-8601; a template comparing it with an epoch-ms field parses it
// (Date.parse) rather than reaching for a clock of its own.

import { env } from "cloudflare:workers";
// The only thing in the tree that can draw a QR (`enrollmentOf`), and the only reason it
// is a dependency at all: §13 pins "QR plus the grouped secret", and the point of a QR is
// a phone camera. Zero-dependency, pure ESM, no Node built-ins — it runs on workerd.
import { renderSVG } from "uqr";
import { ops } from "../admin";
import type { AgentPane, AppPane } from "../app-routes";
import type { AppRow as OpsAppRow } from "../admin";
import type { TypescriptAliases } from "../hub-types";
import {
  AUTH_BASE_PATH,
  callAuth,
  getAuthenticatorName,
  passkeyLastUsed,
  PASSWORD_MIN_LENGTH,
} from "../identity";
import type { TokenInfo } from "../identity";
import { AUDIT_EXPORT_MAX_VALUES, DEVICE_CODE_TTL_MS, HUB_HARD_MAX_TIMEOUT_MS, HUB_MIN_TIMEOUT_MS } from "../limits";
import { ROLE_FAMILIES } from "../registry";
import type { FamilyPatterns, RoleDeclaration, RoleFamily } from "../registry";
import type { ApprovalListFilters, ApprovalRow, ApprovalStatus } from "../approvals";
import type { AuditQuery, AuditRow, AuditSlimRow, BodyStub } from "../audit";

/* ------------------------------------------------------------------ *
 * Shared chrome
 * ------------------------------------------------------------------ */

/**
 * The floor every page stands on. `now` is the instant the response was
 * rendered — the only clock a template ever reads, so relative copy ("expires in
 * 43 min", "last used yesterday", "seen now") is a pure function of the props
 * and a fixture renders byte-identically every time. ISO-8601, UTC.
 */
export type PageProps = {
  now: string;
};

/**
 * §13's Password pane renders the length hint from this and nothing else — re-exported
 * through the props layer so the template needs no import of its own into identity, and
 * so the number better-auth enforces and the number the page shows are one value (§4).
 */
export { PASSWORD_MIN_LENGTH };

/**
 * The four nav destinations of the signed-in shell (Main.dc.html's header), in
 * the order they are rendered. Pages outside the shell — /login, /device,
 * /apps/new, /approvals/<id> — are chromeless card layouts and carry no
 * section at all, which is why this never has a "none" member.
 */
export type NavSection = "apps" | "agents" | "audit" | "approvals" | "settings";

/**
 * The redirect-back flash: every mutating page POST lands on an admin op and
 * then redirects to the page it came from (web.ts), so the outcome has to
 * survive as one line of props rather than as a rendered exception. `tone` maps
 * onto the design system's alert palettes (Main.dc.html): success #f0fdf4,
 * warning #fffbeb, danger #fef2f2.
 *
 * A refusal always names the op it refused (web.ts's `noticeOf`), so the danger
 * arm's `title` is required — a bold-line-less danger alert is not a state this
 * hub can produce. A success is often one sentence, so there its title is optional.
 */
export type Notice =
  | {
      tone: "success" | "warning";
      /** Optional bold first line; the alert renders message-only when absent. */
      title?: string;
      message: string;
    }
  | { tone: "danger"; title: string; message: string };

/**
 * What every page inside the signed-in shell needs from the shell itself.
 * `pendingApprovals` is the red count badge on the Approvals tab — it is the
 * number of rows the /approvals page would show as pending right now, so a page
 * that also lists them (ApprovalsProps) must report the same number in both
 * places or the badge lies.
 */
export type ShellProps = PageProps & {
  /** The signed-in owner; also the namespace name in every /<user>/mcp URL. */
  username: string;
  section: NavSection;
  pendingApprovals: number;
  /** null on a plain GET; set for exactly one render after a mutation. */
  notice: Notice | null;
};

/* ------------------------------------------------------------------ *
 * URL space (§2's reserved top-level segments, §13's pages)
 * ------------------------------------------------------------------ */

/** Drops empty/absent values so a filter that is off leaves no trace in the URL. */
function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : "";
}

/**
 * Every URL the browser surface serves or posts to, in one object — templates
 * import this and never spell a path themselves, so a route rename is one edit
 * here instead of a search across every template and client route. Page routes come straight
 * from §13; sub-paths under them are this file's decision and are what web.ts's
 * route table mounts. The reserved-segment rule of §2 holds by construction:
 * nothing here introduces a new top-level segment beyond login, device, agent,
 * audit, approvals, apps, api and oauth.
 *
 * Mutating targets are POST-only and CSRF-checked; the read targets are GET.
 * Both are named for what they do, not for their method.
 *
 * One convention holds every ops-backed mutation together, and §8's parity
 * direction B is what it buys: the FINAL PATH SEGMENT of such a target is the
 * `admin.ops` key it fronts, and every argument that is not a form control
 * rides the query string under the field name the op's own schema declares.
 * So the field set a browser submits and the field set the op accepts are one
 * thing derived two ways — a schema change with no form change is a broken
 * link, not a silently ignored field. The three mutations that front no tool
 * say so by naming no op: `connect` (the consent redirect is a browser
 * interaction, §8), `push` (approvals owns Web Push), and the device
 * decision (better-auth's own endpoint, §4).
 */
export const paths = {
  /* --- pages (§13) --- */

  /** Username + password, TOTP challenge, backup code, passkey button. */
  login: "/login",
  /** RFC 8628 device approval; deep-linked from the CLI as `?user_code=…`. */
  device: "/device",
  /**
   * Credential management — cookie session with recent auth only (§4). §13's "A pane is a
   * route": this is the LANDING pane (Password) and the five below are the others, one URL
   * each and no alias for the landing one (`/settings/password` is a 404). Plain strings
   * rather than a nested object or a builder, because every walk over the hub's URL space
   * reads `Object.values(paths)` filtered to strings.
   */
  settings: "/settings",
  settingsTwoFactor: "/settings/two-factor",
  settingsPasskeys: "/settings/passkeys",
  settingsSessions: "/settings/sessions",
  settingsTokens: "/settings/tokens",
  settingsClients: "/settings/clients",
  /**
   * §23's Execution pane — the owner's hub execution timeout pair (§13's Runtime group,
   * added 2026-09-18). It is the one /settings pane that configures what programs may
   * SPEND rather than who may reach the hub, which is why it sits outside Sign-in/Access.
   */
  settingsExecution: "/settings/execution",
  /**
   * hub_settings_update — the Execution pane's one Save, under its own pane's prefix so
   * the redirect-back lands where the form was drawn (§13's "mutations belong to a
   * pane"). A route of its own rather than the generic dispatch: the two controls are
   * milliseconds the op takes as INTEGERS, and a refusal must redraw the pane at 400 with
   * the op's sentence under the field it named, which a redirect's single flash cannot do.
   * NO ROUTE since decision 38's family 2, for `auth`'s settings members' reason; the
   * client posts `POST /api/hub/settings/execution/hub_settings_update`.
   */
  settingsExecutionUpdate: "/settings/execution/hub_settings_update",
  /** App management: active, archived, and the add-app entry point. */
  apps: "/apps",
  /** The add-app form (§13's "add-app flow"). */
  appNew: "/apps/new",
  /**
   * One app's detail page — the LANDING pane, which is Tools (§13's "Panes behind a
   * rail"). There is deliberately no `appTools` member: `/apps/<slug>/tools` is a 404,
   * so a `paths` entry for it would be a spelling of a page that does not exist.
   */
  appDetail(slug: string): string {
    return `/apps/${encodeURIComponent(slug)}`;
  },
  /** Any of the six non-landing panes (app-routes.APP_PANES, §2's table order). */
  appPane(slug: string, pane: AppPane): string {
    return `${paths.appDetail(slug)}/${pane}`;
  },
  /** Pending requests plus decision history. */
  approvals: "/approvals",
  /** §13's agents list (2026-09-03, roadmap step 9): every agent, its grants per app and
   *  its live keys, with New agent and Delete. */
  agents: "/agents",
  /** The create form — agent_create's three fields; `new` is reserved from agent slugs
   *  for it (§2), exactly as `/apps/new` reserves `new` from app slugs. */
  agentNew: "/agents/new",
  /** The agent page — the LANDING render, which is the first app in slug order the agent
   *  holds a grant on (the grant step when it holds none). There is deliberately no
   *  member for that pane at an alias URL: §13's pane rule makes one a 404. */
  agentDetail(slug: string): string {
    return `/agents/${encodeURIComponent(slug)}`;
  },
  /** One (agent × app) pair's grants — the agent page's listing + details pane. */
  agentApp(agent: string, app: string): string {
    return `${paths.agentDetail(agent)}/apps/${encodeURIComponent(app)}`;
  },
  /** Any of the four single-segment agent panes (app-routes.AGENT_PANES). */
  agentPane(slug: string, pane: AgentPane): string {
    return `${paths.agentDetail(slug)}/${pane}`;
  },
  /** §13's audit explorer — the SPA's third route family since 2026-09-21 (decision 36), so
   *  this is the SHELL's URL and the client owns every link under it. */
  audit: "/audit",
  /** §19.5's consent screen — an external client's authorization request, and the
   *  agent picker that decides how much power it gets. */
  oauthConsent: "/oauth/consent",
  /** §19.6/§8's connections list, with Revoke. */
  oauthConnections: "/oauth/connections",

  /* --- the PWA shell (§13) --- */

  /** Installability. Five URLs named here because web.ts serves them; layout.tsx spells
   *  the four the shell LINKS itself (manifest, worker, stylesheet, the 192 icon), since
   *  the shell links them rather than navigating to them. */
  manifest: "/manifest.webmanifest",
  /** Push + notificationclick only — never a fetch handler (the no-SPA pin). */
  serviceWorker: "/sw.js",
  /** The one stylesheet every page's document head links. */
  stylesheet: "/styles.css",
  /**
   * The browser client's two files (§13), served by web.ts out of the ASSETS binding and
   * linked by the SPA shell document — the script after the bootstrap block, the sheet
   * after `stylesheet`, which it extends rather than replaces. Dotted, so both stay out of
   * the username charset as the three above already do.
   */
  clientScript: "/app.js",
  clientStylesheet: "/app.css",
  /** The two PNGs the manifest's `icons` declares — the pair Chromium's install gate is
   *  built around — the first also the shell head's `rel="icon"`. Dotted, so both stay
   *  out of the username charset as the three above already do. */
  icon192: "/icon-192.png",
  icon512: "/icon-512.png",

  /** The detail page a -32003 error links an agent's user to (§7). */
  approval(id: string): string {
    return `/approvals/${encodeURIComponent(id)}`;
  },

  /**
   * /approvals under approval_list's own filters (§8) — how "Older →" widens the
   * history limit. There is no offset: the tool takes `status` and `limit` and
   * nothing else, so the page cannot invent paging the read model doesn't have.
   */
  approvalsWith(filters: ApprovalListFilters): string {
    return `/approvals${query({ ...filters })}`;
  },

  /**
   * The streaming JSONL export of the rows matching a selection (§13) — a bookmarkable URL
   * since before the explorer and unchanged by it. A bare path rather than a builder: the
   * keys it accepts are REPEATED ones (`auditExportQuery`), which the client composes and
   * this module would only be able to compose one value of.
   */
  auditExport: "/audit/export.jsonl",

  /* --- mutations posted by the pages --- */

  /** Approve/deny the device code; the decision rides a submit button's value.
   *  better-auth's endpoint underneath, so this target names no op.
   *  NO ROUTE since decision 38's family 3: only the retained device template draws it,
   *  for the states preview; the client posts `POST /api/hub/device/decide`. */
  deviceDecide: "/device/decide",
  /** approval_decide (§8) for one request; approve and reject share the form,
   *  which submits the `decision` field the op's schema names.
   *  NO ROUTE since decision 38: only the retained approvals templates draw it, for the
   *  states preview; the client decides through `POST /api/hub/ops/approval_decide`. */
  approvalDecide(id: string): string {
    return `/approvals/approval_decide${query({ id })}`;
  },
  /** Where the browser's PushSubscription JSON was registered (approvals.subscribePush).
   *  NO ROUTE since decision 38, for `approvalDecide`'s reason; the client posts
   *  `POST /api/hub/approvals/push`. */
  approvalsPush: "/approvals/push",
  /**
   * Connect and Reconnect are the same target: both start upstream.beginConnect
   * and redirect to the provider (§7). The button label differs, the flow does
   * not — and neither fronts a tool, which is why this path names no op.
   */
  appConnect(slug: string): string {
    return `/apps/connect${query({ slug })}`;
  },
  /** The Tokens pane under §13's **All · Agents · Apps** filter. `undefined` is All and
   *  spells `paths.settingsTokens` exactly, so the active pill and the rail entry point at
   *  one URL rather than at two spellings of it. */
  settingsTokensWith(kind?: TokenRow["kind"]): string {
    return `${paths.settingsTokens}${query({ kind })}`;
  },
  /** token_revoke (§8) — the Tokens pane's Revoke/Remove control, under its own pane's
   *  prefix so §13's "mutations belong to a pane" holds for the redirect back.
   *  NO ROUTE since decision 38's family 2 (see `auth`); the client posts
   *  `POST /api/hub/settings/tokens/token_revoke`. */
  tokenRevoke(id: string): string {
    return `${paths.settingsTokens}/token_revoke${query({ id })}`;
  },
  /** connection_revoke (§8/§19.6) — the Connected clients pane's Revoke. It moved here
   *  with its pane: nothing posts under `/oauth/connections` any more. NO ROUTE since
   *  decision 38's family 2 either; the client posts
   *  `POST /api/hub/settings/clients/connection_revoke`. */
  connectionRevoke(id: string): string {
    return `${paths.settingsClients}/connection_revoke${query({ id })}`;
  },
  /**
   * One /settings pane's own URL — the rail's `href` as a function, so everything that
   * holds a PANE (a dialog's owner, a redirect-back) reaches its URL without a second
   * spelling of which path a pane is. The `??` arm is unreachable: SETTINGS_PANES covers
   * `SettingsPane`, and the landing pane's URL is `paths.settings` anyway.
   */
  settingsPane(pane: SettingsPane): string {
    return SETTINGS_PANES.find((entry) => entry.pane === pane)?.href ?? paths.settings;
  },

  /* --- confirm dialogs as addressable state --- */

  /**
   * The same page with one destructive <dialog> rendered open, and `pane` is first because
   * a dialog rides the URL of the pane that OWNS the control, never the page root (§13's
   * "mutations belong to a pane"). Server-rendered state, so the confirm step works with
   * scripting off and is reachable from a fixture. The argument is the PANE, not its href:
   * the dialog's Cancel, its redirect-back and the rail's active entry then name one URL
   * because they name one pane, and comparing a dialog's owner to the rendering pane is
   * `===`.
   */
  settingsConfirm(pane: SettingsPane, kind: SettingsConfirm["kind"], id?: string): string {
    return `${paths.settingsPane(pane)}${query({ confirm: kind, id })}`;
  },

  /* --- the consumer endpoint a page only ever displays --- */

  /**
   * The scoped MCP endpoint of one app — shown, never linked: /apps/new
   * spells it out under the slug field ("served at /ahrzb/mcp/linear") so the
   * owner sees what they are naming.
   */
  mcpScoped(username: string, slug: string): string {
    return `/${encodeURIComponent(username)}/mcp/${encodeURIComponent(slug)}`;
  },

  /**
   * The credential family (§4) — deliberately never a pmcp tool, and, since
   * 2026-08-26, deliberately not better-auth's own URLs either. WHY, because it would
   * otherwise read as a regression: better-auth's router accepts `application/json`
   * and nothing else, so a `<form method="post">` aimed at one of its endpoints is
   * answered 415 UNSUPPORTED_MEDIA_TYPE — a human could not sign in at all. Every
   * target below that a FORM posts to is therefore a HUB-OWNED translation route
   * (web.ts): it reads the form body, calls better-auth as JSON through identity's
   * `callAuthResponse` — §4's sole-custodian seam is still the only door — hands
   * better-auth's own `Set-Cookie` headers back to the browser, and redirects. The
   * templates are unchanged and the custody rule is unchanged; only the `action=` moved.
   *
   * Each hub path KEEPS the final segment of the endpoint it fronts, so a target still
   * names its endpoint (`…/verify-totp` is `/two-factor/verify-totp`) — the same
   * final-segment convention the ops-backed targets above follow, one rule for both.
   *
   * `signOut` is translated too, and its case is worth stating because it looks like it
   * should not need to be: the shell's form has NO controls, so a browser posts it with
   * an empty body — and better-auth answers that 415 as well (verified against a running
   * worker, 2026-08-26). "Sign out" was exactly as broken as "Sign in". It is the one
   * target that reaches its hub route without a CSRF token, because layout.tsx renders it
   * inside every page's shell and LayoutProps carries none to render; what stands in its
   * place is the same origin rule better-auth itself applied while the form still posted
   * there (web.ts's `crossOrigin`), so nothing was traded away.
   *
   * FOUR stay on better-auth's mount: the two WebAuthn ceremonies' options-and-verify
   * pairs. A ceremony is not a form post in the first place — it is two JSON round trips
   * with `navigator.credentials` between them — so there is no form body to translate and
   * nothing a hub route would add (§13: "the one credential POST that is not a form").
   *
   * The eight `/settings/…` members have NO ROUTE since decision 38's family 2: only the
   * retained settings template draws them, for the states preview (ruling §5.2), and the
   * client posts their JSON twins under `/api/hub/settings/` (api.ts).
   */
  auth: {
    /** Where the composition root mounts better-auth — the prefix every untranslated
     *  path below (the four passkey ceremonies) is composed from, and the prefix
     *  identity's `callAuth` builds on. identity's, not this file's: the mount and the
     *  base path better-auth itself routes on are one decision (identity.AUTH_BASE_PATH). */
    base: AUTH_BASE_PATH,
    signIn: "/login/sign-in/username",
    signOut: "/login/sign-out",
    /** /login's challenge card posts here: the code that finishes a sign-in a second
     *  factor held. /settings's enrolment card posts at `totpVerifySettings` below —
     *  same better-auth endpoint, different target, for the reason spelled there. */
    totpVerify: "/login/two-factor/verify-totp",
    backupCodeVerify: "/login/two-factor/verify-backup-code",
    totpEnable: "/settings/two-factor/enable",
    /** /settings's enrolment card posts here — the code typed into the six boxes under
     *  the QR. A target of its own rather than `totpVerify` above, because this one is a
     *  `credential`: it inherits the CSRF check and §4's freshness gate, and its REFUSAL
     *  is answered in place at 200 with the same enrolment redrawn (web.ts's `reveal`
     *  says why the QR cannot be re-derived). /login's translation does neither. */
    totpVerifySettings: "/settings/two-factor/verify-totp",
    totpDisable: "/settings/two-factor/disable",
    backupCodesGenerate: "/settings/two-factor/generate-backup-codes",
    /** The registration ceremony /settings/passkeys' **Add passkey** performs: options
     *  out, the authenticator's attestation back in. Named as a PAIR because the page's
     *  script calls both and a page that named only the first would ask an authenticator
     *  for a credential nothing then stores. */
    passkeyRegister: `${AUTH_BASE_PATH}/passkey/generate-register-options`,
    passkeyVerifyRegistration: `${AUTH_BASE_PATH}/passkey/verify-registration`,
    /** The authentication ceremony /login's passkey button performs — the same pair, and
     *  the endpoint whose success is a sign-in (identity stamps §5's last_used_at on it). */
    passkeyAuthenticateOptions: `${AUTH_BASE_PATH}/passkey/generate-authenticate-options`,
    passkeyVerifyAuthentication: `${AUTH_BASE_PATH}/passkey/verify-authentication`,
    passkeyDelete: "/settings/passkey/delete-passkey",
    sessionRevoke: "/settings/revoke-session",
    /** The Sessions pane's **Revoke all others** (§13) — better-auth's own
     *  `/revoke-other-sessions`, which keeps the current session and takes no password. */
    revokeOtherSessions: "/settings/revoke-other-sessions",
    /** The Password pane's **Update password** (§13/§4's amendment): core better-auth's
     *  `/change-password`, gated like every other credential POST. */
    changePassword: "/settings/change-password",
  },
} as const;

/* ------------------------------------------------------------------ *
 * /login
 * ------------------------------------------------------------------ */

/**
 * The ONE rule both of /login's landing consumers stand on: a target that stays inside
 * this hub, or null. A path starting `/` whose second character is neither `/` nor `\` is
 * returned; anything else — absolute, scheme-relative, the backslash spelling
 * browsers fold into `//` (the WHATWG parser treats `\` as `/` for special schemes, which
 * is why `/\evil.example` is a host and not a path), empty, absent — is null.
 *
 * Both consumers are a caller's input: the `?next=` a browser follows into GET /login, and
 * the `callbackURL` a browser posts to the sign-in routes. Honouring an absolute one makes
 * /login an open redirect for anyone who can get a browser here, so the two read one rule
 * rather than two spellings of it.
 */
export function hubRelative(target: string | null | undefined): string | null {
  // Judged after the strip the WHATWG parser performs first: it deletes every ASCII tab,
  // LF and CR before parsing, so `/<TAB>/evil.example` IS `//evil.example` by the time a
  // browser reads it. The stripped string is returned because it is what the browser uses.
  const path = target?.replace(/[\t\n\r]/g, "") ?? "";
  return path.startsWith("/") && path[1] !== "/" && path[1] !== "\\" ? path : null;
}

/** /login under a set of query fields; an absent or empty one leaves no trace. */
export function loginUrl(fields: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(name, value);
  }
  const rendered = search.toString();
  return rendered === "" ? paths.login : `${paths.login}?${rendered}`;
}

/**
 * The three things /login can be showing, as one discriminated union rather than
 * three pages: better-auth answers a password POST with either a session or a
 * two-factor challenge, and the backup-code form is the same challenge in
 * another spelling (AuthStates.dc.html). `error` is the field-level message the
 * artboards render in #dc2626 under the offending control — null on a first
 * render, non-null on a re-render after a failed attempt.
 */
export type LoginStep =
  | {
      kind: "credentials";
      /** Echoed back after a failed attempt so the owner retypes only the password. */
      username: string;
      error: string | null;
    }
  | { kind: "totp"; error: string | null }
  | { kind: "backup-code"; error: string | null };

/**
 * /login. The only page with no CSRF token of its own: there is no session yet
 * to derive one from, and its forms post to better-auth, which brings its own
 * origin defense (§4). Rate limiting for this surface lives in the WAF (§15).
 */
export type LoginProps = PageProps & {
  step: LoginStep;
  /**
   * Where to land after sign-in, when the browser was bounced here from a
   * deep link (requireOwnerSession throws a redirect through /login) — e.g.
   * "/approvals/apr_8f2k" from a push notification, or /device with its user
   * code. Rendered as a hidden field; null means the default landing page.
   */
  redirectTo: string | null;
};

/* ------------------------------------------------------------------ *
 * /device
 * ------------------------------------------------------------------ */

/**
 * What the owner is being asked to vouch for. Every field is display-only and
 * every field is attacker-influenced except `username` — the user-code channel
 * is unauthenticated (RFC 8628 §5.4), which is precisely why the page shows the
 * requesting IP and client and states the blast radius in words.
 */
export type DeviceRequest = {
  /** The code the CLI printed, in its display grouping: "BDWJ-KTQP". */
  userCode: string;
  /** Requesting IP as the edge saw it. */
  ip: string;
  /** Client description derived from the user agent — untrusted, never parsed. */
  client: string;
  /** ISO-8601; rendered relative against `now` ("Just now"). */
  requestedAt: string;
  /** ISO-8601, ~10 minutes out (§13's shortened device-code lifetime). */
  expiresAt: string;
};

/**
 * /device's three moments: the owner has not typed a code yet, a live request is
 * waiting for a verdict, or the verdict is in. An unknown or past-expiry code
 * comes back as `enter-code` with `error` set — that is the EXPIRED CODE state
 * of AuthStates.dc.html, not a state of its own, because the recovery is the
 * same: type another code.
 */
export type DeviceStep =
  | { kind: "enter-code"; userCode: string; error: string | null }
  | { kind: "confirm"; request: DeviceRequest }
  | { kind: "decided"; decision: "approved" | "denied" };

/**
 * /device — cookie-session gated (an unauthenticated visitor is sent through
 * /login first, which is what makes `username` knowable here). Approving grants
 * full admin CLI control of the namespace, so the page says so in an alert and
 * the POST carries a CSRF token (§13).
 */
export type DeviceProps = PageProps & {
  username: string;
  csrfToken: string;
  step: DeviceStep;
};

/* ------------------------------------------------------------------ *
 * /settings
 * ------------------------------------------------------------------ */

/**
 * The steady state of the second factor — the whole of what better-auth's
 * `/get-session` reports about it (`twoFactorEnabled`), which is why the enabled
 * arm carries nothing else: the backup codes live encrypted in a table §4 gives
 * identity sole custody of, and no endpoint counts them (settingsProps says so
 * again where it reads).
 */
export type TwoFactorSummary = { enabled: false } | { enabled: true };

/**
 * The in-progress TOTP enrollment (SettingsStates.dc.html "TOTP setup"): present
 * only while the owner is between "Enable two-factor" and a verified code.
 * `secret` is the base32 shown under the QR for manual entry — it is a
 * credential in flight, never persisted by a page and never logged (§15).
 */
export type TotpEnrollment = {
  /**
   * better-auth's own `otpauth://` string — what the QR below encodes, and what the two
   * fields under it are derived from. The card carries it forward in the verify form's
   * hidden `totpuri` because a refused code has to redraw THIS enrolment and the hub
   * cannot re-derive it: better-auth's `get-totp-uri` wants a password the card has not
   * got, and enabling a second time would rotate the secret the owner has already
   * scanned. A form field, never a URL (§15) — and validated again on the way back in
   * (`enrollmentOf`), because a hidden input is hand-postable.
   */
  totpUri: string;
  /** The otpauth:// QR as a self-contained data: URI — no external image fetch. */
  qrDataUri: string;
  /** The same secret in its grouped display form: "JBSW Y3DP EHPK 3PXP". */
  secret: string;
  /** Set when a submitted code did not verify. */
  error: string | null;
};

/**
 * The enrolment above, built out of better-auth's own `otpauth://` URI — the ONE producer
 * of all three fields, so the QR and the grouped secret cannot disagree about what was
 * minted. The grouped form is that URI's own `secret` parameter, which better-auth writes
 * as unpadded base32 (`@better-auth/utils`' `base32.encode(secret, { padding: false })`) —
 * exactly what an authenticator wants typed in — cut into fours for reading aloud.
 *
 * It VALIDATES, because the URI is also a hidden field the refusal arm echoes back out of
 * the posted form (web.ts's `reveal`): a hand-posted value would otherwise draw arbitrary
 * text and an arbitrary QR under "scan this", and neither is an enrolment. `null` means
 * there is nothing to redraw — web.ts answers with the flash instead.
 */
export function enrollmentOf(totpuri: string, error: string | null): TotpEnrollment | null {
  let uri: URL;
  try {
    uri = new URL(totpuri);
  } catch {
    return null;
  }
  const secret = uri.searchParams.get("secret") ?? "";
  // The length bound is `renderSVG`'s: it THROWS above the QR's capacity (measured on uqr
  // 0.1.3: ~2.9 KB), so without it a hand-posted 3 KB `totpuri` escapes this function's
  // "enrolment or null" contract as an uncaught 500. A real otpauth:// URI is ~120 chars.
  if (uri.protocol !== "otpauth:" || uri.host !== "totp" || secret === "" || totpuri.length > 512) {
    return null;
  }
  return {
    totpUri: totpuri,
    // The URI itself is the payload a camera reads; the SVG is inlined so the card fetches
    // nothing (§15 — a secret does not become an image request to anywhere).
    qrDataUri: `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(totpuri))}`,
    secret: (secret.match(/.{1,4}/g) ?? []).join(" "),
    error,
  };
}

/**
 * The ten codes a reveal draws — the same reason `enrollmentOf` validates: one of the two
 * answers carrying them is a hand-postable hidden field, and without a rule an arbitrary
 * string renders under "Store these somewhere safe". The shape is better-auth's own
 * generator's (`backup-codes`: two five-character alphanumeric halves), and the count is
 * the ten it always mints; anything else is not that set and is drawn as nothing at all.
 *
 * It takes the set already decoded, because there is no ONE wire format to decode: one
 * caller holds a JSON array and the other a newline-joined form field. Both live in
 * web.ts (`answeredCodes`, `postedCodes`); this judges what they hand over.
 */
export function revealedCodesOf(codes: readonly string[]): string[] | null {
  if (codes.length !== 10) return null;
  return codes.every((code) => /^[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}$/.test(code)) ? [...codes] : null;
}

/** One passkey row. Timestamps ISO-8601; `lastUsedAt` null until first sign-in (§5). */
export type PasskeyRow = {
  id: string;
  /** Owner-visible name as the authenticator reported it: "MacBook Touch ID". */
  name: string;
  addedAt: string;
  lastUsedAt: string | null;
};

/**
 * One active session. `source` separates the browser sessions from the ones the
 * device flow minted for the CLI — the distinction the row's second line makes
 * ("pmcp CLI · device flow") and the reason a CLI session can be revoked here
 * but can never reach this page (§4's session-scope guard).
 */
export type SessionRow = {
  id: string;
  /** User-agent-derived description: "Chrome on Windows". Untrusted display data. */
  client: string;
  source: "web" | "cli";
  createdAt: string;
  lastActiveAt: string;
  /** The session rendering this page: badged "current", never revocable from its own row. */
  current: boolean;
};

/**
 * The destructive confirmations of Dialogs.dc.html, as page state. Each carries
 * exactly what its copy names — the passkey's name, the session's label — so the
 * dialog never has to look anything up.
 */
export type SettingsConfirm =
  | { kind: "disable-two-factor" }
  | { kind: "remove-passkey"; id: string; name: string }
  /** `label` is the row's own `sessionLabel`, carried so the dialog title and the
   *  row it names cannot spell the session two different ways. */
  | { kind: "revoke-session"; id: string; label: string }
  /** **Revoke all others** names no row — it is about every session except this one. */
  | { kind: "revoke-other-sessions" }
  | { kind: "revoke-connection"; id: string; client: string };

/**
 * §13's "Refusals, mapped to fields": which of the Password pane's three controls the
 * last refusal was about. The FIELD travels — never the sentence — because the sentence
 * is the pane's own copy: web.ts maps better-auth's error CODE onto one of these names,
 * settings.tsx says the words, and neither drifts into the other's business.
 */
export const PASSWORD_FIELDS = ["currentPassword", "newPassword", "confirmPassword"] as const;
export type PasswordField = (typeof PASSWORD_FIELDS)[number];

/**
 * The redirect-back flash's own query keys — the protocol web.ts WRITES after every
 * mutation and the pages READ on the next render. Both halves spell them from here, so
 * the two cannot drift apart silently: a renamed key that only one side knew about is a
 * control that quietly stops highlighting rather than a compile error.
 */
export const NOTICE_KEYS = {
  done: "done",
  failed: "failed",
  reason: "reason",
  /** The Password pane's extra: which control a mapped refusal was about (§13). */
  field: "field",
  /** The Password pane's extra: how many sessions a successful change ended (§13). */
  signedOut: "signedOut",
} as const;

/**
 * Which of §13's seven panes is being rendered. A pane is a route, so this is also which
 * URL was asked for and which rail entry is `aria-current="page"` — one value, read
 * from the path by web.ts and never from a query parameter.
 */
export type SettingsPane =
  | "password"
  | "two-factor"
  | "passkeys"
  | "sessions"
  | "tokens"
  | "clients"
  | "execution";

/** The seven panes in rail order, and the URL each answers at — §13's own table, which
 *  is also the mobile pill row's order. `label` is the rail's; `short` is the pill's, and
 *  differs for exactly one pane (§13: "Mobile pills shorten only the last label"). */
export const SETTINGS_PANES: readonly {
  pane: SettingsPane;
  href: string;
  label: string;
  short: string;
  group: "Sign-in" | "Access" | "Runtime";
}[] = [
  { pane: "password", href: paths.settings, label: "Password", short: "Password", group: "Sign-in" },
  { pane: "two-factor", href: paths.settingsTwoFactor, label: "Two-factor", short: "Two-factor", group: "Sign-in" },
  { pane: "passkeys", href: paths.settingsPasskeys, label: "Passkeys", short: "Passkeys", group: "Sign-in" },
  { pane: "sessions", href: paths.settingsSessions, label: "Sessions", short: "Sessions", group: "Access" },
  { pane: "tokens", href: paths.settingsTokens, label: "Tokens", short: "Tokens", group: "Access" },
  { pane: "clients", href: paths.settingsClients, label: "Connected clients", short: "Clients", group: "Access" },
  { pane: "execution", href: paths.settingsExecution, label: "Execution", short: "Execution", group: "Runtime" },
];

/**
 * Which pane OWNS each destructive confirmation — where its link is drawn, where its
 * dialog opens, and where its POST redirects back to (§13's "Confirm-dialog state rides
 * the owning pane's URL"). One table, so a dialog cannot be opened on a pane that draws
 * no control for it: the same query on another pane's URL is no dialog at all.
 */
export const SETTINGS_CONFIRM_PANE: Record<SettingsConfirm["kind"], SettingsPane> = {
  "disable-two-factor": "two-factor",
  "remove-passkey": "passkeys",
  "revoke-session": "sessions",
  "revoke-other-sessions": "sessions",
  "revoke-connection": "clients",
};

/** One row of the Tokens pane — `token_list`'s own shape (§8, unchanged), narrowed to
 *  what §13's columns draw. `expired` is derived from `expiresAt` against the render
 *  instant here rather than in the template, because it also chooses the control's word
 *  (live → Revoke, expired → Remove) and both must read one answer. */
export type TokenRow = {
  id: string;
  prefix: string;
  kind: "agent" | "app";
  boundTo: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  expired: boolean;
};

/**
 * /settings — the pinned parity exception (§8) for its Sign-in panes and Sessions:
 * credential management rides better-auth's endpoints and has no pmcp tool, and §4's
 * guards reject bearer-sourced sessions on every route under the prefix.
 *
 * ONE shape for all seven panes, and that is the point of §13's shell rule: the rail's
 * markers are the LENGTHS of the very lists the panes render, so they are read off these
 * fields rather than counted a second way. `pane` says which one is drawn; everything
 * else is present on every render because the rail is.
 *
 * `enrollment` and `revealedBackupCodes` are transient overlays on top of
 * `twoFactor`, not alternatives to it: enrollment can only be non-null while
 * `twoFactor.enabled` is false, and a fresh code set is revealed exactly once —
 * after enabling or regenerating — because nothing can show it again (§4).
 */
export type SettingsProps = ShellProps & {
  section: "settings";
  pane: SettingsPane;
  csrfToken: string;
  twoFactor: TwoFactorSummary;
  enrollment: TotpEnrollment | null;
  revealedBackupCodes: string[] | null;
  passkeys: PasskeyRow[];
  sessions: SessionRow[];
  tokens: TokenRow[];
  /**
   * §13's **All · Agents · Apps** filter (`?kind=agent|app`), or null for All. The
   * narrowing is the PAGE's — `token_list` takes no filter and stays unchanged (§8) — and
   * it narrows the TABLE only: `tokens` above is the whole listed set, so the rail's
   * marker cannot move when a pill is clicked.
   */
  tokenKind: TokenRow["kind"] | null;
  connections: ConnectionRow[];
  confirm: SettingsConfirm | null;
  /** The control §13 maps the last change-password refusal onto, or null (`PasswordField`). */
  passwordError: PasswordField | null;
  /**
   * §23.3's committed timeout pair for this owner — `hub_settings_get`'s answer, read on
   * every pane render like the rest of the shell, and what the Execution rail marker and
   * the Execution pane's readback both draw. Milliseconds.
   */
  execution: SettingsExecution;
  /**
   * The Execution pane's two controls as they are drawn. A GET fills them from
   * `execution`; a refused save fills them from what the owner typed, with the op's
   * message under the field it named (`settingsProps`'s `submitted`).
   */
  executionForm: SettingsExecutionForm;
};

/** §23.3 — the owner's hub execution timeout pair, in milliseconds, as `hub_settings_get`
 *  and the Execution pane both read it: `defaultTimeoutMs` is what an `execute` without
 *  `timeout_ms` gets, `maxTimeoutMs` the largest a program may request. */
export type SettingsExecution = { defaultTimeoutMs: number; maxTimeoutMs: number };

/**
 * `GET /api/hub/settings` (routes §2, decision 38) — ONE read for the rail and every pane,
 * §13's shell rule: each rail marker is a LENGTH of a list here (or, for Two-factor, the
 * status), so no marker is a second query that could disagree with its pane. It carries
 * only what a GET of the old pages drew from the server; what they derived from their own
 * URL — the pane, `?confirm=`, `?kind=`, the flash, `?field=` — is the client's.
 */
export type SettingsRead = {
  twoFactor: TwoFactorSummary;
  passkeys: PasskeyRow[];
  /** Every session of the owner, `current` marking the one asking; never a session
   *  TOKEN (§15) — `BetterAuthSession` does not name the column. */
  sessions: SessionRow[];
  /** `token_list` minus revoked rows, `expired` judged at read time (`TokenRow`). */
  tokens: TokenRow[];
  /** `connection_list` unchanged, revoked rows included (§13's Connected clients). */
  connections: ConnectionRow[];
  execution: SettingsExecution;
  /** Configuration the panes print, so the page holds no second literal of it (§4/§23):
   *  better-auth's configured minimum password length, and §23.3's inclusive bounds on
   *  both timeouts, in milliseconds. */
  limits: { passwordMinLength: number; minTimeoutMs: number; maxTimeoutMs: number };
};

/**
 * The Execution pane's form state, one field per control plus the whole-form slot for a
 * refusal that names neither (the pair's ORDERING — "default must not exceed max" — is
 * about both fields at once, though the op still names `default_timeout_ms` for it).
 * `defaults`/`maximum` are the control VALUES as strings, because a refused save redraws
 * the owner's own text rather than the pair it refused to replace.
 */
export type SettingsExecutionForm = {
  defaults: string;
  maximum: string;
  errors: Partial<Record<"defaults" | "maximum" | "form", string>>;
};

/** §13's Execution rail marker and the pane's readback line: the pair in SECONDS where the
 *  millisecond value divides evenly, and in milliseconds where it does not — the rail
 *  column is a glance, and a value the reader would have to convert is not one. */
export function timeoutLabel(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

/* ------------------------------------------------------------------ *
 * /approvals
 * ------------------------------------------------------------------ */

/**
 * /approvals. Both lists are approvals.list rows unchanged — arguments already
 * post-redaction, because that is the only form ever stored (§7) — split by the
 * one thing that changes their presentation: a pending row has buttons, a
 * decided row is a history line.
 *
 * The history section is capped, not paged: approval_list takes `limit` and no
 * offset (§8), so "Showing last N decisions · Older →" widens the same limit.
 */
export type ApprovalsProps = ShellProps & {
  section: "approvals";
  csrfToken: string;
  /** status "pending", newest first; `pendingApprovals` must equal its length. */
  pending: ApprovalRow[];
  /** Everything decided, expired, or spent — newest first. */
  history: ApprovalRow[];
  /** The limit `history` was read under: the N in "Showing last N decisions". */
  historyLimit: number;
  /** True when the ledger holds decisions beyond `historyLimit` ("Older →"). */
  hasMoreHistory: boolean;
  /**
   * The VAPID public key the "Enable notifications" control hands to
   * PushManager.subscribe (§13). Whether THIS browser is already subscribed is
   * knowable only in the browser, so it is deliberately not a prop — the server
   * knows endpoints, not which one is asking.
   */
  vapidPublicKey: string;
};

/* ------------------------------------------------------------------ *
 * /approvals/<id>
 * ------------------------------------------------------------------ */

/**
 * /approvals/<id> — the page a -32003 error hands an agent's user (§7).
 * Chromeless: it is opened from a push notification or an error string, often on
 * a phone, and its job is one decision.
 *
 * `approval.status` alone selects the presentation (ApprovalStates.dc.html):
 * "pending" shows Approve/Reject, and every other status renders read-only with
 * its own explanation — "approved" is a pass waiting for the agent's identical
 * retry, "used" was spent by one, "rejected"/"expired" are terminal and the
 * agent's next attempt opens a fresh request. Expiry is a read-time
 * interpretation upstream of this page, so a past-expiry row arrives already
 * reported as "expired" (§7).
 */
export type ApprovalDetailProps = PageProps & {
  csrfToken: string;
  approval: DetailApproval;
};

/**
 * The row as THIS page reads it. `ApprovalRow.decidedAt` is nullable because null is
 * honest for a pending row (approvals.ts owns that wire shape) — but "rejected" and
 * "used" are exactly the two statuses a decision writes, and both writers stamp
 * `decided_at` in the same statement, so on those two the page reads a string and the
 * "Decided —" arm has nothing to render. `approvalOf` makes the narrowing true, and
 * `GET /api/hub/approvals/<id>` answers this shape (api.ts's `ApprovalDetailRead`).
 */
export type DetailApproval =
  | (ApprovalRow & { status: Exclude<ApprovalStatus, "rejected" | "used"> })
  | (ApprovalRow & { status: "rejected" | "used"; decidedAt: string });

/**
 * Re-exported so a template can spell the status vocabulary it switches on
 * without importing across module boundaries the page layer otherwise does not
 * touch. Same type, one import site.
 */
export type { ApprovalRow, ApprovalStatus };

/* ------------------------------------------------------------------ *
 * /audit — the ledger's read shapes (the PAGE is the SPA's, decision 36)
 * ------------------------------------------------------------------ */

/**
 * The time window as a link may still spell it (`?range=`): a readable window ending now,
 * kept because the agent page, the app page and old bookmarks emit it. "custom" means the
 * window came from an explicit since/until pair instead.
 */
export type AuditRange = "1h" | "24h" | "7d" | "30d" | "custom";

/**
 * A caller's audit link, resolved — `audit_query`'s filters (§8) with limit and offset
 * defaulted, plus the preset the window came from. `since`/`until` stay epoch milliseconds,
 * as AuditQuery states them, and are always set, so the read covers exactly one window.
 * This is what `/api/hub/audit` (the agent page's Activity pane) parses; §13's explorer
 * parses its own state in the browser and reaches the ledger through the two reads in
 * api.ts instead.
 */
export type AuditFilters = Pick<
  AuditQuery,
  "principal" | "app" | "event" | "tool" | "session"
> & {
  range: AuditRange;
  since: number;
  until: number;
  limit: number;
  offset: number;
};

/**
 * A recorded body as a reader renders it: the masked JSON object, or one whole-body
 * BodyStub when the body was over the cap and was replaced entire (§15). A renderer shows
 * stubs as typed size placeholders (‹blob image/png · 4.2 MB›, ‹oversize · 2.1 MB›) and
 * never anything resembling bytes.
 */
export type RecordedBody = Record<string, unknown> | BodyStub;

/**
 * One audit row as a reader of the owner's own namespace sees it: audit.query's row minus
 * the namespace id (every row here belongs to the viewer's own — carrying it would only
 * invite rendering it) and with the two body columns typed for what they can actually hold.
 * What `GET /api/hub/audit/:id` answers with, and what the agent page's Activity pane
 * reads.
 */
export type AuditEventRow = Omit<AuditRow, "ownerId" | "args" | "result"> & {
  args?: RecordedBody;
  result?: RecordedBody;
  /**
   * Why a CALL row carries no bodies (§13/§15) — set only on the events that can carry
   * them (`tools/call` and §20's audited reads) and only when both body columns are
   * absent, so the page can say it in one sentence instead of drawing a blank panel:
   * `refused` (a refusal outcome — checked first, because a refusal never had bodies
   * whatever the app's setting), `off` (the app's `log_bodies` is off NOW), or
   * `unrecorded` (recorded before logging was switched on, or the app is gone).
   */
  noBodies?: "off" | "refused" | "unrecorded";
};

/* ------------------------------------------------------------------ *
 * /oauth/consent (§19.5)
 * ------------------------------------------------------------------ */

/** One entry of the agent `<select>`, defaulted to nothing (§19.5). */
export type ConsentAgentOption = { slug: string; name: string };

/**
 * `GET /api/hub/oauth/consent`'s answer (decision 38) — exactly what §19.5 step 3's screen
 * shows or its form echoes, and nothing else. Every field is either the SIGNED `oauth_query`
 * echoed verbatim (§19.5 step 2 — the screen cannot invent, drop or edit a parameter) or a
 * value read out of the SAME verified query, through the provider's own
 * `/oauth2/public-client-prelogin` (which re-checks the signature, §19.5 step 2's blocking
 * probe observation).
 */
export type ConsentRead = {
  /** The whole signed query, byte-for-byte, as THIS request carried it — the value the
   *  consent form posts back, so the bytes posted are the bytes the provider verified. */
  oauthQuery: string;
  /** The client's own self-chosen name — untrusted, rendered as text, never markup. `null`
   *  when the client registered without one. */
  clientName: string | null;
  /** §19.3: no `userId` on the client's row means it registered itself through the
   *  anonymous DCR endpoint — the "registered itself, identity unverified" marker. */
  clientSelfRegistered: boolean;
  /** The ORIGIN of `redirect_uri` — the one attacker-controlled string that actually
   *  decides where the authorization code goes (§19.5 step 3). */
  redirectOrigin: string;
  /** The requested scopes, space-split — today always exactly `["mcp"]` or with
   *  `offline_access` beside it (§19.3). */
  scopes: string[];
  /** The namespace the token will be audience-bound to, read off the request's `resource`. */
  namespace: string;
  /** Every agent in the namespace — `agent_list` unchanged (§8's parity
   *  invariant). Empty is the first-run path, not an edge case (§19.5's empty state). */
  agents: ConsentAgentOption[];
};

/**
 * /oauth/consent as the retained template draws it (ruling §5.2 keeps it for the states
 * preview until family 5): the read, plus the render instant and the form's CSRF token.
 * Chromeless, like /login and /device: reached from the provider's own redirect.
 */
export type ConsentProps = PageProps & ConsentRead & { csrfToken: string };

/* ------------------------------------------------------------------ *
 * The Connected clients pane's rows (§19.6/§8/§13)
 * ------------------------------------------------------------------ */

/** One row of the connections list — `connection_list`'s own shape (oauth.ts's
 *  `Connection`), unchanged (§8's parity invariant): never a token, a client secret, or a
 *  JWT, because a connection is a binding and a binding holds no credential. */
export type ConnectionRow = {
  id: string;
  clientId: string;
  clientName: string | null;
  agentSlug: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** Set once revoked (§19.6). The op speaks timestamps; §13's `Status` column is this
   *  field's two shapes, and a revoked row stays listed with no control. */
  revokedAt: number | null;
  /** The ORIGIN of the client's registered redirect URI — never the whole URI (§13). */
  redirectOrigin: string;
  /** §19.3's DCR marker, drawn as the `unverified` badge beside the name. */
  selfRegistered: boolean;
};

/* ------------------------------------------------------------------ *
 * The page set
 * ------------------------------------------------------------------ */

/**
 * Page name → its props. The one place the set of pages is enumerated: the
 * fixture registry is keyed by it and the dev preview walks it, so a page added
 * without a fixture is a type error rather than a gap noticed later.
 */
export type PagePropsByName = {
  login: LoginProps;
  device: DeviceProps;
  settings: SettingsProps;
  approvals: ApprovalsProps;
  "approval-detail": ApprovalDetailProps;
  /** Chromeless and reached only from the provider's redirect — but a §13 page with two
   *  boards all the same, so it is enumerated here like every other (`/oauth/consent`). */
  "oauth-consent": ConsentProps;
};

/** Every page key of §13, as a type. */
export type PageName = keyof PagePropsByName;

/* ------------------------------------------------------------------ *
 * The loaders — one per page, props out of the ops table
 * ------------------------------------------------------------------ */

/**
 * What every loader is handed. Who is asking has ALREADY been proven — web.ts
 * runs identity's cookie-session gate before a loader is entered, and
 * `ownerId` is that session's user — so no loader re-checks ownership, exactly
 * like an ops handler. `query` is the request's own query string, which is the
 * page's whole input: every read control on every page is a GET (§13).
 */
export type PageContext = {
  ownerId: string;
  username: string;
  csrfToken: string;
  /** ISO-8601: the render instant, and the only clock any template reads. */
  now: string;
  query: URLSearchParams;
};

/**
 * One ops handler, by name — the single door every read below goes through. The
 * type parameter is the caller's claim about a result shape `admin.ts` owns and
 * nothing here re-derives; a name that is not in the table is a bug in this
 * file, never a caller's input, so it throws rather than refusing.
 */
async function read<T>(
  ctx: { ownerId: string },
  name: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  const op = Object.prototype.hasOwnProperty.call(ops, name) ? ops[name] : undefined;
  if (op === undefined) throw new Error(`pages: no such admin op "${name}"`);
  return (await op.handler(ctx.ownerId, input)) as T;
}

/* ------------------- the grant set, parsed and composed ------------------- */

/** The one three-way choice a row's control carries: `none` is the absence of an entry,
 *  and the other two are §8's wire spellings (`<entry>` and `<entry>:approval`). */
export type GrantChoice = "none" | "allow" | "approval";

/** §2's reserved role: granted like any other, declared by nobody, and the one the
 *  listing marks `built-in`. */
const BUILTIN_ROLE = "all";

/** The per-row control's field prefix. Spelled ONCE, here, because this form is the one
 *  whose fields are not the op's keys (§13) and both halves of that translation — the
 *  page that writes the control and the route that reads it — must agree. */
const ENTRY_FIELD_PREFIX = "e.";

/**
 * The submitted form as the choice per entry — the inverse of `entryField`, so a field
 * this page did not draw contributes nothing. Two fields that are not per-row controls
 * are folded in here rather than in the composer, so a REFUSED save redraws the pattern
 * the owner just added and the `×` they just pressed rather than losing both: `add`
 * (the pattern offer, with its pressed button's `mode`) and `drop` (the `×` buttons).
 */
export function grantChoicesOf(fields: Record<string, string>): Record<string, GrantChoice> {
  const choices: Record<string, GrantChoice> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (!name.startsWith(ENTRY_FIELD_PREFIX)) continue;
    choices[name.slice(ENTRY_FIELD_PREFIX.length)] = value === "allow" || value === "approval" ? value : "none";
  }
  // The offer's entry rides a HIDDEN field, so it is submitted by every button on the
  // pane — Save and each `×` included. `mode` is the only thing that says the owner
  // pressed Ask or Allow, so an absent or unrecognised one means no offer was accepted
  // and the entry must not be added.
  const added = fields.add ?? "";
  const mode = fields.mode ?? "";
  if (added !== "" && (mode === "allow" || mode === "approval")) choices[added] = mode;
  const dropped = fields.drop ?? "";
  if (dropped !== "") choices[dropped] = "none";
  return choices;
}

/** `grant_set`'s `roles` argument, composed from those choices: the bare entry for allow
 *  and its `:approval` suffix for the other, with `none` contributing nothing at all —
 *  which is how the pane revokes (the op replaces the pair's whole set). */
export function composeRoles(choices: Record<string, GrantChoice>): string[] {
  return Object.entries(choices)
    .filter(([, choice]) => choice !== "none")
    .map(([entry, choice]) => (choice === "approval" ? `${entry}:approval` : entry));
}

/**
 * Whether a pattern names exactly ONE item — the test that sorts an inline entry into its
 * family's own rows rather than into `Patterns`, and decides whether typed filter text is
 * offered as a pattern at all.
 *
 * Cross-module: registry's `isLiteralPattern` is the same rule at the DOOR, and is
 * deliberately private there (§20.3 owns the grammar). This is the page's reading of it;
 * the two must move together, and registry's `matchesPattern` comment is the home.
 */
function isOneItem(pattern: string, family: RoleFamily): boolean {
  return family === "resources" ? !/[*+?()[\]{}|^$\\]/.test(pattern) : /^[A-Za-z0-9._-]+$/.test(pattern);
}

/** §20.3's canonical read shape as the per-family object every builder here works in —
 *  the bare array being the tools-only shorthand. */
function familiesOf(patterns: string[] | FamilyPatterns | undefined): FamilyPatterns {
  if (patterns === undefined) return {};
  if (Array.isArray(patterns)) return { tools: patterns };
  return patterns;
}

/* ------------------------ the four forms, composed ------------------------- */

/**
 * §4's Save, composed: the STORED owner map with the edited role replaced by the stored
 * role plus the deltas of the rows the form says it drew, and `was` removed — or `was`
 * removed alone on `delete`. ONE `app_update` comes out of it, and which field it writes is
 * the kind's (`owner_roles` tunneled, `roles` proxied), never both.
 *
 * `drawn` is the render's own account of itself: one `row=<family>/<name>` per item row
 * that carried a checkbox. A literal named there takes its new value from its `i.` box; a
 * literal NOT named keeps whatever is stored. That is what makes the filter safe — `?q=`
 * hides rows, and a hidden row is not an unticked one — and what makes an unreadable
 * catalog safe: it draws no rows at all, so a save then changes no literal.
 *
 * Pure: web.ts reads the stored map and posts the op, this decides only what the map
 * becomes — which is what lets a refusal redraw the editor on `families` unchanged.
 */
export function composeOwnerRoles(
  stored: RoleDeclaration,
  /** The APP's own declaration — empty on a proxied app, which declares none (§1). A name
   *  in it cannot be an owner role: the app's declaration would replace it on sight. */
  declared: RoleDeclaration,
  fields: Record<string, string>,
  keeps: string[],
  drawn: string[],
): {
  role: string;
  was: string;
  families: FamilyPatterns;
  roles: RoleDeclaration;
  deleted: boolean;
  /** Why this save cannot be sent at all, or null. Two of the three refusals §4 names are
   *  the page's own, because the OP never sees what it would refuse: an empty name is a
   *  name it is not given (the map would simply not gain a key, and it would answer 200 to
   *  a save that saved nothing), and a collision is two maps it is only given one of. */
  refusal: string | null;
} {
  const was = fields.was ?? "";
  const role = (fields.role ?? "").trim();
  const roles: RoleDeclaration = { ...stored };
  if (was !== "") delete roles[was];
  if (fields.delete === "1") {
    return { role: was, was, families: {}, roles, deleted: true, refusal: null };
  }
  const families = familiesFrom(familiesOf(stored[was]), fields, keeps, drawn);
  const refusal =
    !ROLE_NAME.test(role) || role === BUILTIN_ROLE
      ? ROLE_NAME_REFUSAL
      : Object.prototype.hasOwnProperty.call(declared, role)
        ? `${role} is declared by the app — its declaration would replace yours`
        : null;
  if (refusal !== null) return { role, was, families, roles, deleted: false, refusal };
  roles[role] = families;
  return { role, was, families, roles, deleted: false, refusal: null };
}

/** A role name: the charset the editor's own `pattern` attribute declares, and `all`, which
 *  §2 reserves — granted like any other role, declared by nobody. */
const ROLE_NAME = /^[a-z0-9_-]+$/;

const ROLE_NAME_REFUSAL = "a role name is [a-z0-9_-], and all is reserved";

/**
 * The role's new patterns: the STORED ones, with each drawn literal set from its checkbox,
 * and the pattern rows the form carried (`keep`) minus the one `drop` named plus whatever
 * `add` offered.
 *
 * Literals and patterns share one list per family (§20.3), so they are told apart the way
 * the door tells them apart — `isOneItem` — rather than by a second stored field.
 */
function familiesFrom(
  base: FamilyPatterns,
  fields: Record<string, string>,
  keeps: string[],
  drawn: string[],
): FamilyPatterns {
  const literals = new Map<RoleFamily, string[]>();
  const patterns = new Map<RoleFamily, string[]>();
  for (const family of ROLE_FAMILIES) {
    const held = base[family] ?? [];
    literals.set(family, held.filter((each) => isOneItem(each, family)));
    patterns.set(family, held.filter((each) => !isOneItem(each, family)));
  }

  const push = (map: Map<RoleFamily, string[]>, family: RoleFamily, value: string): void => {
    const list = map.get(family) ?? [];
    if (!list.includes(value)) list.push(value);
    map.set(family, list);
  };
  const split = (entry: string): { family: RoleFamily; rest: string } | null => {
    const cut = entry.indexOf("/");
    if (cut < 0) return null;
    const family = entry.slice(0, cut) as RoleFamily;
    if (!(ROLE_FAMILIES as readonly string[]).includes(family)) return null;
    return { family, rest: entry.slice(cut + 1) };
  };

  // A TICK adds whatever it names, drawn or not: a box that came back ticked is a choice
  // the owner made, and a refusal has to redraw it or the reason they are being shown costs
  // them the work. Adding is also the safe direction — the narrowing one is removal.
  for (const [name, value] of Object.entries(fields)) {
    if (!name.startsWith(ROLE_ITEM_PREFIX) || value !== "1") continue;
    const at = split(name.slice(ROLE_ITEM_PREFIX.length));
    if (at !== null) push(literals, at.family, at.rest);
  }
  // A REMOVAL needs the row that drew it: a row the filter hid, and every row of a catalog
  // that could not be read, is not an unticked one — it is simply not here.
  for (const row of drawn) {
    const at = split(row);
    if (at === null || fields[`${ROLE_ITEM_PREFIX}${row}`] === "1") continue;
    literals.set(at.family, (literals.get(at.family) ?? []).filter((each) => each !== at.rest));
  }

  const dropped = fields.drop ?? "";
  for (const keep of keeps) {
    if (keep === dropped) continue;
    const at = split(keep);
    if (at !== null) push(patterns, at.family, at.rest);
  }
  const droppedAt = split(dropped);
  if (droppedAt !== null) {
    patterns.set(droppedAt.family, (patterns.get(droppedAt.family) ?? []).filter((each) => each !== droppedAt.rest));
  }
  const added = (fields.add ?? "").trim();
  if (added !== "") push(patterns, added.includes("://") ? "resources" : "tools", added);

  // Sorted, so one role saved twice from two different renders is byte-identical: a family
  // list is a SET (§20.3 matches it, never walks it), and leaving it in the order the rows
  // happened to be drawn in would make the stored map depend on the filter that drew them.
  const families: FamilyPatterns = {};
  for (const family of ROLE_FAMILIES) {
    const all = [...(literals.get(family) ?? []), ...(patterns.get(family) ?? [])].sort();
    if (all.length > 0) families[family] = all;
  }
  return families;
}

/** The role editor's per-item checkbox prefix — `i.<family>/<name>`. Spelled ONCE, here,
 *  because the page that writes the control and the route that reads it must agree. */
const ROLE_ITEM_PREFIX = "i.";

/**
 * §5's Save, composed: the STORED maps with the drawn rows' deltas applied, and nothing
 * else touched.
 *
 * `drawn` is the render's own account of itself — one `(path, tools)` pair per path row,
 * carried on the form as hidden `t.<dir>.<path>=<tool>` fields. A pair named there takes
 * its new value from the form; a pair not named keeps whatever is stored. That is what
 * makes every one of the ways a render and a save can disagree harmless: a path the filter
 * hid, a tool the upstream stopped listing between the two requests, an entry added from
 * evidence that no schema declares, a pattern key. None of them is drawn, so none of them
 * moves.
 *
 * No catalog read happens here, deliberately: one taken at POST time is a DIFFERENT answer
 * from the one the form was drawn against — an upstream that 503s in between, or a
 * reconnect that renames a tool, would have made the save compose a map for rows nobody
 * saw. The form carries what the render covered; the save trusts nothing else.
 *
 * A writeOnly pair is never drawn (§7 masks it regardless), so it never enters the config —
 * the hub does not author a declaration it did not make.
 */
export function composeRedaction(
  stored: Record<string, string[]>,
  dir: "args" | "results",
  fields: Record<string, string>,
  drawn: [path: string, tools: string[]][],
): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const [tool, paths] of Object.entries(stored)) map[tool] = [...paths];
  const set = (tool: string, path: string, on: boolean): void => {
    const list = (map[tool] ?? []).filter((each) => each !== path);
    if (on) list.push(path);
    if (list.length === 0) delete map[tool];
    else map[tool] = list;
  };
  for (const [path, tools] of drawn) {
    // The path control says "all of them"; a per-tool row is the finer statement and adds
    // to it. Both are ORed, so a row expanded by `which=` — which draws both — cannot have
    // one silently cancel the other.
    const wholePath = fields[`p.${dir}.${path}`] === "1";
    for (const tool of tools) {
      set(tool, path, wholePath || fields[`m.${dir}.${tool}.${path}`] === "1");
    }
  }
  return map;
}

/* --------------------------- §23.6's alias editor --------------------------- */

/**
 * The alias editor's field names, spelled ONCE so the pages that draw the controls and the
 * routes that read them cannot drift: the service control, and each row's two controls as
 * `canonical.<i>` / `alias.<i>`, paired by index. Indexed rather than named by canonical
 * name because a canonical name is arbitrary upstream text, while an index is always a
 * safe field name.
 */
const ALIAS_SERVICE_FIELD = "typescript_service";
const ALIAS_CANONICAL_PREFIX = "canonical.";
const ALIAS_ALIAS_PREFIX = "alias.";

/**
 * §23.6's Save, composed from the editor's fields: the service control plus the rows, as
 * the `typescript_aliases` object `app_create` / `app_update` take. Omission is the point
 * of the shape — a blank control contributes no key, so a save never clears a name the hub
 * already established (registry's planner keeps it; only typing a DIFFERENT alias moves
 * it), and a blank row contributes nothing at all.
 *
 * Every value is passed through BYTE FOR BYTE, deliberately: a canonical name is the
 * upstream's own identity and the hub never rewrites it, and an alias with surrounding
 * whitespace is a syntax mistake the op's grammar must refuse — trimming here would store
 * a name nobody typed and swallow the reason to refuse. Only an EXACTLY empty control is
 * omitted, so a whitespace-only one still reaches the op and fails its grammar.
 *
 * Returns the editor's own one refusal, or the composed value. Syntax (the identifier
 * grammar, the reserved names) and collisions are NOT judged here: the op is the authority
 * for both, and its violation carries the sentence the surface redraws.
 */
export function composeTypescriptAliases(
  fields: Record<string, string>,
): { aliases: TypescriptAliases } | { error: string } {
  const service = fields[ALIAS_SERVICE_FIELD] ?? "";
  const tools: Record<string, string> = {};
  const indices = Object.keys(fields)
    .filter((name) => name.startsWith(ALIAS_CANONICAL_PREFIX))
    .map((name) => name.slice(ALIAS_CANONICAL_PREFIX.length))
    .filter((index) => /^\d+$/.test(index))
    .sort((left, right) => Number(left) - Number(right));
  for (const index of indices) {
    const canonicalName = fields[`${ALIAS_CANONICAL_PREFIX}${index}`] ?? "";
    const alias = fields[`${ALIAS_ALIAS_PREFIX}${index}`] ?? "";
    // A spare row the owner never touched. Blanking an alias on a prefilled row is NOT
    // this: its canonical name is still there, and the omission is the save's own answer.
    if (canonicalName === "" && alias === "") continue;
    if (canonicalName === "") {
      return { error: "a tool alias needs its canonical tool name — the upstream name it renames" };
    }
    if (alias === "") continue;
    if (Object.prototype.hasOwnProperty.call(tools, canonicalName)) {
      return { error: `"${canonicalName}" is listed twice — one row per canonical tool name` };
    }
    tools[canonicalName] = alias;
  }
  return {
    aliases: {
      ...(service === "" ? {} : { service }),
      ...(Object.keys(tools).length === 0 ? {} : { tools }),
    },
  };
}

/* -------------------------------- /approvals ---------------------------------- */
//
// The list page's read — the pending rows, then the history asked one past its limit plus
// the pending count so "Older →" knows whether to render — is the client's since decision
// 38, over the two `GET /api/hub/approvals` resources (§13 `/approvals`). What stays here is
// the detail's lookup, which both the shell's document 404 and the JSON read make.

/**
 * One approval of `ownerId`'s, by id, as `/approvals/<id>` reads it — or null. The lookup
 * is the owner-scoped listing, so a row in another namespace is not in it at all: a foreign
 * id and an invented one are ONE answer (null), exactly as §7 wants them to be. Throws on a
 * broken ledger row (`decided`).
 */
export async function approvalOf(ownerId: string, id: string): Promise<DetailApproval | null> {
  const listed = await read<{ approvals: ApprovalRow[] }>({ ownerId }, "approval_list", {
    limit: APPROVAL_LOOKUP_LIMIT,
  });
  const approval = listed.approvals.find((row) => row.id === id);
  return approval === undefined ? null : decided(approval);
}

/** The one boundary check behind `DetailApproval`: a rejected or used row without a
 *  decision instant is a broken ledger, not a page state, so it is named rather than
 *  papered over with a dash the owner would have to interpret. */
function decided(row: ApprovalRow): DetailApproval {
  if (row.status !== "rejected" && row.status !== "used") return { ...row, status: row.status };
  if (row.decidedAt === null) {
    throw new Error(`approval ${row.id} is "${row.status}" with no decidedAt`);
  }
  return { ...row, status: row.status, decidedAt: row.decidedAt };
}

/** How deep the id lookup above reads. `approval_list` takes no id filter (§8),
 *  and retention (§15, days) is what bounds the table — so this is a memory
 *  bound on one lookup, not a policy about what exists. */
const APPROVAL_LOOKUP_LIMIT = 1000;

/* ---------------------------------- /audit ------------------------------------ */

/** The page size a link that names none gets — `/api/hub/audit`'s default, which is the
 *  Activity pane's page. */
const AUDIT_PAGE_SIZE = 50;

/** The window a link that carries no `range` and no usable since/until gets. */
const AUDIT_DEFAULT_RANGE = "24h" as const;

const RANGE_SPAN_MS: Record<Exclude<AuditRange, "custom">, number> = {
  "1h": 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

/**
 * One audit link's filter state, read off its own query string. `since`/`until` are
 * always resolved — a preset is a window, not a mode — so a caller never has to decide
 * what "no window" means.
 *
 * The parameter is narrowed to the two fields it reads rather than taken as a whole
 * PageContext, because the JSON API's `/api/hub/audit` route parses the same filters and
 * holds no page context — and widening it there would mean handing this a `csrfToken` and
 * a `notice` invented to satisfy a type.
 */
export function auditFilters(ctx: Pick<PageContext, "now" | "query">): AuditFilters {
  const now = Date.parse(ctx.now);
  const since = windowEdge(ctx.query.get("since"), "start");
  const until = windowEdge(ctx.query.get("until"), "end");
  // A pair that is absent, empty, half-typed or inverted is not a window: the form's own
  // hidden `range` (a preset key on a preset page, absent on a custom one) says which
  // preset to anchor to now instead, so a select's onchange, the pager and an untouched
  // Apply hand back the window the segment showed rather than a custom one.
  const preset = presetOf(ctx.query.get("range"));
  const window =
    since !== null && until !== null && until >= since
      ? { since, until, range: rangeOf(until - since) }
      : { since: now - RANGE_SPAN_MS[preset], until: now, range: preset };
  return {
    ...window,
    ...text(ctx.query, "principal"),
    ...text(ctx.query, "app"),
    ...text(ctx.query, "event"),
    ...text(ctx.query, "tool"),
    ...text(ctx.query, "session"),
    limit: positive(ctx.query.get("limit")) ?? AUDIT_PAGE_SIZE,
    offset: positive(ctx.query.get("offset")) ?? 0,
  };
}

/**
 * The filters as `audit_query` takes them — the link's state minus the three fields that
 * are the caller's own (`range` is which preset produced the window, `limit`/`offset` are
 * the page being looked at).
 */
export function auditQueryOf(filters: AuditFilters): AuditQuery {
  const { range: _range, limit: _limit, offset: _offset, ...query } = filters;
  return query;
}

/** The export's filters, or the one sentence the route refuses with — the whole parse has
 *  exactly two outcomes, and a caller that forgets the second cannot compile. */
export type AuditExportQuery =
  | { query: Omit<AuditQuery, "limit" | "offset" | "bodies"> }
  | { reason: string };

/**
 * The JSONL export's filters, read off its own query string (§13, decision 36) — what makes
 * the export a serialization of the one read rather than a second one.
 *
 * Three things differ from `auditFilters`, and all are about the export being a LINK rather
 * than a page. Each exact filter is read with `getAll`, so a repeated key is a list
 * (audit.AuditQuery's list form) and a single-valued old bookmark is the one-member list
 * that means the same thing — `outcome` among them, in RAW recorded codes, because a display
 * class is §13's own grouping and `denied` folds two. A repeated `target=<app>/<tool>` is a
 * PAIR, split at the FIRST slash: an app slug never holds one and a `tool` column may hold a
 * whole resource URI (§20.4), so the tool side keeps every slash it came with. And a link
 * that names no window at all gets NO bounds instead of a preset: an export is the archive
 * path (§15), so the honest default is everything the ledger still holds. `?range=` and a
 * since/until pair still narrow, since every deep link that carries one means it; `limit`,
 * `offset` and `expand` are ignored as they always were.
 *
 * REFUSES rather than ignores, twice, because both alternatives WIDEN a download: a `target`
 * that is not a pair, and a selection whose values would not fit one prepared statement
 * (limits.AUDIT_EXPORT_MAX_VALUES). An export that quietly carries rows the reader did not
 * select is the failure a ledger may not have, and a D1 error partway through a stream is
 * not a sentence anybody can act on.
 */
export function auditExportQuery(ctx: Pick<PageContext, "now" | "query">): AuditExportQuery {
  const named = ctx.query.get("range") !== null || ctx.query.get("since") !== null || ctx.query.get("until") !== null;
  const { since, until } = auditFilters(ctx);
  const lists: Record<string, string[]> = {};
  let bound = 0;
  for (const field of EXPORT_LIST_FILTERS) {
    const values = ctx.query.getAll(field).filter((value) => value !== "");
    if (values.length > 0) lists[field] = values;
    bound += values.length;
  }
  const targets: { app: string; tool: string }[] = [];
  for (const raw of ctx.query.getAll("target")) {
    const at = raw.indexOf("/");
    // Both sides non-empty: "news/" names no tool and "/get_news" no app, and either would
    // otherwise match nothing while reading like a filter that was applied.
    if (at <= 0 || at === raw.length - 1) return { reason: "Bad target." };
    targets.push({ app: raw.slice(0, at), tool: raw.slice(at + 1) });
  }
  // A pair binds two parameters, so it counts twice against the same bound.
  bound += targets.length * 2;
  if (bound > AUDIT_EXPORT_MAX_VALUES) {
    return { reason: "Too many filter values for one export — narrow the selection." };
  }
  const needle = ctx.query.get("text") ?? "";
  return {
    query: {
      ...(named ? { since, until } : {}),
      ...lists,
      ...(targets.length === 0 ? {} : { targets }),
      ...(needle.trim() === "" ? {} : { text: needle }),
    },
  };
}

/** The exact filters the export accepts REPEATED — `audit_query`'s six, spelled once. */
const EXPORT_LIST_FILTERS = ["principal", "app", "event", "tool", "session", "outcome"] as const;

/** Which preset a window came from — a span that matches one exactly IS that
 *  preset, and anything else is the custom range the date control renders. */
function rangeOf(span: number): AuditRange {
  const preset = (Object.keys(RANGE_SPAN_MS) as Exclude<AuditRange, "custom">[]).find(
    (key) => RANGE_SPAN_MS[key] === span,
  );
  return preset ?? "custom";
}

/**
 * One edge of the window, in either spelling the page emits: epoch ms as every rendered
 * link spells it (`positive`, unchanged, so §8's boundary parity is), or `YYYY-MM-DD` as
 * the form's two date inputs do — UTC midnight by the input's own spec. An `until` day
 * snaps to its LAST millisecond: `AuditQuery`'s bounds are inclusive, so a same-day pick
 * would otherwise name one instant and read as broken. Anything else is not an edge.
 */
function windowEdge(raw: string | null, edge: "start" | "end"): number | null {
  const ms = positive(raw);
  if (ms !== null) return ms;
  if (raw === null || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const day = Date.parse(raw);
  return Number.isNaN(day) ? null : edge === "end" ? day + 86_399_999 : day;
}

/** The form's hidden `range` as a preset key, or the default for anything else — a
 *  form-only spelling that never appears on a rendered link. */
function presetOf(raw: string | null): Exclude<AuditRange, "custom"> {
  return raw !== null && raw in RANGE_SPAN_MS ? (raw as Exclude<AuditRange, "custom">) : AUDIT_DEFAULT_RANGE;
}

/** One audit row as a reader of the owner's own namespace sees it: the namespace id dropped
 *  (every row here belongs to the viewer's own, and carrying it would only invite rendering
 *  it), plus why a call row carries no bodies. What `GET /api/hub/audit/:id` answers with. */
export function eventRow(row: AuditRow, logBodies: Map<string, boolean>): AuditEventRow {
  const { ownerId: _ownerId, args, result, ...rest } = row;
  const why = noBodiesReason(row, logBodies);
  return {
    ...rest,
    ...(args === undefined ? {} : { args: args as RecordedBody }),
    ...(result === undefined ? {} : { result: result as RecordedBody }),
    ...(why === undefined ? {} : { noBodies: why }),
  };
}

/**
 * The events that CAN carry bodies — `tools/call` plus §20's audited reads, which the
 * gateway records under their own method names (§20.4). Not the two subscription methods:
 * §21.6 records them like a read but they structurally carry none, so — like an auth or a
 * config row — they have no bodies to explain and draw no sentence.
 */
const BODY_EVENTS = new Set(["tools/call", "prompts/get", "resources/read"]);

/** §15's four refusal outcomes — a refusal never had bodies, whatever the app's setting. */
const REFUSAL_OUTCOMES = new Set(["-32000", "-32001", "-32002", "-32003"]);

/**
 * Why this row shows no bodies, or `undefined` when it has some or could never have had
 * any. The refusal check comes first for the reason §15 gives it: several refusals happen
 * before any redaction map exists, so no setting could have made bodies appear.
 *
 * Takes either reading of a row, because both readers owe the sentence: a FULL row has
 * bodies when either column parsed, and a SLIM one (decision 36) when it carries an
 * `argsHead` or reports a result — the two body columns seen through the projection that
 * never selected them (audit.AuditSlimRow).
 */
export function noBodiesReason(
  row: AuditRow | AuditSlimRow,
  logBodies: Map<string, boolean>,
): AuditEventRow["noBodies"] {
  const slim = row as AuditSlimRow;
  const full = row as AuditRow;
  const hasBodies =
    full.args !== undefined || full.result !== undefined || slim.argsHead !== undefined || slim.hasResult === true;
  if (!BODY_EVENTS.has(row.event) || hasBodies) return undefined;
  if (REFUSAL_OUTCOMES.has(row.outcome)) return "refused";
  return row.app !== undefined && logBodies.get(row.app) === false ? "off" : "unrecorded";
}

/* --------------------------------- /settings ----------------------------------- */

/**
 * `GET /api/hub/settings`'s answer (decision 38) — the one page whose state is
 * better-auth's rather than the ops table's, and §4 gives better-auth exactly one
 * custodian: identity. So this reads it the way the browser does, through identity's own
 * mounted endpoints, rather than reaching into tables that module owns. What the pages
 * derive from it — which pane, which dialog, which filter, which field a refusal named —
 * is the client's, off its own URL.
 *
 * Everything the rows say is sourced, and each from the one place that knows it: a
 * session's `source` is identity's own column, stamped by better-auth on the single
 * endpoint that mints a device-flow session (`sessionRow` says what a NULL one means);
 * a passkey's name comes from the plugin's listing, and its `lastUsedAt` from §5's own
 * column, read here through `identity.passkeyLastUsed` — absent means never used.
 *
 * A second thing is not said at all, which is the same rule applied: `/get-session`
 * reports `twoFactorEnabled` and nothing else, and the backup codes live encrypted in a
 * table §4 gives identity sole custody of, so nothing here counts them or dates them.
 * `TwoFactorSummary`'s enabled arm carries exactly what was read. If better-auth ever
 * exposes a count, showing it is a build with a §13 sentence behind it, not a field to
 * fill in here.
 */
export async function settingsRead(
  /** The session asking — `sessionId` is what marks its own row `current`. */
  session: { ownerId: string; sessionId: string },
  /** The request whose cookie identity's better-auth reads ride (`callAuth`). */
  req: Request,
): Promise<SettingsRead> {
  // §13's shell rule, as code: ONE read feeding both the rail and every pane, so a marker
  // cannot be a second query that disagrees with the list beside it. Every pane pays for
  // all seven, which is the price of a rail that is always right.
  const [me, sessions, passkeys, lastUsed, tokens, connections, execution] = await Promise.all([
    callAuth<{ user?: { twoFactorEnabled?: boolean } }>(req, "/get-session"),
    callAuth<BetterAuthSession[]>(req, "/list-sessions"),
    callAuth<BetterAuthPasskey[]>(req, "/passkey/list-user-passkeys"),
    // §5's own column, which the plugin's listing cannot carry (identity says why).
    passkeyLastUsed(session.ownerId),
    read<{ tokens: TokenInfo[] }>(session, "token_list"),
    read<{ connections: ConnectionRow[] }>(session, "connection_list"),
    // §23.3's pair, read on every call for the rail marker's sake, exactly like the four
    // list lengths above.
    read<{ settings: SettingsExecution }>(session, "hub_settings_get"),
  ]);
  // One instant for every "is it expired" and every missing stamp in this answer.
  const now = new Date().toISOString();
  // better-auth's listings, defended: the shapes are better-auth's own to change, and an
  // empty list is a better answer than a 500 (callAuth's contract reads a bodiless success
  // as `{}`, which is not a listing).
  return {
    twoFactor: me?.user?.twoFactorEnabled ? { enabled: true } : { enabled: false },
    passkeys: (Array.isArray(passkeys) ? passkeys : []).map((pk) => passkeyRow(pk, now, lastUsed[pk.id])),
    sessions: (Array.isArray(sessions) ? sessions : []).map((row) => sessionRow(row, session.sessionId)),
    tokens: tokenRows(tokens.tokens, Date.parse(now)),
    connections: connections.connections,
    execution: execution.settings,
    limits: {
      passwordMinLength: PASSWORD_MIN_LENGTH,
      minTimeoutMs: HUB_MIN_TIMEOUT_MS,
      maxTimeoutMs: HUB_HARD_MAX_TIMEOUT_MS,
    },
  };
}

/**
 * The Tokens pane's rows: `token_list`'s answer minus the revoked ones — §13's "revoked
 * rows are not listed (nothing left to act on)", which is the PAGE's filter and not the
 * op's. Expired keys stay: they still hold a row to Remove.
 */
function tokenRows(tokens: TokenInfo[], now: number): TokenRow[] {
  return tokens
    .filter((token) => token.revokedAt === null)
    .map((token) => ({
      id: token.id,
      prefix: token.prefix,
      kind: token.kind,
      boundTo: token.refSlug,
      createdAt: token.createdAt,
      expiresAt: token.expiresAt,
      lastUsedAt: token.lastUsedAt,
      expired: token.expiresAt !== null && token.expiresAt <= now,
    }));
}

/** The passkey fields /settings draws, as the plugin's own listing spells them. */
type BetterAuthPasskey = {
  id: string;
  name?: string | null;
  createdAt?: string | null;
  /** The authenticator model's own identifier, written by every registration the plugin
   *  performs and returned unprojected by its listing — which is what makes the name rule
   *  below possible without a migration or a second read. */
  aaguid?: string | null;
};

/** `name` is what the authenticator reported, which may be nothing; `createdAt` is set by
 *  every registration the plugin performs, so a null one is a hand-inserted row.
 *  `lastUsed` is §5's epoch-ms column, absent until an assertion has verified.
 *
 *  The name rule is the plugin's own documented one, spelled HERE rather than in the page
 *  so the row, the rail and the Remove dialog's title all read one definition: a stored
 *  name first (what a hand-named row has), then the model the AAGUID names, then the
 *  generic word. §13's "the name the authenticator reported" is satisfied by the middle
 *  term — an AAGUID is reported by the authenticator.
 *  ponytail: the plugin's AAGUID table has 14 entries and platforms that keep the model
 *  private register an all-zero one under the default `attestation: "none"` flow, so
 *  "Passkey" stays the steady state for most rows; a longer table is the upgrade path,
 *  and it is the plugin's to grow, not this file's. */
function passkeyRow(pk: BetterAuthPasskey, now: string, lastUsed?: number): PasskeyRow {
  return {
    id: pk.id,
    name: pk.name || getAuthenticatorName(pk.aaguid) || "Passkey",
    addedAt: pk.createdAt ?? now,
    lastUsedAt: lastUsed === undefined ? null : new Date(lastUsed).toISOString(),
  };
}

/** The session fields /settings draws, as better-auth's own listing spells them.
 *  `token` is deliberately absent from this type: it is a credential, and a
 *  shape that named it is one careless spread away from rendering it (§15). */
type BetterAuthSession = {
  id: string;
  createdAt: string;
  updatedAt: string;
  userAgent?: string | null;
  /** identity's own `session.additionalFields` column, written by better-auth alone: "cli"
   *  on the one endpoint that mints a device-flow session, "web" everywhere else. Optional
   *  and nullable because rows that predate the migration carry neither. */
  source?: string | null;
};

function sessionRow(row: BetterAuthSession, current: string): SessionRow {
  // The one place the union is enforced, which it has to be regardless of the column's
  // declared type: a pre-migration row reads NULL, and NULL is a browser session.
  const source = row.source === "cli" ? "cli" : "web";
  return {
    id: row.id,
    // §13:107's own string, said here rather than derived: the CLI sends no User-Agent, so
    // a real CLI row would read "Unknown client", and a browser that CLAIMED to be the CLI
    // would mint the CLI's label out of the untrusted header below. The column decides.
    client: source === "cli" ? "pmcp CLI" : clientOf(row.userAgent),
    source,
    createdAt: new Date(row.createdAt).toISOString(),
    lastActiveAt: new Date(row.updatedAt).toISOString(),
    current: row.id === current,
  };
}

/**
 * "Chrome on Windows" out of the User-Agent better-auth stamped on the session — the
 * Client column's wording (design/SettingsPanes). Untrusted display data: a client can
 * claim anything, so this only ever PICKS a label from two fixed lists and never
 * interprets further; a string neither list places is shown as the client sent it, cut
 * to 80, and an empty one is "Unknown client" (identity's `callAuthResponse` forwards
 * the header — without it every browser sign-in through /login stores "").
 */
function clientOf(userAgent: string | null | undefined): string {
  const ua = userAgent?.trim() ?? "";
  if (ua === "") return "Unknown client";
  const browser = BROWSER_MARKS.find(([mark]) => ua.includes(mark))?.[1];
  const system = SYSTEM_MARKS.find(([mark]) => ua.includes(mark))?.[1];
  if (browser === undefined && system === undefined) return ua.slice(0, 80);
  return [browser, system].filter((part) => part !== undefined).join(" on ");
}

// Order IS the parse: Edge and Opera also say "Chrome", Chrome also says "Safari", and
// Android also says "Linux". First match wins.
const BROWSER_MARKS: readonly (readonly [string, string])[] = [
  ["Edg/", "Edge"],
  ["OPR/", "Opera"],
  ["Firefox/", "Firefox"],
  ["FxiOS/", "Firefox"],
  ["CriOS/", "Chrome"],
  ["Chrome/", "Chrome"],
  ["Safari/", "Safari"],
];
const SYSTEM_MARKS: readonly (readonly [string, string])[] = [
  ["iPhone", "iPhone"],
  ["iPad", "iPad"],
  ["Android", "Android"],
  ["Windows", "Windows"],
  ["Mac OS X", "macOS"],
  ["CrOS", "ChromeOS"],
  ["Linux", "Linux"],
];

/* ---------------------------- /login and /device ------------------------------ */

/**
 * /login — the one page with no PageContext, because it has no session to build one
 * from. Its whole input is the query string better-auth's redirect left behind, and
 * the render instant its caller stamps (web.ts holds the clock; nothing in this file
 * reads one).
 *
 * `rawSearch` is `web.ts`'s own `new URL(req.url).search` — the ORIGINAL bytes, never
 * reparsed through `query` and re-serialized — because §19.5 step 1's landing target for
 * the OAuth flow is the SIGNED query the provider built, and `URLSearchParams.toString()`
 * re-encodes (`+` for space, its own escaping) rather than reproducing what was signed.
 */
export function loginProps(now: string, query: URLSearchParams, rawSearch: string): LoginProps {
  return {
    step: loginStep(query),
    now,
    // §19.5 step 1: when /login was reached via the provider's own signed authorize
    // redirect, the post-login landing is a CONSTANT — the hub's own oauth2/authorize,
    // with the signed query appended as the ONLY thing taken from the request. This page
    // never reads a destination out of that query — no next=, no return_to= — which is
    // exactly why the check below runs BEFORE `query.get("next")` is ever consulted:
    // identity's own login redirect (an ordinary deep link, e.g. from /approvals/<id>)
    // carries no `sig`/`client_id` pair, so nothing here changes for it. The OAuth arm is
    // NOT passed through `hubRelative`: it is relative by construction, and its query is
    // the signed bytes. The `next` arm is a caller's input and goes through the rule.
    redirectTo: oauthRedirectTarget(query, rawSearch) ?? hubRelative(query.get("next")),
  };
}

/**
 * §19.5 step 1's one detection rule: a `sig` alongside a `client_id` on /login's OWN query
 * is the provider's signed authorize request (identity's plain deep-link redirect never
 * sets either) — nothing here re-verifies the signature, because this page only BUILDS the
 * landing URL and never acts on the query itself; the provider's `/oauth2/authorize` is
 * what verifies it, the moment the browser lands back there. `rawSearch` already carries
 * the leading `?`, so the result is `${AUTH_BASE_PATH}/oauth2/authorize?<verbatim query>`.
 */
function oauthRedirectTarget(query: URLSearchParams, rawSearch: string): string | null {
  if (!query.has("sig") || !query.has("client_id")) return null;
  return `${paths.auth.base}/oauth2/authorize${rawSearch}`;
}

/** Which of /login's three forms to draw, and what to say under the offending control.
 *  better-auth answers a password POST with either a session or a two-factor challenge,
 *  and the query string is how that answer comes back to a server-rendered page.
 *
 *  TWO spellings, and the second is not a convenience: web.ts's credential routes send
 *  `?step=`, while login.tsx's own "Use a backup code instead" link sends `?method=`
 *  (its `switchMethod`, a locked template). One of the two would otherwise silently draw
 *  the sign-in card instead of the card the owner asked for, which is a dead link in the
 *  middle of the challenge — so both are read here rather than one of them being wrong. */
function loginStep(query: URLSearchParams): LoginStep {
  const error = query.get("error");
  const step = query.get("step") ?? query.get("method");
  if (step === "totp" || step === "backup-code") return { kind: step, error };
  return { kind: "credentials", username: query.get("username") ?? "", error };
}

/**
 * `GET /api/hub/device`'s answer (decision 38) — the confirm card's facts for one user code,
 * or null when better-auth does not know the code or it is past its expiry. The code's whole
 * lifecycle is better-auth's (§4), so this asks identity's door rather than any table, and
 * the ASKING is the point: better-auth's verify, carrying this caller's cookie, CLAIMS a
 * pending unclaimed code for the caller and names its client only to the claimant — the
 * binding the page render always made (routes §3's "Binding, reviewed"). Nothing else the
 * verify answers (the status, the scope) reaches the card.
 */
export async function deviceRequestOf(req: Request, userCode: string): Promise<DeviceRequest | null> {
  // deps: identity.callAuth
  const verified = await callAuth<{ client_id?: string }>(req, `/device?user_code=${encodeURIComponent(userCode)}`);
  if (verified === null) return null;
  const now = new Date().toISOString();
  return {
    userCode,
    // KNOWN CEILING, and the reason it is spelled rather than guessed: RFC 8628 §5.4
    // wants the REQUESTING device's address and client, and better-auth's deviceCode
    // record carries neither (its columns are code, user, status, expiry, client_id,
    // scope). Answering this browser's own IP would be worse than saying nothing: it
    // would look like corroboration while corroborating nothing.
    ip: "unknown",
    // Named to the claimant alone — a code another owner already claimed answers none.
    client: verified.client_id ?? "unknown",
    requestedAt: now,
    // The record's own expiry is not returned either, so this is the window's upper
    // bound (§13's shortened device-code lifetime), which is what the card says.
    expiresAt: new Date(Date.parse(now) + DEVICE_CODE_TTL_MS).toISOString(),
  };
}

/* ------------------------------------- /oauth/consent (§19.5) ------------------------------------- */

/**
 * /oauth/consent's whole read (decision 38: `GET /api/hub/oauth/consent`'s answer, and the
 * shell's own document check), off the SIGNED query string the request carries and nothing
 * else. `req.url`'s raw search string IS `oauth_query` (§19.5 step 2: "the page cannot
 * invent, drop or edit a parameter") — the shell's URL's, or the read's, which the client
 * appends verbatim — so it is read here ONCE, echoed back unread, and handed to the
 * provider's own `/oauth2/public-client-prelogin` — which re-verifies the signature (§19.5
 * step 2's blocking probe observation: "public-client-prelogin wants client_id alongside
 * oauth_query") on every call. `null` means that verification failed — an edited or expired
 * query, or an unknown client — and each caller answers a 400 rather than a screen whose
 * every field would be unverified.
 *
 * `clientSelfRegistered` is read directly off `oauthClient` rather than through an admin op:
 * no op fronts it (nothing else in this hub needs it), it names no capability an agent or
 * the CLI could invoke instead, and it is display-only — so it joins /settings's better-auth
 * reads and /audit's stats as a named exception to "every loader reads through admin.ops"
 * rather than a silent one.
 */
export async function consentRead(ctx: { ownerId: string }, req: Request): Promise<ConsentRead | null> {
  // deps: identity.callAuth (public-client-prelogin) · admin.ops (agent_list) · D1 `oauthClient`
  const oauthQuery = new URL(req.url).search.slice(1);
  const requested = new URLSearchParams(oauthQuery);
  const clientId = requested.get("client_id") ?? "";
  if (oauthQuery === "" || clientId === "") return null;
  // The provider's own OAuth-shaped field name (schemaToOAuth's rendering) — `client_name`,
  // never `name`; the DCR body's own field is spelled the same way.
  const client = await callAuth<{ client_name?: unknown }>(req, "/oauth2/public-client-prelogin", {
    client_id: clientId,
    oauth_query: oauthQuery,
  });
  if (client === null) return null;
  const listed = await read<{ agents: { slug: string; name: string }[] }>(ctx, "agent_list");
  return {
    oauthQuery,
    clientName: typeof client.client_name === "string" && client.client_name !== "" ? client.client_name : null,
    clientSelfRegistered: await isDcrClient(clientId),
    redirectOrigin: originOf(requested.get("redirect_uri") ?? ""),
    scopes: (requested.get("scope") ?? "").split(" ").filter((s) => s !== ""),
    namespace: namespaceOfResource(requested.get("resource") ?? ""),
    agents: listed.agents.map((agent) => ({ slug: agent.slug, name: agent.name })),
  };
}

/** §19.3's DCR marker: no `userId` on the client's row means it registered itself through
 *  the anonymous DCR endpoint — nobody was signed in to vouch for it at registration. */
async function isDcrClient(clientId: string): Promise<boolean> {
  const row = await (env.DB as D1Like)
    .prepare(`SELECT "userId" FROM "oauthClient" WHERE "clientId" = ?`)
    .bind(clientId)
    .first<{ userId: string | null }>();
  return row === null || row.userId === null || row.userId === "";
}

/** A URL's origin, or the string itself when it does not parse — display-only, and a
 *  malformed redirect_uri is refused by the provider long before this page ever renders. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** The namespace named by an RFC 8707 `resource` (`https://<origin>/<user>/mcp`) — the
 *  path's first segment, or "" when the value is absent or does not parse. */
function namespaceOfResource(resource: string): string {
  try {
    return new URL(resource).pathname.split("/").filter(Boolean)[0] ?? "";
  } catch {
    return "";
  }
}

/* ---------------------------------- shared ------------------------------------ */

/** A query field that is present and non-empty, as the one-key object a spread
 *  can drop entirely — an absent filter must leave no trace in what is asked. */
function text(query: URLSearchParams, name: string): Record<string, string> {
  const value = query.get(name);
  return value === null || value === "" ? {} : { [name]: value };
}

/** A whole non-negative number, or null for everything else — a query string is
 *  a caller's input, and "limit=drop table" is simply not a limit. */
function positive(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}
