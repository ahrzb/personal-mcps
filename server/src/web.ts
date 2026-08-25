// The browser-only surface: server-rendered pages (Hono JSX), the PWA shell, and the
// CSRF discipline for every form the hub serves. Deliberately the shallowest module in
// the server — any depth here would be a web-only capability, which the parity
// invariant (§8) forbids: every mutation a page performs calls an admin ops handler or
// a better-auth endpoint (/account alone rides better-auth directly — the pinned
// exception), so zero business logic lives here. What this module owns and hides: the
// page templates themselves; CSRF issuance and checking on every mutating POST; where
// cookie-session gating is applied (identity.requireOwnerSession, with recent-auth on
// /account); the /device phishing-defense presentation; the desktop-pages vs
// mobile-load-more presentations of audit.query's single { rows, total } paging
// contract; the chunked streaming JSONL export framing (never buffered); the web-app
// manifest and the minimal install+push service worker (no SPA, no offline rendering);
// and the /oauth/upstream/callback shell that guards the owner session before
// upstream.handleCallback does everything else.

/**
 * hono's `Hono` app — opaque here because skeletons carry no external imports; the
 * real type replaces this at implementation. The composition root only mounts it.
 */
type PageRouter = unknown;

/**
 * Builds the router for every browser-facing route; the composition root mounts it at
 * the origin root, and the root's route table names exactly the top-level segments
 * claimed here (RESERVED_ROUTES derives from that table, so a new page means a new
 * entry there — the two can never drift). Cookie sessions only: bearer tokens are
 * never consulted on any page route. Reads render over the same handlers the pmcp
 * tools front; mutations are CSRF-checked POSTs into an admin ops handler or a
 * better-auth endpoint, then redirect back. Takes nothing and touches nothing at
 * build time — handlers read per-request bindings from the Hono context.
 *
 * The pages (all templates are Hono JSX, an implementation detail of this module):
 * - /login — username + password, TOTP challenge, passkey button; forms post to
 *   better-auth's endpoints.
 * - /device — the phishing-defense page (RFC 8628 §5.4): shows the requesting IP and
 *   user-agent and states plainly that approval grants full admin CLI control of the
 *   namespace; the approval POST is CSRF-checked.
 * - /account — TOTP/passkey enrollment and removal, active sessions; requires recent
 *   authentication (§4), and its mutations ride better-auth's own endpoints — the
 *   pinned parity exception: no pmcp tool ever reaches credentials.
 * - /audit — read-only view over audit.query with its exact filters; desktop page
 *   numbers and mobile "Load more" are two presentations of the one { rows, total }
 *   offset/limit contract, and a row's client session id links back here as
 *   ?session=…. "Export JSONL" streams via streamAuditJsonl. No mutations, no CSRF.
 * - /approvals, /approvals/<id> — pending requests and decision history; approve and
 *   reject POST into the approval_decide admin op; the per-browser "Enable
 *   notifications" control POSTs the browser's push subscription to
 *   approvals.subscribePush (approvals owns Web Push; this module only subscribes).
 * - /services — service management fronting the service_* admin ops (create, archive,
 *   unarchive, delete, disconnect, set-upstream-auth); Connect/Reconnect redirect
 *   into the upstream module's OAuth initiation, Disconnect fronts service_disconnect.
 * - /oauth/upstream/callback — upstreamCallbackShell.
 * - /manifest.webmanifest, /sw.js — the PWA shell: installability and push only; the
 *   service worker handles push + notificationclick (opening /approvals/<id>) and
 *   never intercepts navigation (the no-SPA pin, §13).
 */
export function pageRoutes(): PageRouter {
  // deps: hono · better-auth · identity.requireOwnerSession · admin.ops · audit.query · approvals.subscribePush · upstream.beginConnect · csrfTokenFor · checkCsrf · streamAuditJsonl · upstreamCallbackShell
  throw new Error("unimplemented");
}

/**
 * The CSRF token embedded as a hidden field in every mutation form this module
 * renders. Stable for the life of the cookie session — a form left open in another
 * tab still submits — and meaningless outside it; derived, never stored server-side.
 * `sessionToken` is the opaque session cookie value the page is rendered under.
 */
async function csrfTokenFor(sessionToken: string): Promise<string> {
  // deps: crypto.subtle
  throw new Error("unimplemented");
}

/**
 * The one gate every mutating page POST passes before its handler runs: verifies the
 * submitted form's CSRF field against the cookie session that rendered it. Returns
 * null to proceed, or a 403 Response the route returns as-is — no handler ever sees
 * an unverified mutation. GETs and the OAuth callback are outside its scope (the
 * callback's replay defense is the single-use `state`, owned by upstream).
 */
async function checkCsrf(sessionToken: string, form: FormData): Promise<Response | null> {
  // deps: csrfTokenFor
  throw new Error("unimplemented");
}

/**
 * The /audit "Export JSONL" response: every audit row matching the page's current
 * filters, one JSON object per line, newest first. A thin Response wrapper over
 * audit's streaming export — how the stream is chunked and bounded in memory is
 * audit's owned decision, not repeated here. A serialization of audit_query, not
 * a capability of its own (§8's pinned parity exception). `filters` is the /audit
 * page's own query string, reused verbatim; `ownerId` scopes the export to the
 * caller's namespace.
 */
function streamAuditJsonl(ownerId: string, filters: URLSearchParams): Response {
  // deps: audit.exportJsonl
  throw new Error("unimplemented");
}

/**
 * The /oauth/upstream/callback route shell: requires the owner's cookie session, then
 * hands the redirect's parameters to upstream.handleCallback — which owns every
 * state/issuer/code check and the credential write (§7) — and turns the outcome into
 * a redirect back to /services. No OAuth material is read, logged, or stored here,
 * and a missing session rejects before any upstream code runs.
 */
async function upstreamCallbackShell(req: Request): Promise<Response> {
  // deps: identity.requireOwnerSession · upstream.handleCallback
  throw new Error("unimplemented");
}
