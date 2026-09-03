// model.ts — the view-model contract between the page handlers (web.ts) and the
// templates in this directory, plus the ONE definition of the hub's browser URL
// space, plus the READS that fill those props in.
//
// OWNS: one Props type per page of §13, the shared chrome those pages render
// inside, the `paths` object every inter-page link and form action is built
// from, and one loader per page — the seam where a props value stops being a
// fixture and becomes a real read. HIDES: nothing about the domain — every
// field here is either lifted straight from a read model (registry / approvals
// / audit / upstream / tunnel, via type-only imports) or is an explicitly
// derived projection of one. Where a page needs less than a read model offers,
// it says so with Pick/Omit rather than restating a shape that could then drift.
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
// And ONE parity exception is a real one, stated here rather than left to be
// discovered: /audit's four summary tiles and its histogram are AGGREGATIONS this
// file computes over `audit_query` rows (auditStats/auditHistogram), because no op
// returns stats or buckets. So the page shows something the CLI and the pmcp tools
// cannot — the second such exception beside the JSONL export, and unlike that one it
// is not merely a reframing of the same read. Closing it is an `audit_stats` op
// (audit.ts owning the window, the buckets and the percentiles, both fronts reading
// it), which is a change to the pinned op set in contracts/admin-ops.json and so
// belongs to a dispatch that may move a contract. Until then the ceiling is
// AUDIT_SCAN_ROWS's: the tiles silently lag `total` on a window past it.
//
// Two rules the templates depend on, stated once here:
//
//  1. Templates are pure `(props) => JSX`. They never fetch, never read cookies,
//     never call Date.now(), and never build a URL by concatenation — the render
//     instant arrives as `now` and every URL comes from `paths`. That is what
//     makes a template renderable from a fixture (server/dev/fixtures.ts) and
//     from a request with identical results.
//  2. Desktop and mobile are ONE template. The Mobile*.dc.html artboards are the
//     narrow breakpoint of these same props — e.g. /audit's numbered pages and
//     its "Load more" are two presentations of the single offset/limit/total
//     contract below, never two view models.
//
// Timestamps are mixed on purpose and the mix is inherited, not invented: the
// skeleton read models spell time two ways — ISO-8601 strings in approvals
// (ApprovalRow) and epoch milliseconds in registry/audit (AppDetail,
// AuditRow) — and this file keeps each field exactly as its source states it.
// `now` is ISO-8601; a template comparing it with an epoch-ms field parses it
// (Date.parse) rather than reaching for a clock of its own.

import { env } from "cloudflare:workers";
// The only thing in the tree that can draw a QR (`enrollmentOf`), and the only reason it
// is a dependency at all: §13 pins "QR plus the grouped secret", and the point of a QR is
// a phone camera. Zero-dependency, pure ESM, no Node built-ins — it runs on workerd.
import { renderSVG } from "uqr";
import { ops } from "../admin";
import type { AppPane } from "../app-routes";
import type { AppRow as OpsAppRow } from "../admin";
import { config as auditConfig } from "../audit";
import { DEFAULT_APP_CAPABILITIES } from "../capabilities";
import { argumentRows, reachabilityFor } from "../catalog-view";
import type { ArgumentRow, Reach, Reachability } from "../catalog-view";
import { ownerCatalog } from "../gateway";
import type { ListedItem } from "../gateway";
import {
  AUTH_BASE_PATH,
  callAuth,
  getAuthenticatorName,
  passkeyLastUsed,
  PASSWORD_MIN_LENGTH,
} from "../identity";
import type { TokenInfo } from "../identity";
import { DEVICE_CODE_TTL_MS } from "../limits";
import { redactPathsIn, Registry, validateSchemaIndirection, writeOnlyPaths } from "../registry";
import type { App, AppCapability, AppDetail, AppKind, ListKind, RoleDeclaration } from "../registry";
import type { ApprovalListFilters, ApprovalRow, ApprovalStatus } from "../approvals";
import type { AuditRow, BodyStub, AuditQuery } from "../audit";
import type { UpstreamConnectionStatus } from "../upstream";
import { capabilities as tunnelCapabilities } from "../tunnel";
import type { status as tunnelStatus } from "../tunnel";
// The one page-layer import: `sessionLabel` is a page string, and the revoke dialog and
// the row it names must read the same definition of it (format.ts says why).
import { sessionLabel } from "./format";

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
export type NavSection = "apps" | "audit" | "approvals" | "settings";

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
 * The filter fields that survive into a /audit link. Exactly `audit_query`'s
 * filter surface (§8) minus nothing and plus nothing: the page's query string IS
 * the tool's argument object, which is what lets "Export JSONL" be a
 * serialization of the same read rather than a second capability (§13).
 */
export type AuditLinkQuery = Pick<
  AuditQuery,
  "principal" | "app" | "event" | "tool" | "session" | "since" | "until" | "limit" | "offset"
>;

