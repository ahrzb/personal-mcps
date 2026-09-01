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
import { ops } from "../admin";
import type { AppRow as OpsAppRow } from "../admin";
import { config as auditConfig } from "../audit";
import { AUTH_BASE_PATH, callAuth } from "../identity";
import type { TokenInfo } from "../identity";
import { DEVICE_CODE_TTL_MS } from "../limits";
import type { AppDetail, AppKind } from "../registry";
import type { ApprovalListFilters, ApprovalRow, ApprovalStatus } from "../approvals";
import type { AuditRow, BodyStub, AuditQuery } from "../audit";
import type { UpstreamConnectionStatus } from "../upstream";
import type { status as tunnelStatus } from "../tunnel";

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
 * onto the design system's four alert palettes (Main.dc.html): info is the muted
 * #f4f4f5 note, success #f0fdf4, warning #fffbeb, danger #fef2f2.
 */
export type Notice = {
  tone: "info" | "success" | "warning" | "danger";
  /** Optional bold first line; the alert renders message-only when absent. */
  title?: string;
  message: string;
};

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
  /** Credential management — cookie session with recent auth only (§4). */
  settings: "/settings",
  /** App management: active, archived, and the add-app entry point. */
  apps: "/apps",
  /** The add-app form (§13's "add-app flow"). */
  appNew: "/apps/new",
  /** Pending requests plus decision history. */
  approvals: "/approvals",
  /** Read-only view over audit.query with its exact filters. */
  audit: "/audit",
  /** §19.5's consent screen — an external client's authorization request, and the
   *  agent picker that decides how much power it gets. */
  oauthConsent: "/oauth/consent",
  /** §19.6/§8's connections list, with Revoke. */
  oauthConnections: "/oauth/connections",

  /* --- the PWA shell (§13) --- */

  /** Installability. Named here because web.ts serves it; layout.tsx spells the same
   *  three URLs itself, since the shell links them rather than navigating to them. */
  manifest: "/manifest.webmanifest",
  /** Push + notificationclick only — never a fetch handler (the no-SPA pin). */
  serviceWorker: "/sw.js",
  /** The one stylesheet every page's document head links. */
  stylesheet: "/styles.css",

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
  /** app_disconnect — wipes the stored bundle, keeps everything else (§8). */
  appDisconnect(slug: string): string {
    return `/apps/app_disconnect${query({ slug })}`;
  },
  /** connection_revoke (§8/§19.6) — the /oauth/connections Revoke button. */
  connectionRevoke(id: string): string {
    return `/oauth/connections/connection_revoke${query({ id })}`;
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
  settingsConfirm(kind: SettingsConfirm["kind"], id?: string): string {
    return `/settings${query({ confirm: kind, id })}`;
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
   * Two stay on better-auth's mount: `signInPasskey` and `passkeyRegister` are WebAuthn
   * ceremonies, never a form post in the first place, so there is no form body to
   * translate at all (see login.tsx's deliberately inert passkey button).
   */
  auth: {
    /** Where the composition root mounts better-auth — the prefix the two untranslated
     *  paths below carry, and the prefix identity's `callAuth` builds on. identity's, not
     *  this file's: the mount and the base path better-auth itself routes on are one
     *  decision (identity.AUTH_BASE_PATH). */
    base: AUTH_BASE_PATH,
    signIn: "/login/sign-in/username",
    signInPasskey: "/api/auth/sign-in/passkey",
    signOut: "/login/sign-out",
    /** /login's challenge card posts here, and so would /settings's enrollment card —
     *  which cannot render today (see settingsProps's note on `enrollment`). */
    totpVerify: "/login/two-factor/verify-totp",
    backupCodeVerify: "/login/two-factor/verify-backup-code",
    totpEnable: "/settings/two-factor/enable",
    totpDisable: "/settings/two-factor/disable",
    backupCodesGenerate: "/settings/two-factor/generate-backup-codes",
    passkeyRegister: "/api/auth/passkey/generate-register-options",
    passkeyDelete: "/settings/passkey/delete-passkey",
    sessionRevoke: "/settings/revoke-session",
  },
} as const;

/* ------------------------------------------------------------------ *
 * /login
 * ------------------------------------------------------------------ */

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
 * The steady state of the second factor. `backupCodesRemaining` counts codes not
 * yet spent; `generatedAt` (ISO-8601) is when the current set was minted — both
 * render as the one line under the enabled badge.
 */
export type TwoFactorSummary =
  | { enabled: false }
  | { enabled: true; backupCodesRemaining: number; generatedAt: string };

/**
 * The in-progress TOTP enrollment (SettingsStates.dc.html "TOTP setup"): present
 * only while the owner is between "Enable two-factor" and a verified code.
 * `secret` is the base32 shown under the QR for manual entry — it is a
 * credential in flight, never persisted by a page and never logged (§15).
 */
export type TotpEnrollment = {
  /** The otpauth:// QR as a self-contained data: URI — no external image fetch. */
  qrDataUri: string;
  /** The same secret in its grouped display form: "JBSW Y3DP EHPK 3PXP". */
  secret: string;
  /** Set when a submitted code did not verify. */
  error: string | null;
};

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
  | { kind: "revoke-session"; id: string; client: string };

/**
 * /settings — the pinned parity exception (§8): credential management rides
 * better-auth's endpoints and has no pmcp tool, and §4's guards reject
 * bearer-sourced sessions here entirely.
 *
 * `enrollment` and `revealedBackupCodes` are transient overlays on top of
 * `twoFactor`, not alternatives to it: enrollment can only be non-null while
 * `twoFactor.enabled` is false, and a fresh code set is revealed exactly once —
 * after enabling or regenerating — because nothing can show it again (§4).
 */
export type SettingsProps = ShellProps & {
  section: "settings";
  csrfToken: string;
  twoFactor: TwoFactorSummary;
  enrollment: TotpEnrollment | null;
  revealedBackupCodes: string[] | null;
  passkeys: PasskeyRow[];
  sessions: SessionRow[];
  confirm: SettingsConfirm | null;
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
  approval: ApprovalRow;
};

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
 * /oauth/connections (§19.6/§8/§13)
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
};

/**
 * /oauth/connections — chromeless like /oauth/consent: a settings page reached from a
 * link, not part of the four-section shell (§13 names no nav slot for it).
 */
export type ConnectionsProps = PageProps & {
  csrfToken: string;
  connections: ConnectionRow[];
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
  agent: SettingsProps;
  apps: AppsProps;
  "app-new": AppNewProps;
  approvals: ApprovalsProps;
  "approval-detail": ApprovalDetailProps;
  audit: AuditProps;
};

/** The eight page keys of §13, as a type. */
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
  return { now: ctx.now, csrfToken: ctx.csrfToken, approval };
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
  const since = positive(ctx.query.get("since"));
  const until = positive(ctx.query.get("until"));
  const window =
    since !== null && until !== null
      ? { since, until, range: rangeOf(until - since) }
      : { since: now - RANGE_SPAN_MS[AUDIT_DEFAULT_RANGE], until: now, range: AUDIT_DEFAULT_RANGE };
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
 * THREE things are not sourceable through those endpoints today. Two are reported
 * as what they are rather than invented: `passkeys` is empty because the passkey
 * plugin is not installed at all (identity's auth() says so), and every session
 * reads as `source: "web"` because nothing better-auth stores distinguishes a
 * device-flow session from a browser one — the distinction identity enforces is
 * the cookie's signature, not a column.
 *
 * The third IS invented, and this comment exists so no reader concludes otherwise:
 * `backupCodesRemaining`/`generatedAt` have no endpoint behind them (`/get-session`
 * reports `twoFactorEnabled` and nothing else; the codes live encrypted in a table
 * §4 gives identity sole custody of), so an owner with 2FA on is told "0 backup
 * codes remaining · generated <now>" on every render, which is false in both halves.
 * The honest shape is a nullable pair rendered as "—", exactly like the two above —
 * but `TwoFactorSummary`'s enabled arm is a template contract (settings.tsx passes
 * `generatedAt` straight into a `(iso: string)` formatter), so widening it is a
 * change to a page template and is REPORTED rather than made here. All three are
 * findings for the owner, not placeholders to be quietly kept.
 */
export async function settingsProps(ctx: PageContext, req: Request): Promise<SettingsProps> {
  const [me, sessions] = await Promise.all([
    callAuth<{ user?: { twoFactorEnabled?: boolean } }>(req, "/get-session"),
    callAuth<BetterAuthSession[]>(req, "/list-sessions"),
  ]);
  // better-auth's listing, defended: the shape is better-auth's own to change, and
  // /settings showing an empty list is a better answer than a 500 (callAuth's contract
  // reads a bodiless success as `{}`, which is not a listing).
  const rows = (Array.isArray(sessions) ? sessions : []).map((row) => sessionRow(row, ctx.sessionId));
  return {
    ...(await shell(ctx, "settings")),
    csrfToken: ctx.csrfToken,
    twoFactor: me?.user?.twoFactorEnabled
      ? { enabled: true, backupCodesRemaining: 0, generatedAt: ctx.now }
      : { enabled: false },
    enrollment: null,
    revealedBackupCodes: null,
    passkeys: [],
    sessions: rows,
    confirm: settingsConfirm(ctx.query, rows),
  };
}

/**
 * Which destructive dialog /settings is rendering, read off its own query string — the
 * `?confirm=…` link every Remove/Revoke/Disable control on the page already points at
 * (`paths.settingsConfirm`). Server-rendered state, so the confirm step works with
 * scripting off; a `confirm` that names no row on the page is no dialog at all rather
 * than a dialog about nothing, which is also what keeps a guessed id from drawing one.
 *
 * `remove-passkey` can never match: the passkey plugin is not installed, so `passkeys`
 * is always empty (see this function's caller). It is spelled anyway, because the
 * missing arm would otherwise read as an oversight rather than as that ceiling.
 */
function settingsConfirm(query: URLSearchParams, sessions: SessionRow[]): SettingsConfirm | null {
  const id = query.get("id") ?? "";
  switch (query.get("confirm")) {
    case "disable-two-factor":
      return { kind: "disable-two-factor" };
    case "revoke-session": {
      const row = sessions.find((session) => session.id === id && !session.current);
      return row === undefined ? null : { kind: "revoke-session", id, client: row.client };
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
};

function sessionRow(row: BetterAuthSession, current: string): SessionRow {
  return {
    id: row.id,
    // Untrusted display data, shown as the client sent it and never parsed.
    client: row.userAgent?.slice(0, 80) || "Unknown client",
    source: "web",
    createdAt: new Date(row.createdAt).toISOString(),
    lastActiveAt: new Date(row.updatedAt).toISOString(),
    current: row.id === current,
  };
}

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
    // carries no `sig`/`client_id` pair, so nothing here changes for it.
    redirectTo: oauthRedirectTarget(query, rawSearch) ?? query.get("next"),
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

/* ------------------------------------- /oauth/connections (§19.6/§8) ------------------------------------- */

/** /oauth/connections — `connection_list` unchanged (§8's parity invariant): the page shows
 *  nothing the CLI or an agent holding an admin token could not also read. */
export async function connectionsProps(ctx: PageContext): Promise<ConnectionsProps> {
  // deps: admin.ops (connection_list)
  const listed = await read<{ connections: ConnectionRow[] }>(ctx, "connection_list");
  return { now: ctx.now, csrfToken: ctx.csrfToken, connections: listed.connections };
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
