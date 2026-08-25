// model.ts — the view-model contract between the page handlers (web.ts) and the
// templates in this directory, plus the ONE definition of the hub's browser URL
// space.
//
// OWNS: one Props type per page of §13, the shared chrome those pages render
// inside, and the `paths` object every inter-page link and form action is built
// from. HIDES: nothing about the domain — every field here is either lifted
// straight from a skeleton read model (registry / approvals / audit / upstream /
// tunnel, via type-only imports) or is an explicitly derived projection of one.
// Where a page needs less than a read model offers, it says so with Pick/Omit
// rather than restating a shape that could then drift.
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
// (ApprovalRow) and epoch milliseconds in registry/audit (ServiceDetail,
// AuditRow) — and this file keeps each field exactly as its source states it.
// `now` is ISO-8601; a template comparing it with an epoch-ms field parses it
// (Date.parse) rather than reaching for a clock of its own.

import type { ServiceDetail, ServiceKind } from "../registry";
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
 * /services/new, /approvals/<id> — are chromeless card layouts and carry no
 * section at all, which is why this never has a "none" member.
 */
export type NavSection = "services" | "audit" | "approvals" | "account";

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
  "principal" | "service" | "event" | "tool" | "session" | "since" | "until" | "limit" | "offset"
>;

/**
 * Every URL the browser surface serves or posts to, in one object — templates
 * import this and never spell a path themselves, so a route rename is one edit
 * here instead of a search across eight templates. Page routes come straight
 * from §13; sub-paths under them are this file's decision and are what web.ts's
 * route table mounts. The reserved-segment rule of §2 holds by construction:
 * nothing here introduces a new top-level segment beyond login, device, account,
 * audit, approvals, services, api and oauth.
 *
 * Mutating targets are POST-only and CSRF-checked; the read targets are GET.
 * Both are named for what they do, not for their method.
 */