/**
 * Every URL the browser surface serves or posts to, in one object — templates
 * import this and never spell a path themselves, so a route rename is one edit
 * here instead of a search across eight templates. Page routes come straight
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
  /** Any of the seven non-landing panes (app-routes.APP_PANES, §13's table order). */
  appPane(slug: string, pane: AppPane): string {
    return `${paths.appDetail(slug)}/${pane}`;
  },
  /** Pending requests plus decision history. */
  approvals: "/approvals",
  /** Reserved ahead of its pages (§13 deferred; decision 30 reversed 2026-09-03): web.ts
   *  answers the whole subtree with its own not-built-yet 404 so the §2 walk sees the
   *  reservation served. Nothing links here yet. */
  agents: "/agents",
  /** Read-only view over audit.query with its exact filters. */
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
  /** The two PNGs the manifest's `icons` declares — the pair Chromium's install gate is
   *  built around — the first also the shell head's `rel="icon"`. Dotted, so both stay
   *  out of the username charset as the three above already do. */
  icon192: "/icon-192.png",
  icon512: "/icon-512.png",

  /** The detail page a -32003 error links an agent's user to (§7). */
  approval(id: string): string {
    return `/approvals/${encodeURIComponent(id)}`;
  },

  /** /audit under a set of filters — nav links, paging, and the session link alike. */
  auditWith(filters: AuditLinkQuery): string {
    return `/audit${query({ ...filters })}`;
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
   * The streaming JSONL export of the rows matching the current filters (§13).
   * Deliberately the same query string as `auditWith`: same rows, different
   * framing.
   */
  auditExport(filters: AuditLinkQuery): string {
    return `/audit/export.jsonl${query({ ...filters })}`;
  },

  /* --- mutations posted by the pages --- */

  /** Approve/deny the device code; the decision rides a submit button's value.
   *  better-auth's endpoint underneath, so this target names no op. */
  deviceDecide: "/device/decide",
  /** approval_decide (§8) for one request; approve and reject share the form,
   *  which submits the `decision` field the op's schema names. */
  approvalDecide(id: string): string {
    return `/approvals/approval_decide${query({ id })}`;
  },
  /** Where the browser's PushSubscription JSON is registered (approvals.subscribePush). */
  approvalsPush: "/approvals/push",
  /** app_create; on `auth: oauth` the response redirects into consent (§7),
   *  and on a tunneled create it renders the once-only token instead of
   *  redirecting — which is why this one target is not a plain redirect-back. */
  appCreate: "/apps/app_create",
  appArchive(slug: string): string {
    return `/apps/app_archive${query({ slug })}`;
  },
  appUnarchive(slug: string): string {
    return `/apps/app_unarchive${query({ slug })}`;
  },
  appDelete(slug: string): string {
    return `/apps/app_delete${query({ slug })}`;
  },
  /**
   * Connect and Reconnect are the same target: both start upstream.beginConnect
   * and redirect to the provider (§7). The button label differs, the flow does
   * not — and neither fronts a tool, which is why this path names no op.
   */
  appConnect(slug: string): string {
    return `/apps/connect${query({ slug })}`;
  },
  /** app_disconnect — wipes the stored bundle, keeps everything else (§8) — as /apps's
   *  own row control posts it, landing back on /apps. */
  appDisconnect(slug: string): string {
    return `/apps/app_disconnect${query({ slug })}`;
  },
  /** The same op from the app page's header, through that page's own dispatch so the
   *  notice lands on the app (§13, 37(b)). The path names the landing; the query carries
   *  the slug as the op's own input, exactly as the list's target does. */
  appHeaderDisconnect(slug: string): string {
    return `${paths.appDetail(slug)}/app_disconnect${query({ slug })}`;
  },
  /** The Tokens pane under §13's **All · Agents · Apps** filter. `undefined` is All and
   *  spells `paths.settingsTokens` exactly, so the active pill and the rail entry point at
   *  one URL rather than at two spellings of it. */
  settingsTokensWith(kind?: TokenRow["kind"]): string {
    return `${paths.settingsTokens}${query({ kind })}`;
  },
  /** token_revoke (§8) — the Tokens pane's Revoke/Remove control, under its own pane's
   *  prefix so §13's "mutations belong to a pane" holds for the redirect back. */
  tokenRevoke(id: string): string {
    return `${paths.settingsTokens}/token_revoke${query({ id })}`;
  },
  /** connection_revoke (§8/§19.6) — the Connected clients pane's Revoke. It moved here
   *  with its pane: nothing posts under `/oauth/connections` any more. */
  connectionRevoke(id: string): string {
    return `${paths.settingsClients}/connection_revoke${query({ id })}`;
  },
  /**
   * A mutation posted from an `/apps/<slug>` pane: the final segment names the op and
   * every non-control argument rides the query string under the op's own field name —
   * the same convention every other ops-backed target here follows. The redirect-back
   * lands on the pane that rendered the form (§13's "mutations belong to a pane"), which
   * is why the OP's target does not carry the pane: the pane is the form's, not the op's.
   */
  appOp(slug: string, op: string, args: Record<string, string> = {}): string {
    return `${paths.appDetail(slug)}/${op}${query(args)}`;
  },

  /* --- confirm dialogs as addressable state --- */

  /**
   * The same page with one destructive <dialog> rendered open. Server-rendered
   * state, so the confirm step works with scripting off and is reachable from a
   * fixture; a browser that supports invoker commands opens the identical dialog
   * without the round trip.
   */
  appsConfirmDelete(slug: string): string {
    return `/apps${query({ confirm: "delete", slug })}`;
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
  /**
   * The same, on /settings — and `pane` is first because a dialog rides the URL of the
   * pane that OWNS the control, never the page root (§13's "mutations belong to a pane").
   * The argument is the PANE, not its href (as on `/apps/<slug>`): the dialog's Cancel,
   * its redirect-back and the rail's active entry then name one URL because they name
   * one pane, and comparing a dialog's owner to the rendering pane is `===`.
   */
  settingsConfirm(pane: SettingsPane, kind: SettingsConfirm["kind"], id?: string): string {
    return `${paths.settingsPane(pane)}${query({ confirm: kind, id })}`;
  },
  /**
   * The same, on `/apps/<slug>`: the dialog rides the URL of the pane that OWNS the
   * control, never the page root (§13). Every confirm §13 gives this page belongs to a
   * non-landing pane (Token's Revoke, the Danger zone's two), which is why the pane
   * argument is an `AppPane` and the landing has no spelling here.
   */
  appConfirm(slug: string, pane: AppPane, kind: AppConfirm["kind"], id?: string): string {
    return `${paths.appPane(slug, pane)}${query({ confirm: kind, id })}`;
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
   */
  auth: {
    /** Where the composition root mounts better-auth — the prefix the two untranslated
     *  paths below carry, and the prefix identity's `callAuth` builds on. identity's, not
     *  this file's: the mount and the base path better-auth itself routes on are one
     *  decision (identity.AUTH_BASE_PATH). */
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
    passkeyRegister: "/api/auth/passkey/generate-register-options",
    passkeyVerifyRegistration: "/api/auth/passkey/verify-registration",
    /** The authentication ceremony /login's passkey button performs — the same pair, and
     *  the endpoint whose success is a sign-in (identity stamps §5's last_used_at on it). */
    passkeyAuthenticateOptions: "/api/auth/passkey/generate-authenticate-options",
    passkeyVerifyAuthentication: "/api/auth/passkey/verify-authentication",
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
 * Which of §13's six panes is being rendered. A pane is a route, so this is also which
 * URL was asked for and which rail entry is `aria-current="page"` — one value, read
 * from the path by web.ts and never from a query parameter.
 */
export type SettingsPane =
  | "password"
  | "two-factor"
  | "passkeys"
  | "sessions"
  | "tokens"
  | "clients";

/** The six panes in rail order, and the URL each answers at — §13's own table, which is
 *  also the mobile pill row's order. `label` is the rail's; `short` is the pill's, and
 *  differs for exactly one pane (§13: "Mobile pills shorten only the last label"). */
export const SETTINGS_PANES: readonly {
  pane: SettingsPane;
  href: string;
  label: string;
  short: string;
  group: "Sign-in" | "Access";
}[] = [
  { pane: "password", href: paths.settings, label: "Password", short: "Password", group: "Sign-in" },
  { pane: "two-factor", href: paths.settingsTwoFactor, label: "Two-factor", short: "Two-factor", group: "Sign-in" },
  { pane: "passkeys", href: paths.settingsPasskeys, label: "Passkeys", short: "Passkeys", group: "Sign-in" },
  { pane: "sessions", href: paths.settingsSessions, label: "Sessions", short: "Sessions", group: "Access" },
  { pane: "tokens", href: paths.settingsTokens, label: "Tokens", short: "Tokens", group: "Access" },
  { pane: "clients", href: paths.settingsClients, label: "Connected clients", short: "Clients", group: "Access" },
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
 * ONE shape for all six panes, and that is the point of §13's shell rule: the rail's
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
};

/* ------------------------------------------------------------------ *
 * /apps
 * ------------------------------------------------------------------ */

/**
 * The tunnel's runtime status, taken from tunnel.status rather than restated:
 * "online" means a live socket that has completed hub/register, everything else
 * is "offline" (§6).
 */
export type TunnelStatus = Awaited<ReturnType<typeof tunnelStatus>>;

/** The upstream auth mode a proxied app declares (§7); tunneled rows have none. */
export type UpstreamAuthMode = NonNullable<AppDetail["upstreamAuthMode"]>;

/**
 * One row of the apps table — a projection of the app_list row (§8),
 * narrowed to what the table draws. The two status fields are exclusive by
 * kind, exactly as app_list reports them: `connection` is tunnel-only and
 * `upstream` is proxy-only, each null on the other kind. That is what lets the
 * template pick a row's actions without a second lookup:
 *
 *   archived            → Unarchive · Delete
 *   tunnel              → Archive · Delete (status badge from `connection`)
 *   proxy + headers     → Archive · Delete (no status badge — nothing to connect)
 *   proxy + oauth       → Connect | Reconnect | Disconnect, by `upstream`
 *                         (not_connected | needs_reconnect | connected)
 *
 * `roleNames` lists the DECLARED roles (tunnel: whatever the last registration
 * declared; proxy: the config's virtual roles). It is empty for an app that
 * has never declared any — the built-in `all` is resolved at request time and is
 * never stored (§2), so the template renders "all" for an empty list rather than
 * this field ever carrying it.
 */
export type AppRow = Pick<
  AppDetail,
  "slug" | "name" | "kind" | "archived" | "upstreamUrl" | "upstreamAuthMode" | "lastConnectedAt"
> & {
  roleNames: string[];
  connection: TunnelStatus | null;
  upstream: UpstreamConnectionStatus | null;
  /**
   * Live tokens bound to this app — the number the delete dialog names
   * ("Its 2 tokens are revoked"). Always 0 for proxied apps, which have no
   * tokens at all (§2).
   */
  tokenCount: number;
};

/** The one destructive confirmation /apps raises (Dialogs.dc.html). */
export type AppsConfirm = { kind: "delete-app"; row: AppRow };

/**
 * /apps. Active and archived are two lists because they are two sections
 * with different actions, not one list with a flag — but both hold the same row
 * shape, and `archived` is still on every row so a row can be rendered outside
 * its section (the confirm dialog does exactly that).
 */
export type AppsProps = ShellProps & {
  section: "apps";
  csrfToken: string;
  active: AppRow[];
  archived: AppRow[];
  confirm: AppsConfirm | null;
};

/* ------------------------------------------------------------------ *
 * /apps/<slug>
 * ------------------------------------------------------------------ */

/** §13's eight panes: the seven routed ones plus the landing, which is Tools. */
export type AppDetailPane = "tools" | AppPane;

/** The destructive confirmations `/apps/<slug>` raises, each riding the URL of the pane
 *  that draws its control (§13's "confirm-dialog state rides the owning pane's URL"). */
export type AppConfirm =
  | { kind: "revoke-token"; id: string; prefix: string }
  | { kind: "archive" }
  | { kind: "delete" };

/** Which pane owns each of them, so the link that opens a dialog, the Cancel that closes
 *  it and the redirect a submitted dialog lands on are one URL (§13). */
export const APP_CONFIRM_PANE: Record<AppConfirm["kind"], AppPane> = {
  "revoke-token": "token",
  archive: "danger",
  delete: "danger",
};

/**
 * One rail entry as §13's pane table spells it. `marker` is the at-a-glance value in
 * FOUR distinguishable states, because §13 gives them four meanings: a count, the literal
 * `none`, the dimmed `—` of a family the app advertises none of, and the empty string —
 * which is BOTH "this pane's table cell says none" and "the listing could not be read",
 * since an unread count is not an empty set and must not render as one.
 */
export type AppRailEntry = {
  pane: AppDetailPane;
  label: string;
  href: string;
  marker: string;
  /** The heading this entry sits under; null is the ungrouped Danger zone (§13). */
  group: "App" | "Access" | null;
};

/**
 * The page header (§13): identity, then whichever status the app's kind actually has —
 * a tunneled app's online/offline and last seen, a proxied app's endpoint, auth mode and
 * forward identity, and for `auth: oauth` the connection controls `/apps` also draws.
 */
export type AppDetailHeader = {
  name: string;
  slug: string;
  kind: AppKind;
  archived: boolean;
  /** The status word beside the kind badge — null where there is nothing to connect
   *  (a headers-mode proxy), which is exactly when `/apps` draws no badge either. */
  status: string | null;
  /** Tunneled only (§8's `lastSeen`); null on a proxied app and on one never connected. */
  lastSeen: number | null;
  endpoint: string | null;
  authMode: UpstreamAuthMode | null;
  /** Proxied only — null on a tunneled app, which forwards nothing upstream. */
  forwardIdentity: boolean | null;
  /** Connect or Reconnect, labelled by the upstream state; null unless auth is oauth. */
  connect: { label: string; href: string } | null;
  /** Disconnect's target — null unless there is a stored credential to wipe. */
  disconnect: string | null;
};

/**
 * What a §20 family pane has to draw, as the three answers §13 distinguishes. The states
 * are separate because their MARKERS are: `listed` counts, `undeclared` is the dimmed `—`
 * whose pane says why (§20.2 for proxied, §20.5 for tunneled), and `unread` is blank —
 * a proxied listing that failed, which §13 forbids rendering as an empty set.
 */
export type AppFamilyView<Row> =
  | { state: "listed"; rows: Row[] }
  | { state: "undeclared" }
  | { state: "unread" }
  /** A tunneled app that has never connected: no catalog to count, so every family dims
   *  and the pane says so (§13, pinned 2026-09-03) — not "declared none", which would
   *  claim a declaration the hub never received. */
  | { state: "unconnected" };

/**
 * One Tools row plus §13's "what only the hub knows" block, computed once per render: the
 * aggregated name (§7), who reaches it and how (the door's own matcher, through
 * catalog-view), and the redaction the call would apply. `schemaUnsound` is §7/§18
 * decision 16 — a tool whose schema tripped the indirection line has no derivable
 * redaction map at all, which is a different statement from "nothing is redacted".
 */
export type AppToolRow = {
  name: string;
  /** `<slug>_<tool>` — the name an agent calls it by on the aggregated endpoint. */
  aggregated: string;
  /** The whole description; `summary` is its first line, which is what the row shows. */
  description: string;
  summary: string;
  args: ArgumentRow[];
  reach: Reach[];
  /** The agents §13's approval line names: those reaching ONLY in approval mode. */
  approvalAgents: string[];
  redactedArgs: string[];
  redactedResults: string[];
  schemaUnsound: boolean;
};

/** One declared prompt argument as `prompts/list` reports it — §13's "name, description,
 *  required". There is no schema behind it: §20.3 says prompts have none, which is also
 *  why this pane draws no Arguments table and no `writeOnly` redaction half exists. */
export type PromptArgumentRow = { name: string; description: string; required: boolean };

/**
 * One Prompts row plus §13's hub block — the Tools block minus the schema table and minus
 * a posture, prompts being never approval-gated (§18 decision 27). `redacted` is the
 * `redact` entries matching the prompt's NAME: §20.3 keeps those maps family-blind, so it
 * is the same map and the same matcher a tool name goes through.
 */
export type AppPromptRow = {
  name: string;
  /** `<slug>_<prompt>` — §20.6's aggregated name, which prompts share with tools alone. */
  aggregated: string;
  description: string;
  args: PromptArgumentRow[];
  reach: Reach[];
  redacted: string[];
};

/** One Resources or Templates row — §13's `URI` / `Name` / `Type` columns, a template's
 *  URI being its raw `uriTemplate`, and the reachability the door answered for that very
 *  string: grants match resources by URI, never by name (§20.3). */
export type AppResourceRow = { uri: string; name: string; mimeType: string; reach: Reach[] };

/**
 * §13's Overview pane — `app_get`'s row as a definition list. Only `logBodiesIsDefault` is
 * derived: §15 gives the setting a per-kind default (tunneled on, proxied off) and §13
 * asks the pane to say WHICH default it sits at, while the row reports the resolved
 * boolean alone. The redaction fields are the configured paths flattened — §13 says "the
 * config paths, or `none`", and which pattern earned a path is the Tools pane's business.
 */
/** One `role · mode` chip of §13's Agents pane. `builtin` is the `all` marking: `all` is
 *  the reserved built-in nobody declares (§2/§20.3), so holding it is the whole test. */
export type AppGrantChip = { role: string; mode: "allow" | "approval"; builtin: boolean };

/**
 * One Agents row (§13): the agent's own slug and description as TEXT — `/agents/<slug>` is
 * deferred, so a link there would be a link to a 404 — and one chip per grant it holds on
 * this app, in `agent_list`'s own order. The pane is read-only until the grant editor
 * lands, which is why no row carries a control.
 */
export type AppAgentRow = { slug: string; description: string; chips: AppGrantChip[] };

/**
 * One Token-pane row: a LIVE app token bound to this app, as `token_list` reports it
 * (§8, unchanged). Revoked and expired keys are absent — the pane is what is still
 * dialling in, and the rail marker is this list's length.
 */
export type AppTokenRow = { id: string; prefix: string; createdAt: number; lastUsedAt: number | null };

export type AppOverview = {
  /** Always a real instant: this page 404s the builtin, which is the only app row
   *  with no creation date (`appDetailProps` makes the narrowing true). */
  createdAt: number;
  logBodies: boolean;
  logBodiesIsDefault: boolean;
  redactedArgs: string[];
  redactedResults: string[];
};

/**
 * `/apps/<slug>` and its seven panes as one props value. Every family view is present on
 * every render, because the rail is: §13 requires each marker to be "read from the same
 * calls that render the panes", so the loader makes those calls once and both the rail
 * and the active pane are drawn from the same answers.
 */
export type AppDetailProps = ShellProps & {
  section: "apps";
  csrfToken: string;
  pane: AppDetailPane;
  header: AppDetailHeader;
  rail: AppRailEntry[];
  tools: AppFamilyView<AppToolRow>;
  prompts: AppFamilyView<AppPromptRow>;
  resources: AppFamilyView<AppResourceRow>;
  templates: AppFamilyView<AppResourceRow>;
  /** Which of the Resources pane's two tabs this URL selected (§13). */
  tab: "resources" | "templates";
  /** §2's `PUBLIC_ORIGIN`, the one answer to "what is the hub's address" — the Resources
   *  pane prints the scoped endpoint with it so the sentence is copyable (§13). */
  hubOrigin: string;
  /** The DECLARED roles in §20.3's CANONICAL read shape — a bare pattern list for a
   *  tools-only role, the per-family object otherwise — as the Roles pane renders them
   *  and its rail marker counts them. `app_get` already canonicalizes; the page relays. */
  roles: RoleDeclaration;
  overview: AppOverview;
  /** The agents holding ≥ 1 grant on this app, from `agent_list`'s inline grants (§8). */
  agents: AppAgentRow[];
  /** This app's live app tokens — always empty for a proxied app, which holds none (§2). */
  tokens: AppTokenRow[];
  /** The destructive dialog the URL asked for, or null (§13's `?confirm=` state). */
  confirm: AppConfirm | null;
  /**
   * A key just minted by **Issue new token**, shown in THIS response and never again
   * (§4/§15) — which is why the Issue target answers 200 in place of the generic redirect:
   * a plaintext key must never ride a URL.
   */
  reveal: string | null;
};

/* ------------------------------------------------------------------ *
 * /apps/new
 * ------------------------------------------------------------------ */

/**
 * The add-app form as submitted, echoed back verbatim on a validation
 * failure so nothing the owner typed is lost. `endpoint` and `authMode` are
 * proxy-only and are ignored — not rejected in the UI — while `kind` is
 * "tunnel"; app_create rejects them server-side (§8).
 */
export type AppNewForm = {
  kind: AppKind;
  name: string;
  slug: string;
  endpoint: string;
  authMode: UpstreamAuthMode;
};

/**
 * Field-scoped validation messages, keyed by the control they sit under.
 * "form" is the whole-form message (a create that failed for a reason no single
 * field owns). Every key is optional; an empty object is a clean form.
 */
export type AppNewErrors = Partial<Record<"name" | "slug" | "endpoint" | "form", string>>;

/**
 * The form, then its receipt. `created` is the TOKEN REVEAL state of
 * AppNewStates.dc.html: `token` is the plaintext app token, present in
 * this one render and never recoverable afterwards (§4) — null for proxied
 * apps, which have no token to show. An `auth: oauth` create never reaches
 * this state at all: it redirects into the provider's consent screen (§7).
 */
export type AppNewStep =
  | { kind: "form"; form: AppNewForm; errors: AppNewErrors }
  | { kind: "created"; slug: string; name: string; token: string | null };

/**
 * /apps/new — a chromeless card page like /login, so it carries `username`
 * for the slug helper line ("served at /ahrzb/mcp/news") without the nav.
 */
export type AppNewProps = PageProps & {
  username: string;
  csrfToken: string;
  step: AppNewStep;
};

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
 * "Decided —" arm has nothing to render. `approvalDetailProps` makes the narrowing true.
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
 * /audit
 * ------------------------------------------------------------------ */

/**
 * The time window as the segmented control expresses it. "custom" means the
 * window came from an explicit since/until pair rather than one of the presets,
 * and is what the date-range control renders ("Aug 18 – Aug 24, 2026").
 */
export type AuditRange = "1h" | "24h" | "7d" | "30d" | "custom";

/**
 * The page's current filter state — `audit_query`'s filters (§8) with limit and
 * offset resolved (never undefined here: the page always knows its page size and
 * position), plus the preset the window came from. `since`/`until` stay epoch
 * milliseconds, as AuditQuery states them, and are always set even for a preset,
 * so the export link and the histogram cover exactly the visible window.
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
 * The values behind the three select controls, gathered from the namespace, not
 * from the visible rows — a filter must be able to select a principal whose
 * events fell outside the current window. `principals` are canonical principal
 * strings ("agent:claude", "user:ahrzb", "app:news"), the same spelling audit rows
 * and `audit_query.principal` use.
 */
export type AuditFilterOptions = {
  principals: string[];
  apps: string[];
  events: string[];
};

/**
 * A recorded body as /audit renders it: the masked JSON object, or one whole-body
 * BodyStub when the body was over the cap and was replaced entire (§15). The
 * detail view shows stubs as typed size placeholders (‹blob image/png · 4.2 MB›,
 * ‹oversize · 2.1 MB›) and never anything resembling bytes.
 */
export type RecordedBody = Record<string, unknown> | BodyStub;

/**
 * One audit row as the page sees it: audit.query's row minus the namespace id
 * (every row on this page belongs to the viewer's own namespace — carrying it
 * would only invite rendering it) and with the two body columns typed for what
 * they can actually hold.
 */
export type AuditEventRow = Omit<AuditRow, "ownerId" | "args" | "result"> & {
  args?: RecordedBody;
  result?: RecordedBody;
};

/**
 * The four summary tiles, computed over the SAME filtered window as `rows` — so
 * changing a filter moves the tiles with the table. Counts are of matching rows,
 * not of the page. Nulls mean "no basis to compute": `eventsDeltaPct` has none
 * when the previous window is outside retention (§15's 7 days), and the latency
 * figures have none when no matching row carried a duration (only tools/call
 * rows do).
 */
export type AuditStats = {
  events: number;
  eventsDeltaPct: number | null;
  toolCalls: number;
  denied: number;
  medianDurationMs: number | null;
  p95DurationMs: number | null;
};

/** One histogram column: the bucket's start (ISO-8601) and how many rows fell in it. */
export type AuditBucket = { start: string; count: number };

/**
 * "Events over time". One bucket size for both breakpoints — the desktop note
 * ("6-hour buckets") and the mobile heading ("Events per day") are two labels
 * derived from `bucketMs`, not two datasets. `peak` is the scale the bars and the
 * y-axis tick are drawn against, carried rather than recomputed so an empty
 * window still draws an axis.
 */
export type AuditHistogram = {
  bucketMs: number;
  buckets: AuditBucket[];
  peak: number;
};

/**
 * The single paging contract behind both presentations (§13): desktop renders
 * numbered pages and a "1–50 of 1,284" line from it, mobile renders "Load more"
 * from the same three numbers. `total` is audit_query's total — every row
 * matching the filters, regardless of limit/offset — and also the "N events
 * match" line.
 */
export type AuditPaging = {
  offset: number;
  limit: number;
  total: number;
};

/**
 * /audit — read-only, so no CSRF token and no mutation targets. Every control on
 * the page is a GET: the filters submit as a query string, Export JSONL is a
 * link, and an expanded row is addressable.
 */
export type AuditProps = ShellProps & {
  section: "audit";
  /** The one shelled page that never flashes: every control here is a GET, so nothing
   *  redirects back to it with an outcome and the page draws no alert at all. */
  notice: null;
  filters: AuditFilters;
  options: AuditFilterOptions;
  rows: AuditEventRow[];
  paging: AuditPaging;
  stats: AuditStats;
  histogram: AuditHistogram;
  /**
   * The row whose <details> is rendered open — the EVENT DETAIL panel with the
   * summary, the client metadata, and the recorded bodies. Deep-linkable, so a
   * fixture and a shared link show the same thing; null means all collapsed.
   */
  expandedId: number | null;
  /**
   * How long the ledger keeps rows (§15, default 7): the "kept for N days" line
   * and the empty state's advice both read it, and it is env-tunable, so it is
   * data rather than copy.
   */
  retentionDays: number;
};

/* ------------------------------------------------------------------ *
 * /oauth/consent (§19.5)
 * ------------------------------------------------------------------ */

/** One entry of the agent `<select>`, defaulted to nothing (§19.5). */
export type ConsentAgentOption = { slug: string; name: string };

/**
 * /oauth/consent — chromeless, like /login and /device: reached from the provider's own
 * redirect, not from inside the signed-in app. Every field here is either the SIGNED
 * `oauth_query` echoed verbatim (§19.5 step 2 — this page cannot invent, drop or edit a
 * parameter) or a value read out of the SAME verified query, through the provider's own
 * `/oauth2/public-client-prelogin` (which re-checks the signature, §19.5 step 2's blocking
 * probe observation).
 */
export type ConsentProps = PageProps & {
  csrfToken: string;
  /** The whole signed query, byte-for-byte — the hidden field this form echoes back. */
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
  apps: AppsProps;
  "app-detail": AppDetailProps;
  "app-new": AppNewProps;
  approvals: ApprovalsProps;
  "approval-detail": ApprovalDetailProps;
  audit: AuditProps;
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
  /** The session rendering this page — what /settings badges as "current". */
  sessionId: string;
  csrfToken: string;
  /** ISO-8601: the render instant, and the only clock any template reads. */
  now: string;
  notice: Notice | null;
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

/** The shell every signed-in page renders inside; the badge count is the number
 *  of rows /approvals would show as pending, read the same way that page reads it. */
async function shell<S extends NavSection>(
  ctx: PageContext,
  section: S,
  pending?: ApprovalRow[],
): Promise<ShellProps & { section: S }> {
  const rows = pending ?? (await pendingOf(ctx));
  return {
    now: ctx.now,
    username: ctx.username,
    section,
    pendingApprovals: rows.length,
    notice: ctx.notice,
  };
}

/** Every pending request in the namespace, newest first — `approval_list`'s own
 *  answer, lazy expiry included (§7), so the badge and the page cannot disagree. */
async function pendingOf(ctx: PageContext): Promise<ApprovalRow[]> {
  const listed = await read<{ approvals: ApprovalRow[] }>(ctx, "approval_list", {
    status: "pending",
  });
  return listed.approvals;
}

/* --------------------------------- /apps --------------------------------- */

/**
 * /apps from `app_list` plus `token_list`: the table's rows are the
 * former, and the delete dialog's "its N tokens are revoked" line is the latter
 * counted per app. The builtin `pmcp` row app_list appends is dropped —
 * it is a virtual app with no row, no actions, and no slug an owner may
 * touch (§8), so a table of things you can archive and delete is not where it
 * belongs.
 */
export async function appsProps(ctx: PageContext): Promise<AppsProps> {
  const [listed, credentials] = await Promise.all([
    read<{ apps: OpsAppRow[] }>(ctx, "app_list"),
    read<{ tokens: TokenInfo[] }>(ctx, "token_list"),
  ]);
  const live = liveTokenCounts(credentials.tokens, Date.parse(ctx.now));
  const rows = listed.apps
    .filter((row): row is Exclude<OpsAppRow, { kind: "builtin" }> => row.kind !== "builtin")
    .map((row) => appRow(row, live.get(row.slug) ?? 0));
  const confirmSlug = ctx.query.get("confirm") === "delete" ? ctx.query.get("slug") : null;
  const confirmRow = rows.find((row) => row.slug === confirmSlug);
  return {
    ...(await shell(ctx, "apps")),
    csrfToken: ctx.csrfToken,
    active: rows.filter((row) => !row.archived),
    archived: rows.filter((row) => row.archived),
    confirm: confirmRow === undefined ? null : { kind: "delete-app", row: confirmRow },
  };
}

/**
 * One app_list row as the table draws it. The two status fields are
 * exclusive by kind and the mapping is the row's own: a tunneled row carries
 * `status`/`lastSeen`, a proxied one carries its endpoint and — only in oauth
 * mode — the upstream connection state.
 */
function appRow(row: Exclude<OpsAppRow, { kind: "builtin" }>, tokenCount: number): AppRow {
  const common = {
    slug: row.slug,
    name: row.name,
    archived: row.archived,
    roleNames: Object.keys(row.roles),
    tokenCount,
  };
  if (row.kind === "tunnel") {
    return {
      ...common,
      kind: "tunnel",
      upstreamUrl: null,
      upstreamAuthMode: null,
      lastConnectedAt: row.lastSeen,
      connection: row.status,
      upstream: null,
    };
  }
  return {
    ...common,
    kind: "proxy",
    upstreamUrl: row.endpoint,
    upstreamAuthMode: row.auth,
    // A proxied app never dials in, so it has no last-connected instant of
    // its own — the column reads "—" rather than borrowing another meaning.
    lastConnectedAt: null,
    connection: null,
    upstream: row.connection ?? null,
  };
}

/** Live credentials per app slug — neither revoked nor past expiry, which is
 *  what "its N tokens are revoked" promises to be about. */
function liveTokenCounts(tokens: TokenInfo[], now: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    if (token.kind !== "app" || token.revokedAt !== null) continue;
    if (token.expiresAt !== null && token.expiresAt <= now) continue;
    counts.set(token.refSlug, (counts.get(token.refSlug) ?? 0) + 1);
  }
  return counts;
}

/* ------------------------------ /apps/<slug> ------------------------------ */

/**
 * §13's pane table, in its own order — which is the rail's order, the pill row's order,
 * and the order every walk over the eight panes reads. Tools carries no route segment
 * because it is the LANDING pane: `/apps/<slug>` renders it and `/apps/<slug>/tools` is a
 * 404, so a segment here would be a spelling of a page that does not exist.
 */
const APP_PANE_TABLE: readonly { pane: AppDetailPane; label: string; group: AppRailEntry["group"] }[] = [
  { pane: "tools", label: "Tools", group: "App" },
  { pane: "prompts", label: "Prompts", group: "App" },
  { pane: "resources", label: "Resources", group: "App" },
  { pane: "roles", label: "Roles", group: "App" },
  { pane: "overview", label: "Overview", group: "App" },
  { pane: "access", label: "Agents", group: "Access" },
  { pane: "token", label: "Token", group: "Access" },
  { pane: "danger", label: "Danger zone", group: null },
];

/** §13's dimmed marker — an em dash, and the ONE thing that means "advertises none".
 *  Exported so the rail can DRAW that entry dimmed (AppDetail.dc.html greys the label as
 *  well as the marker) without a second spelling of the glyph deciding what it means. */
export const DIMMED = "—";

/** `agent_list`'s row, narrowed to what this page reads: the slug and description the
 *  Agents pane draws, and the inline grants (§8) keyed by app slug in §9's own spelling. */
type ListedAgent = { slug: string; description: string; grants: Record<string, string[]> };

/** §2's reserved role: granted like any other, declared by nobody, and the one §13 asks
 *  the Agents pane to mark `built-in`. Spelled here because registry rejects it as a
 *  declared name rather than exporting it. */
const BUILTIN_ROLE = "all";

/** One catalog entry as a Tools row reads it — `ListedItem` plus the two descriptors the
 *  hub stores untouched and relays (§20.2), which the door itself never looks at. */
type CatalogTool = ListedItem & { description?: string; inputSchema?: unknown };

/** The same for a prompt: `arguments` is the app's own declaration, relayed untouched, so
 *  it is read defensively rather than trusted to be the shape the SDK documents. */
type CatalogPrompt = ListedItem & {
  description?: string;
  arguments?: { name?: unknown; description?: unknown; required?: unknown }[];
};

/**
 * `/apps/<slug>` and each of its seven panes (§13). `null` is the 404 every unreachable
 * slug shares — the builtin `pmcp`, a slug naming nothing, and another namespace's app,
 * which are indistinguishable because a page reads only the session owner's namespace.
 *
 * ONE read pass fills both the rail and the pane being drawn, which is §13's shell rule
 * as code: a marker is "read from the same calls that render the panes", so every §20
 * family is listed on every render whichever pane the URL names, and each marker is the
 * length of the very list its pane draws. Catalogs come through gateway's `ownerCatalog`
 * and nowhere else — the scoped endpoint's own listing under the owner principal, left
 * unfiltered by §7 step 2 by construction (§20.6: this page fronts the MCP method exactly
 * as `pmcp tools` does, which is why §8's parity list is untouched).
 */
export async function appDetailProps(
  ctx: PageContext,
  slug: string,
  pane: AppDetailPane,
): Promise<AppDetailProps | null> {
  // deps: registry.getApp · tunnel.capabilities · gateway.ownerCatalog · catalog-view
  //
  // The one read here that is not an ops handler, for web.ts's own reason
  // (`connectRedirect`): an app's opaque id is addressing and no read op reports one
  // (§3), and the id is what the tunnel's declared capability set and §7's redaction
  // functions are keyed on. It doubles as this page's 404, since `getApp` answers null
  // for the builtin, the unknown and the foreign slug alike.
  const registry = new Registry(env.DB);
  const app = await registry.getApp(ctx.ownerId, slug);
  if (app === null) return null;

  const [detail, listed, credentials] = await Promise.all([
    read<{ app: OpsAppRow }>(ctx, "app_get", { slug }),
    read<{ agents: ListedAgent[] }>(ctx, "agent_list"),
    read<{ tokens: TokenInfo[] }>(ctx, "token_list"),
  ]);
  const row = detail.app;
  // `getApp` already answered null for the builtin, so `app_get` cannot be reporting it
  // here — asserting that is what lets Overview print a creation date with no "unknown"
  // arm, since the builtin row is the only one carrying no `createdAt`.
  if (row.kind === "builtin") throw new Error(`app_get reported the builtin row for ${slug}`);

  // §20.2/§20.5's advertised set, per kind — the same resolution gateway's
  // `capabilitiesFor` makes for the scoped handshake, because the dimming rule and the
  // handshake are two readings of one stored fact: a tunneled app's set is what its last
  // registration declared (tools for one that never connected), a proxied app's is the
  // owner's config with "absent ≡ [tools]" applied.
  const advertised: readonly AppCapability[] =
    app.kind === "tunnel"
      ? await tunnelCapabilities(app.id)
      : (row.kind === "proxy" ? row.capabilities : undefined) ?? DEFAULT_APP_CAPABILITIES;

  // §13 (2026-09-03): a tunneled app that has never connected has no catalog at all —
  // `capabilities()` answers `tools` for it by policy, which would otherwise read as a
  // declared-but-empty tools family. `lastSeen` is null exactly for never-connected.
  const neverConnected = row.kind === "tunnel" && row.lastSeen === null;
  const familyOf = async (kind: ListKind, family: AppCapability): Promise<AppFamilyView<ListedItem>> => {
    if (neverConnected) return { state: "unconnected" };
    if (!advertised.includes(family)) return { state: "undeclared" };
    const answered = await ownerCatalog(env, ctx.ownerId, slug, kind);
    return answered.ok ? { state: "listed", rows: answered.items } : { state: "unread" };
  };

  const [catalog, promptItems, resourceItems, templateItems] = await Promise.all([
    familyOf("tools", "tools"),
    familyOf("prompts", "prompts"),
    familyOf("resources", "resources"),
    familyOf("resourceTemplates", "resources"),
  ]);

  // The grants held ON THIS APP, agent slug → §9's own spelling — the shape
  // catalog-view's reachability takes, and the very rows the Agents pane draws. Read
  // before anything else is built, because every family's hub block is computed from it
  // and the Agents marker is this list's length.
  const grants: Record<string, string[]> = {};
  const agents: AppAgentRow[] = [];
  for (const agent of listed.agents) {
    const held = agent.grants[slug] ?? [];
    if (held.length === 0) continue;
    grants[agent.slug] = held;
    agents.push({
      slug: agent.slug,
      description: agent.description ?? "",
      chips: held.map(grantChip),
    });
  }

  // §13's live keys, in the one place the marker and the pane both read: the marker is
  // this list's length, so a pane and its rail cannot disagree about what "live" means.
  const tokens = app.kind === "proxy" ? [] : liveAppTokens(credentials.tokens, slug, Date.parse(ctx.now));

  // The doors, built once for the whole page: they are the APP's (its declaration and its
  // grants), and every row of every family asks the same ones (catalog-view says why).
  const reach = reachabilityFor(row.roles, grants);

  const [tools, prompts, resources, templates] = await Promise.all([
    mapped(catalog, (item) => toolRow(row, app, reach, item as CatalogTool)),
    mapped(promptItems, (item) => promptRow(row, app, reach, item as CatalogPrompt)),
    // A template's subject is its RAW `uriTemplate`, which `resourceRow` already puts in
    // `uri` — so both tabs reach the matcher through one function (§20.3).
    mapped(resourceItems, (item) => resourceRow(item, reach)),
    mapped(templateItems, (item) => resourceRow(item, reach)),
  ]);

  const roleNames = Object.keys(row.roles);
  const marker: Record<AppDetailPane, string> = {
    tools: familyMarker(tools),
    prompts: familyMarker(prompts),
    // §13's Resources marker is the two tabs summed, which is also the two lists the pane
    // draws between them — one marker, one pane, two counts.
    resources: familyMarker(resources, templates),
    roles: roleNames.length === 0 ? "none" : String(roleNames.length),
    overview: "",
    access: String(agents.length),
    // §2's reason, not a missing feature: nothing dials in to a proxied app, so it has no
    // token to hold and its entry dims like a family it does not advertise.
    token: app.kind === "proxy" ? DIMMED : String(tokens.length),
    danger: "",
  };

  return {
    ...(await shell(ctx, "apps")),
    csrfToken: ctx.csrfToken,
    pane,
    header: appHeader(row, app.kind, slug),
    rail: APP_PANE_TABLE.map((entry) => ({
      ...entry,
      href: entry.pane === "tools" ? paths.appDetail(slug) : paths.appPane(slug, entry.pane),
      marker: marker[entry.pane],
    })),
    tools,
    prompts,
    resources,
    templates,
    tab: ctx.query.get("tab") === "templates" ? "templates" : "resources",
    hubOrigin: new URL(env.PUBLIC_ORIGIN).origin,
    roles: row.roles,
    overview: {
      createdAt: row.createdAt,
      logBodies: row.logBodies,
      // §15's per-kind default, restated as the ONE comparison that tells "the owner set
      // this" from "nobody has": the row reports the resolved boolean and no column says
      // whether it was written, so the default itself is the discriminator.
      logBodiesIsDefault: row.logBodies === (app.kind === "tunnel"),
      redactedArgs: [...new Set(Object.values(row.redact).flat())],
      redactedResults: [...new Set(Object.values(row.redactResults).flat())],
    },
    agents,
    tokens,
    confirm: appConfirm(ctx.query, pane, tokens),
    // Only the Issue route sets this, in the response that mints the key; a render
    // reached any other way has nothing to reveal (§4: shown once, here).
    reveal: null,
  };
}

/** One grant string as §13's chip. §9 gives a grant exactly two spellings — `role` and
 *  `role:approval` — and admin writes no third, so the colon alone chooses the mode. */
function grantChip(spelled: string): AppGrantChip {
  const at = spelled.indexOf(":");
  const role = at < 0 ? spelled : spelled.slice(0, at);
  return { role, mode: at < 0 ? "allow" : "approval", builtin: role === BUILTIN_ROLE };
}

/** This app's live keys — `token_list`'s rows minus the revoked and the expired, which is
 *  what §13's "every live app token" means and what its marker counts. */
function liveAppTokens(tokens: TokenInfo[], slug: string, now: number): AppTokenRow[] {
  return tokens
    .filter(
      (token) =>
        token.kind === "app" &&
        token.refSlug === slug &&
        token.revokedAt === null &&
        (token.expiresAt === null || token.expiresAt > now),
    )
    .map((token) => ({
      id: token.id,
      prefix: token.prefix,
      createdAt: token.createdAt,
      lastUsedAt: token.lastUsedAt,
    }));
}

/**
 * §13's `?confirm=` state for this page. A dialog belongs to the pane that draws its
 * control, so the same query carried to another pane's URL opens nothing — and a
 * `revoke-token` naming no listed key opens nothing either, for the reason /settings's
 * dialogs do not: a dialog is about a row, and a guessed id names none.
 */
function appConfirm(query: URLSearchParams, pane: AppDetailPane, tokens: AppTokenRow[]): AppConfirm | null {
  const kind = query.get("confirm") ?? "";
  if (!Object.prototype.hasOwnProperty.call(APP_CONFIRM_PANE, kind)) return null;
  if (APP_CONFIRM_PANE[kind as AppConfirm["kind"]] !== pane) return null;
  if (kind !== "revoke-token") return { kind: kind as "archive" | "delete" };
  const id = query.get("id") ?? "";
  const row = tokens.find((token) => token.id === id);
  return row === undefined ? null : { kind: "revoke-token", id, prefix: row.prefix };
}

/** One family view's rows through `row`, leaving the two non-list answers alone — the
 *  only place `undeclared` and `unread` are carried across a mapping, so neither can be
 *  turned into an empty list by a `.map` on the way to a pane. */
async function mapped<Row>(
  view: AppFamilyView<ListedItem>,
  row: (item: ListedItem) => Row | Promise<Row>,
): Promise<AppFamilyView<Row>> {
  return view.state === "listed" ? { state: "listed", rows: await Promise.all(view.rows.map(row)) } : view;
}

/**
 * §13's rail marker for one §20 family, over the view(s) its pane draws. Three answers
 * that must stay three: a count, the dimmed `—` where the app advertises none, and the
 * empty string where a listing could not be read at all — "an unread count is not an
 * empty set", so unread is neither `—` nor `0`, and one unread half makes the whole
 * marker blank rather than reporting the half that answered.
 */
function familyMarker(...views: AppFamilyView<unknown>[]): string {
  if (views.some((view) => view.state === "unread")) return "";
  if (views.every((view) => view.state === "undeclared" || view.state === "unconnected")) return DIMMED;
  return String(views.reduce((total, view) => total + (view.state === "listed" ? view.rows.length : 0), 0));
}

/**
 * §13's header: identity, then whichever status the kind has. The status WORD is the one
 * §8's row already reports — a tunnel's `status`, a proxied oauth app's `connection` —
 * said in words rather than in the op's snake case, so the page names no state of its own.
 */
function appHeader(row: OpsAppRow, kind: AppKind, slug: string): AppDetailHeader {
  const oauth = row.kind === "proxy" && row.auth === "oauth";
  return {
    name: row.name,
    slug,
    kind,
    archived: row.archived,
    status: row.archived
      ? "archived"
      : row.kind === "tunnel"
        ? row.status
        : oauth
          ? (row.connection ?? "not_connected").replace(/_/g, " ")
          : null,
    lastSeen: row.kind === "tunnel" ? row.lastSeen : null,
    endpoint: row.kind === "proxy" ? row.endpoint : null,
    authMode: row.kind === "proxy" ? row.auth : null,
    forwardIdentity: row.kind === "proxy" ? row.forwardIdentity : null,
    // Connect and Reconnect are one target with two labels (`paths.appConnect` says why);
    // Disconnect wipes a stored bundle, so it is drawn only where one can exist.
    connect: oauth
      ? {
          label: row.kind === "proxy" && row.connection !== "not_connected" ? "Reconnect" : "Connect",
          href: paths.appConnect(slug),
        }
      : null,
    // §13 gives an `auth: oauth` app all three controls, so Disconnect is drawn whenever
    // there is a credential the app could be holding — the header is the app's own page,
    // not /apps's one-action-per-row table, and `app_disconnect` is idempotent (§8). Its
    // target is the app page's own dispatch, so the notice lands here (37(b)).
    disconnect: oauth ? paths.appHeaderDisconnect(slug) : null,
  };
}

/** The two §7 config maps `app_get`'s row already carries. Taken as a VALUE rather than
 *  re-read per row: `registry.redactPathsFor` runs an `app` SELECT per call, so a page
 *  looping over a catalog would pay `2×tools + prompts` reads for the maps in its hand. */
type RedactConfig = Pick<OpsAppRow, "redact" | "redactResults">;

/**
 * One Tools row with §13's "what only the hub knows" block attached. Every verdict in it
 * is the door's own: the mode comes from `registry.buildToolFilter` through catalog-view
 * (never a page matcher, which would be a page that lies about access), and the redaction
 * paths are `writeOnlyPaths` unioned with the config map exactly as the gateway unions
 * them before anything is stored or shown (§7).
 */
function toolRow(
  redact: RedactConfig,
  app: App,
  reachable: Reachability,
  tool: CatalogTool,
): AppToolRow {
  const name = tool.name ?? "";
  const description = typeof tool.description === "string" ? tool.description : "";
  const reach = reachable.reach(name, "tools");
  const args = redactPathsIn(redact.redact, name);
  const results = redactPathsIn(redact.redactResults, name);
  return {
    name,
    aggregated: `${app.slug}_${name}`,
    description,
    summary: description.split("\n")[0],
    args: argumentRows(tool.inputSchema),
    reach,
    // §2's allow-wins is already inside the door's verdict, so an agent holding both an
    // allow role and an approval role on this tool arrives here as `allow` and is named
    // by the reachability line alone.
    approvalAgents: reach.filter((entry) => entry.mode === "approval").map((entry) => entry.agent),
    redactedArgs: [...new Set([...writeOnlyPaths(tool.inputSchema), ...args])],
    redactedResults: results,
    schemaUnsound: validateSchemaIndirection(tool.inputSchema).length > 0,
  };
}

/**
 * One `prompts/list` entry with §13's hub block attached (§20.2/§20.3). The reachability
 * runs over the role's PROMPT patterns — the same door, a different keyspace, which is
 * what makes a tools-only role reach no prompt — and the redaction is `redact` matched
 * against the prompt's name, the maps being family-blind. There is no results half: §20.4
 * puts prompt results outside the question entirely.
 */
function promptRow(
  redact: RedactConfig,
  app: App,
  reachable: Reachability,
  item: CatalogPrompt,
): AppPromptRow {
  const name = item.name ?? "";
  return {
    name,
    aggregated: `${app.slug}_${name}`,
    description: typeof item.description === "string" ? item.description : "",
    args: (Array.isArray(item.arguments) ? item.arguments : []).map((argument) => ({
      name: typeof argument?.name === "string" ? argument.name : "",
      description: typeof argument?.description === "string" ? argument.description : "",
      required: argument?.required === true,
    })),
    reach: reachable.reach(name, "prompts"),
    redacted: redactPathsIn(redact.redact, name),
  };
}

/** One resource or template row — §13's three columns plus who reaches it. A template's
 *  `URI` is its RAW `uriTemplate`, which is both what the column shows and the string the
 *  matcher is given: grants match resources by URI, never by name (§20.3). */
function resourceRow(item: ListedItem, reachable: Reachability): AppResourceRow {
  const described = item as ListedItem & { mimeType?: unknown };
  const uri = item.uri ?? item.uriTemplate ?? "";
  return {
    uri,
    name: item.name ?? "",
    mimeType: typeof described.mimeType === "string" ? described.mimeType : "",
    reach: reachable.reach(uri, "resources"),
  };
}

/* ------------------------------- /apps/new -------------------------------- */

/** /apps/new — a chromeless page whose whole state is the step web.ts is in:
 *  the empty form, the form re-rendered with what the owner typed and why it was
 *  refused, or the once-only token reveal. No read at all. */
export function appNewProps(ctx: PageContext, step: AppNewStep): AppNewProps {
  return { now: ctx.now, username: ctx.username, csrfToken: ctx.csrfToken, step };
}

/** The add-app form as the query string carries it back — an empty form on a
 *  first visit, the owner's own values on a re-render. */
export function appNewForm(query: URLSearchParams): AppNewForm {
  const kind = query.get("kind") === "proxy" ? "proxy" : "tunnel";
  const authMode = query.get("authMode") === "oauth" ? "oauth" : "headers";
  return {
    kind,
    name: query.get("name") ?? "",
    slug: query.get("slug") ?? "",
    endpoint: query.get("endpoint") ?? "",
    authMode,
  };
}

/* -------------------------------- /approvals ---------------------------------- */

/** How many decided rows /approvals shows before "Older →" widens the limit. */
const HISTORY_LIMIT = 20;

/**
 * /approvals from `approval_list`: the pending rows (which are also the shell's
 * badge) and the decided ones. History is capped, not paged — the tool takes
 * `limit` and no offset (§8) — so "Older →" asks for a bigger limit and this
 * reads one row past it to know whether the link is worth rendering.
 */
export async function approvalsProps(ctx: PageContext): Promise<ApprovalsProps> {
  const historyLimit = positive(ctx.query.get("limit")) ?? HISTORY_LIMIT;
  const pending = await pendingOf(ctx);
  const listed = await read<{ approvals: ApprovalRow[] }>(ctx, "approval_list", {
    // The limit caps the WHOLE list, pending rows included, so the pending ones
    // are paid for here — otherwise a namespace with many open requests would
    // show no history at all.
    limit: historyLimit + pending.length + 1,
  });
  const decided = listed.approvals.filter((row) => row.status !== "pending");
  return {
    ...(await shell(ctx, "approvals", pending)),
    csrfToken: ctx.csrfToken,
    pending,
    history: decided.slice(0, historyLimit),
    historyLimit,
    hasMoreHistory: decided.length > historyLimit,
    // Configuration, not a read: the browser needs the public half to subscribe,
    // and approvals owns everything that happens after (§13).
    vapidPublicKey: env.VAPID_PUBLIC_KEY,
  };
}

/**
 * /approvals/<id> — one row of the same owner-scoped listing, found by id. A row
 * in another namespace is not in this listing at all, so a foreign id and an
 * invented one are ONE answer (null), exactly as §7 wants them to be.
 */
export async function approvalDetailProps(
  ctx: PageContext,
  id: string,
): Promise<ApprovalDetailProps | null> {
  const listed = await read<{ approvals: ApprovalRow[] }>(ctx, "approval_list", {
    limit: APPROVAL_LOOKUP_LIMIT,
  });
  const approval = listed.approvals.find((row) => row.id === id);
  if (approval === undefined) return null;
  return { now: ctx.now, csrfToken: ctx.csrfToken, approval: decided(approval) };
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
 *  bound on one page render, not a policy about what exists. */
const APPROVAL_LOOKUP_LIMIT = 1000;

/* ---------------------------------- /audit ------------------------------------ */

/** The page size when the owner has not chosen one (the pager offers 25/50/100). */
const AUDIT_PAGE_SIZE = 50;

/**
 * How many matching rows the tiles and the histogram are computed over. The
 * stated ceiling of this page: `events` is `audit_query`'s exact total, and
 * everything derived per-row (tool calls, denials, the latency pair, every
 * bucket) is over at most the newest this-many rows of the same window. A
 * filtered window on a personal hub is far smaller than this; a window that is
 * not says so by the tiles lagging the total, which is the honest failure.
 */
const AUDIT_SCAN_ROWS = 1000;

/** How many columns "Events over time" draws, whatever the window. */
const AUDIT_BUCKETS = 24;

/** The window the segmented control starts on. */
const AUDIT_DEFAULT_RANGE = "24h" as const;

const RANGE_SPAN_MS: Record<Exclude<AuditRange, "custom">, number> = {
  "1h": 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

/**
 * /audit — four reads of one tool. The page's rows and its "N events match" line
 * are `audit_query`'s `{ rows, total }` verbatim (§8's one paging contract, which
 * the desktop pager and the mobile "Load more" are two presentations of); the
 * previous window's total is what the delta is a fact about; a bounded scan of
 * the same window feeds the tiles and the histogram; and an UNFILTERED scan
 * feeds the three select controls, because a filter must be able to name a
 * principal whose events fell outside the current window.
 */
export async function auditProps(ctx: PageContext): Promise<AuditProps> {
  const filters = auditFilters(ctx);
  const scoped = auditQueryOf(filters);
  const [page, scan, previous, everything] = await Promise.all([
    read<{ rows: AuditRow[]; total: number }>(ctx, "audit_query", {
      ...scoped,
      limit: filters.limit,
      offset: filters.offset,
    }),
    read<{ rows: AuditRow[]; total: number }>(ctx, "audit_query", {
      ...scoped,
      limit: AUDIT_SCAN_ROWS,
    }),
    read<{ rows: AuditRow[]; total: number }>(ctx, "audit_query", {
      ...scoped,
      since: filters.since - (filters.until - filters.since),
      until: filters.since - 1,
      limit: 1,
    }),
    read<{ rows: AuditRow[]; total: number }>(ctx, "audit_query", { limit: AUDIT_SCAN_ROWS }),
  ]);
  return {
    ...(await shell(ctx, "audit")),
    // Read-only page, so the flash the shell carries for the others is dropped here
    // rather than rendered: no route redirects back to /audit with an outcome.
    notice: null,
    filters,
    options: filterOptions(everything.rows),
    rows: page.rows.map(eventRow),
    paging: { offset: filters.offset, limit: filters.limit, total: page.total },
    stats: auditStats(page.total, previous.total, scan.rows),
    histogram: auditHistogram(filters, scan.rows),
    expandedId: positive(ctx.query.get("expand")) ?? null,
    retentionDays: auditConfig().retentionDays,
  };
}

/**
 * The page's filter state, read off its own query string. `since`/`until` are
 * always resolved — a preset is a window, not a mode — so the export link, the
 * histogram and the tiles all cover exactly what the table shows.
 */
export function auditFilters(ctx: PageContext): AuditFilters {
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
 * The filters as `audit_query` takes them — the page's state minus the two
 * fields that are the page's own (`range` is which preset produced the window,
 * `limit`/`offset` are the caller's page). This is also what the JSONL export
 * is handed, which is what makes the export a serialization of the same read
 * rather than a second one (§13).
 */
export function auditQueryOf(filters: AuditFilters): AuditQuery {
  const { range: _range, limit: _limit, offset: _offset, ...query } = filters;
  return query;
}

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

/** One audit row as the page sees it: the namespace id dropped (every row here
 *  belongs to the viewer's own, and carrying it would only invite rendering it). */
function eventRow(row: AuditRow): AuditEventRow {
  const { ownerId: _ownerId, args, result, ...rest } = row;
  return {
    ...rest,
    ...(args === undefined ? {} : { args: args as RecordedBody }),
    ...(result === undefined ? {} : { result: result as RecordedBody }),
  };
}

/** The three selects' values, from the namespace rather than from the visible
 *  page — sorted, so the control does not reshuffle as events arrive. */
function filterOptions(rows: AuditRow[]): AuditFilterOptions {
  const principals = new Set<string>();
  const apps = new Set<string>();
  const events = new Set<string>();
  for (const row of rows) {
    principals.add(row.principal);
    if (row.app !== undefined) apps.add(row.app);
    events.add(row.event);
  }
  const sorted = (values: Set<string>): string[] => [...values].sort();
  return { principals: sorted(principals), apps: sorted(apps), events: sorted(events) };
}

/** The four tiles. `events` is exact; everything per-row is over the scan (see
 *  AUDIT_SCAN_ROWS), and a delta with no previous window to compare against is
 *  null rather than a number nobody can read. */
function auditStats(total: number, previousTotal: number, scan: AuditRow[]): AuditStats {
  const durations = scan
    .map((row) => row.durationMs)
    .filter((ms): ms is number => typeof ms === "number")
    .sort((a, b) => a - b);
  return {
    events: total,
    eventsDeltaPct: previousTotal === 0 ? null : Math.round(((total - previousTotal) / previousTotal) * 100),
    toolCalls: scan.filter((row) => row.event === "tools/call").length,
    // The two codes the row badge itself calls "denied" (§7's filter refusals);
    // an approval-required row is not a denial, it is a question.
    denied: scan.filter((row) => DENIED_OUTCOMES.has(row.outcome)).length,
    medianDurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
  };
}

/** §7's two "you may not" codes: not permitted, and not permitted on this tool. */
const DENIED_OUTCOMES: ReadonlySet<string> = new Set(["-32000", "-32001"]);

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const at = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[at];
}

/** "Events over time" over the visible window: one bucket size for both
 *  breakpoints, and the peak carried so an empty window still draws an axis. */
function auditHistogram(filters: AuditFilters, scan: AuditRow[]): AuditHistogram {
  const span = Math.max(filters.until - filters.since, 60_000);
  const bucketMs = Math.max(60_000, Math.ceil(span / AUDIT_BUCKETS));
  // Nothing matched: no bars rather than 24 flat ones (G50). The bucket size stays
  // derived because the caption describes the window, not the data. Page and scan share
  // the window, so this always co-occurs with the table's own empty state — never the
  // reverse, since an `offset` past `total` empties the table with the bars intact.
  if (scan.length === 0) return { bucketMs, buckets: [], peak: 0 };
  const counts = new Array<number>(AUDIT_BUCKETS).fill(0);
  for (const row of scan) {
    const at = Math.floor((row.ts - filters.since) / bucketMs);
    if (at >= 0 && at < counts.length) counts[at] += 1;
  }
  return {
    bucketMs,
    buckets: counts.map((count, at) => ({
      start: new Date(filters.since + at * bucketMs).toISOString(),
      count,
    })),
    peak: counts.reduce((high, count) => Math.max(high, count), 0),
  };
}

/* --------------------------------- /settings ----------------------------------- */

/**
 * /settings — the one page whose state is better-auth's rather than the ops
 * table's, and §4 gives better-auth exactly one custodian: identity. So this
 * reads it the way the browser does, through identity's own mounted endpoints,
 * rather than reaching into tables that module owns.
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
export async function settingsProps(
  ctx: PageContext,
  req: Request,
  pane: SettingsPane,
): Promise<SettingsProps> {
  // §13's shell rule, as code: ONE read per render feeding both the rail and the pane, so
  // a marker cannot be a second query that disagrees with the list beside it. Every pane
  // pays for all five, which is the price of a rail that is always right.
  const [me, sessions, passkeys, lastUsed, tokens, connections] = await Promise.all([
    callAuth<{ user?: { twoFactorEnabled?: boolean } }>(req, "/get-session"),
    callAuth<BetterAuthSession[]>(req, "/list-sessions"),
    callAuth<BetterAuthPasskey[]>(req, "/passkey/list-user-passkeys"),
    // §5's own column, which the plugin's listing cannot carry (identity says why).
    passkeyLastUsed(ctx.ownerId),
    read<{ tokens: TokenInfo[] }>(ctx, "token_list"),
    read<{ connections: ConnectionRow[] }>(ctx, "connection_list"),
  ]);
  // better-auth's listings, defended: the shapes are better-auth's own to change, and
  // /settings showing an empty list is a better answer than a 500 (callAuth's contract
  // reads a bodiless success as `{}`, which is not a listing).
  const rows = (Array.isArray(sessions) ? sessions : []).map((row) => sessionRow(row, ctx.sessionId));
  const keys = (Array.isArray(passkeys) ? passkeys : []).map((pk) =>
    passkeyRow(pk, ctx.now, lastUsed[pk.id]),
  );
  const bound = tokenRows(tokens.tokens, Date.parse(ctx.now));
  return {
    ...(await shell(ctx, "settings")),
    pane,
    csrfToken: ctx.csrfToken,
    twoFactor: me?.user?.twoFactorEnabled ? { enabled: true } : { enabled: false },
    enrollment: null,
    revealedBackupCodes: null,
    passkeys: keys,
    sessions: rows,
    tokens: bound,
    tokenKind: tokenKindOf(ctx.query),
    connections: connections.connections,
    confirm: settingsConfirm(ctx.query, pane, rows, keys, connections.connections),
    passwordError: passwordErrorOf(ctx.query, pane),
  };
}

/** The field a refused **Update password** left on the URL, read back on the pane that
 *  drew the form — the same "a mutation belongs to a pane" rule the dialogs follow. */
function passwordErrorOf(query: URLSearchParams, pane: SettingsPane): PasswordField | null {
  if (pane !== "password" || query.get(NOTICE_KEYS.failed) === null) return null;
  const field = query.get(NOTICE_KEYS.field);
  return PASSWORD_FIELDS.find((name) => name === field) ?? null;
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

/** §13's `?kind=agent|app`, or null for **All** — anything else is All too, because a
 *  filter naming no kind is not a filter (and never an empty listing). */
function tokenKindOf(query: URLSearchParams): TokenRow["kind"] | null {
  const kind = query.get("kind");
  return kind === "agent" || kind === "app" ? kind : null;
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

/**
 * Which destructive dialog /settings is rendering, read off its own query string — the
 * `?confirm=…` link every Remove/Revoke/Disable control on the page already points at
 * (`paths.settingsConfirm`). Server-rendered state, so the confirm step works with
 * scripting off; a `confirm` that names no row on the page is no dialog at all rather
 * than a dialog about nothing, which is also what keeps a guessed id from drawing one.
 */
function settingsConfirm(
  query: URLSearchParams,
  pane: SettingsPane,
  sessions: SessionRow[],
  passkeys: PasskeyRow[],
  connections: ConnectionRow[],
): SettingsConfirm | null {
  const kind = query.get("confirm") ?? "";
  // A dialog belongs to the pane that draws its control: the same query carried to another
  // pane's URL opens nothing, which is what makes "?confirm= rides the owning pane" a
  // property of the page rather than of the links it happens to render.
  if (!Object.prototype.hasOwnProperty.call(SETTINGS_CONFIRM_PANE, kind)) return null;
  if (SETTINGS_CONFIRM_PANE[kind as SettingsConfirm["kind"]] !== pane) return null;
  const id = query.get("id") ?? "";
  switch (kind) {
    case "disable-two-factor":
      return { kind: "disable-two-factor" };
    case "revoke-session": {
      const row = sessions.find((session) => session.id === id && !session.current);
      return row === undefined ? null : { kind: "revoke-session", id, label: sessionLabel(row) };
    }
    // The one confirmation that names no row, so there is nothing to look up and nothing
    // a guessed id could miss: it is about every session except the one asking.
    case "revoke-other-sessions":
      return { kind: "revoke-other-sessions" };
    case "remove-passkey": {
      const row = passkeys.find((pk) => pk.id === id);
      return row === undefined ? null : { kind: "remove-passkey", id, name: row.name };
    }
    case "revoke-connection": {
      // A revoked binding stays listed with no control (§13), so it draws no dialog
      // either — the query naming one is the same as a query naming nothing.
      const row = connections.find((c) => c.id === id && c.revokedAt === null);
      return row === undefined
        ? null
        : { kind: "revoke-connection", id, client: row.clientName ?? row.clientId };
    }
    default:
      return null;
  }
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
 * /device — the one loader whose read is not the ops table's: the user code's whole
 * lifecycle is better-auth's (§4), so this asks identity's door about it rather than
 * any table. `req` is here for exactly that: `callAuth` carries the caller's cookie.
 */
export async function deviceProps(ctx: PageContext, req: Request): Promise<DeviceProps> {
  return {
    now: ctx.now,
    username: ctx.username,
    csrfToken: ctx.csrfToken,
    step: await deviceStep(ctx, req),
  };
}

/**
 * /device's three moments (§13). A code arrives on the query string — the CLI prints a
 * deep link — and better-auth's own verify endpoint is what says whether it is live and
 * whose it is; an unknown or expired code comes back as `enter-code` with the error, which
 * is the same recovery either way: type another code.
 */
async function deviceStep(ctx: PageContext, req: Request): Promise<DeviceStep> {
  const decided = ctx.query.get("decided");
  if (decided === "approved" || decided === "denied") {
    return { kind: "decided", decision: decided };
  }
  const userCode = ctx.query.get("user_code");
  if (userCode === null || userCode === "") {
    return { kind: "enter-code", userCode: "", error: ctx.query.get("error") };
  }
  const verified = await callAuth<{ client_id?: string }>(
    req,
    `/device?user_code=${encodeURIComponent(userCode)}`,
  );
  if (verified === null) {
    return { kind: "enter-code", userCode, error: "That code is not valid. Check it and try again." };
  }
  return {
    kind: "confirm",
    request: {
      userCode,
      // KNOWN CEILING, and the reason it is spelled rather than guessed: RFC 8628 §5.4
      // wants the REQUESTING device's address and client, and better-auth's deviceCode
      // record carries neither (its columns are code, user, status, expiry, client_id,
      // scope). Rendering this browser's own IP would be worse than saying nothing: it
      // would look like corroboration while corroborating nothing.
      ip: "unknown",
      client: verified.client_id ?? "unknown",
      requestedAt: ctx.now,
      // The record's own expiry is not returned either, so this is the window's upper
      // bound (§13's shortened device-code lifetime), which is what the page says.
      expiresAt: new Date(Date.parse(ctx.now) + DEVICE_CODE_TTL_MS).toISOString(),
    },
  };
}

/* ------------------------------------- /oauth/consent (§19.5) ------------------------------------- */

/**
 * /oauth/consent — the whole read, off the SIGNED query string the provider redirected the
 * browser here with and nothing else. `req.url`'s raw search string IS `oauth_query`
 * (§19.5 step 2: "the page cannot invent, drop or edit a parameter"), so it is read here
 * ONCE, echoed back unread by anything downstream, and handed to the provider's own
 * `/oauth2/public-client-prelogin` — which re-verifies the signature (§19.5 step 2's
 * blocking probe observation: "public-client-prelogin wants client_id alongside
 * oauth_query"). `null` means that verification failed — an edited or expired query, or an
 * unknown client — and the caller (web.ts) answers a plain 400 rather than rendering a
 * page whose every field would be unverified.
 *
 * `clientSelfRegistered` is read directly off `oauthClient` rather than through an admin op:
 * no op fronts it (nothing else in this hub needs it), it names no capability an agent or
 * the CLI could invoke instead, and it is display-only — so it joins /settings's better-auth
 * reads and /audit's stats as a named exception to "every loader reads through admin.ops"
 * rather than a silent one.
 */
export async function consentProps(ctx: PageContext, req: Request): Promise<ConsentProps | null> {
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
    now: ctx.now,
    csrfToken: ctx.csrfToken,
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