export const paths = {
  /* --- pages (§13) --- */

  /** Username + password, TOTP challenge, backup code, passkey button. */
  login: "/login",
  /** RFC 8628 device approval; deep-linked from the CLI as `?user_code=…`. */
  device: "/device",
  /** Credential management — cookie session with recent auth only (§4). */
  account: "/account",
  /** Service management: active, archived, and the add-service entry point. */
  services: "/services",
  /** The add-service form (§13's "add-service flow"). */
  serviceNew: "/services/new",
  /** Pending requests plus decision history. */
  approvals: "/approvals",
  /** Read-only view over audit.query with its exact filters. */
  audit: "/audit",

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

  /** Approve/deny the device code; the decision rides a submit button's value. */
  deviceDecide: "/device/decide",
  /** approval_decide (§8) for one request; approve and reject share the form. */
  approvalDecide(id: string): string {
    return `/approvals/${encodeURIComponent(id)}/decide`;
  },
  /** Where the browser's PushSubscription JSON is registered (approvals.subscribePush). */
  approvalsPush: "/approvals/push",
  /** service_create; on `auth: oauth` the response redirects into consent (§7). */
  serviceCreate: "/services/new",
  serviceArchive(slug: string): string {
    return `/services/${encodeURIComponent(slug)}/archive`;
  },
  serviceUnarchive(slug: string): string {
    return `/services/${encodeURIComponent(slug)}/unarchive`;
  },
  serviceDelete(slug: string): string {
    return `/services/${encodeURIComponent(slug)}/delete`;
  },
  /**
   * Connect and Reconnect are the same target: both start upstream.beginConnect
   * and redirect to the provider (§7). The button label differs, the flow does
   * not.
   */
  serviceConnect(slug: string): string {
    return `/services/${encodeURIComponent(slug)}/connect`;
  },
  /** service_disconnect — wipes the stored bundle, keeps everything else (§8). */
  serviceDisconnect(slug: string): string {
    return `/services/${encodeURIComponent(slug)}/disconnect`;
  },

  /* --- confirm dialogs as addressable state --- */

  /**
   * The same page with one destructive <dialog> rendered open. Server-rendered
   * state, so the confirm step works with scripting off and is reachable from a
   * fixture; a browser that supports invoker commands opens the identical dialog
   * without the round trip.
   */
  servicesConfirmDelete(slug: string): string {
    return `/services${query({ confirm: "delete", slug })}`;
  },
  accountConfirm(kind: AccountConfirm["kind"], id?: string): string {
    return `/account${query({ confirm: kind, id })}`;
  },

  /* --- the consumer endpoint a page only ever displays --- */

  /**
   * The scoped MCP endpoint of one service — shown, never linked: /services/new
   * spells it out under the slug field ("served at /ahrzb/mcp/linear") so the
   * owner sees what they are naming.
   */
  mcpScoped(username: string, slug: string): string {
    return `/${encodeURIComponent(username)}/mcp/${encodeURIComponent(slug)}`;
  },

  /**
   * better-auth's mount (§4). The credential family is deliberately never a pmcp
   * tool and never a hub-owned route, so /login and /account post straight here.
   * The spellings are pinned in this one place: if the plugin set is remounted,
   * no template changes.
   */
  auth: {
    signIn: "/api/auth/sign-in/username",
    signInPasskey: "/api/auth/sign-in/passkey",
    signOut: "/api/auth/sign-out",
    totpVerify: "/api/auth/two-factor/verify-totp",
    backupCodeVerify: "/api/auth/two-factor/verify-backup-code",
    totpEnable: "/api/auth/two-factor/enable",
    totpDisable: "/api/auth/two-factor/disable",
    backupCodesGenerate: "/api/auth/two-factor/generate-backup-codes",
    passkeyRegister: "/api/auth/passkey/generate-register-options",
    passkeyDelete: "/api/auth/passkey/delete-passkey",
    sessionRevoke: "/api/auth/revoke-session",
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
 * /account
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
 * The in-progress TOTP enrollment (AccountStates.dc.html "TOTP setup"): present
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
export type AccountConfirm =
  | { kind: "disable-two-factor" }
  | { kind: "remove-passkey"; id: string; name: string }
  | { kind: "revoke-session"; id: string; client: string };

/**
 * /account — the pinned parity exception (§8): credential management rides
 * better-auth's endpoints and has no pmcp tool, and §4's guards reject
 * bearer-sourced sessions here entirely.
 *
 * `enrollment` and `revealedBackupCodes` are transient overlays on top of
 * `twoFactor`, not alternatives to it: enrollment can only be non-null while
 * `twoFactor.enabled` is false, and a fresh code set is revealed exactly once —
 * after enabling or regenerating — because nothing can show it again (§4).
 */
export type AccountProps = ShellProps & {
  section: "account";
  csrfToken: string;
  twoFactor: TwoFactorSummary;
  enrollment: TotpEnrollment | null;
  revealedBackupCodes: string[] | null;
  passkeys: PasskeyRow[];
  sessions: SessionRow[];
  confirm: AccountConfirm | null;
};

/* ------------------------------------------------------------------ *
 * /services
 * ------------------------------------------------------------------ */

/**
 * The tunnel's runtime status, taken from tunnel.status rather than restated:
 * "online" means a live socket that has completed hub/register, everything else
 * is "offline" (§6).
 */
export type TunnelStatus = Awaited<ReturnType<typeof tunnelStatus>>;

/** The upstream auth mode a proxied service declares (§7); tunneled rows have none. */
export type UpstreamAuthMode = NonNullable<ServiceDetail["upstreamAuthMode"]>;

/**
 * One row of the services table — a projection of the service_list row (§8),
 * narrowed to what the table draws. The two status fields are exclusive by
 * kind, exactly as service_list reports them: `connection` is tunnel-only and
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
 * declared; proxy: the config's virtual roles). It is empty for a service that
 * has never declared any — the built-in `all` is resolved at request time and is
 * never stored (§2), so the template renders "all" for an empty list rather than
 * this field ever carrying it.
 */
export type ServiceRow = Pick<
  ServiceDetail,
  "slug" | "name" | "kind" | "archived" | "upstreamUrl" | "upstreamAuthMode" | "lastConnectedAt"
> & {
  roleNames: string[];
  connection: TunnelStatus | null;
  upstream: UpstreamConnectionStatus | null;
  /**
   * Live tokens bound to this service — the number the delete dialog names
   * ("Its 2 tokens are revoked"). Always 0 for proxied services, which have no
   * tokens at all (§2).
   */
  tokenCount: number;
};

/** The one destructive confirmation /services raises (Dialogs.dc.html). */
export type ServicesConfirm = { kind: "delete-service"; row: ServiceRow };

/**
 * /services. Active and archived are two lists because they are two sections
 * with different actions, not one list with a flag — but both hold the same row
 * shape, and `archived` is still on every row so a row can be rendered outside
 * its section (the confirm dialog does exactly that).
 */
export type ServicesProps = ShellProps & {
  section: "services";
  csrfToken: string;
  active: ServiceRow[];
  archived: ServiceRow[];
  confirm: ServicesConfirm | null;
};

/* ------------------------------------------------------------------ *
 * /services/new
 * ------------------------------------------------------------------ */

/**
 * The add-service form as submitted, echoed back verbatim on a validation
 * failure so nothing the owner typed is lost. `endpoint` and `authMode` are
 * proxy-only and are ignored — not rejected in the UI — while `kind` is
 * "tunnel"; service_create rejects them server-side (§8).
 */
export type ServiceNewForm = {
  kind: ServiceKind;
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
export type ServiceNewErrors = Partial<Record<"name" | "slug" | "endpoint" | "form", string>>;

/**
 * The form, then its receipt. `created` is the TOKEN REVEAL state of
 * ServiceNewStates.dc.html: `token` is the plaintext service token, present in
 * this one render and never recoverable afterwards (§4) — null for proxied
 * services, which have no token to show. An `auth: oauth` create never reaches
 * this state at all: it redirects into the provider's consent screen (§7).
 */
export type ServiceNewStep =
  | { kind: "form"; form: ServiceNewForm; errors: ServiceNewErrors }
  | { kind: "created"; slug: string; name: string; token: string | null };

/**
 * /services/new — a chromeless card page like /login, so it carries `username`
 * for the slug helper line ("served at /ahrzb/mcp/news") without the nav.
 */
export type ServiceNewProps = PageProps & {
  username: string;
  csrfToken: string;
  step: ServiceNewStep;
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
  "principal" | "service" | "event" | "tool" | "session"
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
 * strings ("sa:claude", "user:ahrzb", "svc:news"), the same spelling audit rows
 * and `audit_query.principal` use.
 */
export type AuditFilterOptions = {
  principals: string[];
  services: string[];
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
  account: AccountProps;
  services: ServicesProps;
  "service-new": ServiceNewProps;
  approvals: ApprovalsProps;
  "approval-detail": ApprovalDetailProps;
  audit: AuditProps;
};

/** The eight page keys of §13, as a type. */
export type PageName = keyof PagePropsByName;
