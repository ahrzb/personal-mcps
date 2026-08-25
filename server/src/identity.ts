// identity.ts — who is calling, and custody of every credential.
//
// This module owns both ways a request proves itself: better-auth sessions for humans
// (the instantiation, the plugin list — username, twoFactor, passkey,
// deviceAuthorization, bearer — and every table better-auth manages are hidden here;
// no other module touches better-auth) and our hashed-token table for machines.
// Hidden with them: the whole token scheme — the pmcp_sa_/pmcp_svc_ prefixes, 256-bit
// secrets stored as unsalted SHA-256 (deliberate for high-entropy random secrets; do
// not "fix" into bcrypt), the prefix-dispatch resolution order in which a
// pmcp_-prefixed token never falls through to session lookup, expiry-vs-revocation
// semantics, and the coarse last_used_at stamp — plus the 401-vs-404 anti-enumeration
// matrix for consumer requests, the session-scope guards that keep CLI-sourced
// sessions away from credential management, and the BOOTSTRAP_SECRET behavior of
// /internal/users. Authorization is deliberately absent: what a resolved principal
// may do belongs to registry (grants, roles) and the gateway pipeline.
//
// Failure convention: identity fails at the HTTP layer, before any JSON-RPC exists —
// its guards throw bare Response objects (401 with WWW-Authenticate, anonymous 404,
// login redirects) that the composition root returns verbatim. HubError never
// originates here; mapping errors into JSON-RPC is the gateway's monopoly.

/**
 * The resolved caller identity that every downstream decision keys on — produced
 * here, consumed by the gateway pipeline, never constructed anywhere else.
 *
 * A `user` is the namespace owner acting as themself (web session or CLI device-flow
 * session): sees every service, never approval-gated. A `service_account` is a
 * machine identity confined by its grants; `ownerId` names the namespace it lives in
 * and `slug` is its per-owner name. Service tokens (`pmcp_svc_`) never become a
 * Principal — they authenticate only the /connect upgrade, via resolveServiceToken.
 */
export type Principal =
  | { kind: "user"; userId: string; username: string }
  | { kind: "service_account"; accountId: string; ownerId: string; slug: string };

/**
 * The two machine-credential kinds in the token table. `service_account` keys
 * (`pmcp_sa_`) authenticate consumers within grants; `service` keys (`pmcp_svc_`)
 * authenticate a tunneled service's reverse connection and nothing else. Kind is
 * checked as a column, never inferred from the prefix alone.
 */
export type TokenKind = "service_account" | "service";

/**
 * One row of a token listing — display data only, no secret material beyond the
 * ~12-char `prefix`. `refSlug` names the service/account the token is bound to (the
 * binding itself is the opaque `refId`). Timestamps are epoch milliseconds;
 * `expiresAt: null` means never expires, `lastUsedAt` is coarse (advanced at most
 * hourly — a rotation signal, not a request log), `revokedAt: null` means live.
 */
export type TokenInfo = {
  id: string;
  kind: TokenKind;
  refId: string;
  refSlug: string;
  prefix: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
};

/**
 * The one canonical principal string — `user:<username>` or `sa:<slug>` — used
 * identically by audit rows, the forwarded `hub/principal` _meta field, and
 * /api/whoami. Owning the format here keeps three surfaces from each knowing it.
 */
export function formatPrincipal(p: Principal): string {
  // deps: none
  throw new Error("unimplemented");
}

/**
 * Authenticates a consumer request on `/<user>/mcp*` and proves the caller may act
 * in the URL's namespace — the whole §7-step-1 matrix in one call. Bearer-only:
 * session cookies are never consulted (that single rule removes the browser-CSRF
 * surface) and query-string tokens are rejected. Resolution dispatches on prefix:
 * `pmcp_sa_` → token lookup (explicit kind column check; unrevoked, unexpired, live
 * account row) → service_account; `pmcp_svc_` → always 401, never a session
 * fallthrough (a service credential means nothing here); anything else → better-auth
 * session → user. Failures throw a Response: 401 + `WWW-Authenticate: Bearer` when
 * no valid principal resolves — identical whether or not `<user>` exists — and 404
 * when a *resolved* principal names another user's namespace or a nonexistent one,
 * indistinguishable from route-not-found; neither anonymous probes nor authenticated
 * outsiders can enumerate usernames. Success coarsely stamps the token's
 * last_used_at. Transport hygiene (Content-Type, Origin-if-present) is the gateway's
 * job, not this function's.
 */
export async function resolvePrincipal(req: Request): Promise<Principal> {
  // deps: better-auth · D1 `token` · D1 `service_account` · D1 `user` · crypto.subtle
  throw new Error("unimplemented");
}

/**
 * Validates the `pmcp_svc_` bearer on the /connect WebSocket upgrade — the only
 * surface where a service token means anything. Returns the token's bound service id
 * (the DO addressing key), or null for anything less than a fully valid credential:
 * missing/foreign prefix, unknown token, wrong kind, revoked, or expired —
 * one answer, so the upgrade's 401 leaks nothing about which check failed. Expiry is
 * judged here, at upgrade time only: an established socket outlives its token's
 * expires_at until the next reconnect (revocation is the immediate path, and
 * severing a live socket on revoke is the admin op's cascade, never this
 * function's). Row-level verdicts stay with the upgrade handler, which fetches the
 * service anyway: row gone or kind proxy → 401, archived → 403. Success coarsely
 * stamps last_used_at.
 */
export async function resolveServiceToken(req: Request): Promise<{ serviceId: string } | null> {
  // deps: D1 `token` · crypto.subtle
  throw new Error("unimplemented");
}

/**
 * A resolved cookie session: the signed-in owner plus the session's stable
 * identifier. `sessionId` is what session-BOUND flows key on — the upstream
 * OAuth state rows bind to it so only the initiating browser session can
 * complete a connect (§7). It is an opaque identifier, never the cookie value.
 */
export type OwnerSession = {
  user: Extract<Principal, { kind: "user" }>;
  sessionId: string;
};

/**
 * The gate on every cookie-session web surface (/services, /approvals, /audit,
 * /account, the upstream-OAuth callback). Resolves the session cookie to the
 * signed-in user; on failure throws a Response that sends the browser through
 * /login. Two guards ride along: a session minted by the device flow (bearer-
 * sourced) never qualifies, even replayed as a cookie — a stolen CLI token must not
 * reach credential management and become persistent takeover — and with
 * `recent: true` (the /account routes) the session must also carry recent
 * authentication or the thrown Response forces a fresh sign-in. Never reads
 * Authorization headers.
 */
export async function requireOwnerSession(
  req: Request,
  opts?: { recent?: boolean },
): Promise<OwnerSession> {
  // deps: better-auth
  throw new Error("unimplemented");
}

/**
 * Mints a credential and returns its plaintext exactly once — never recoverable
 * afterwards, through any surface.
 * `expiresIn` is seconds; `"never"` disables expiry. Defaults differ by kind and are
 * the point: service-account tokens 90 days (they get pasted into agent configs),
 * service tokens no expiry (bots on home servers must not silently die; revoke on
 * compromise). Trusts `refId`: resolving slugs, refusing the reserved `pmcp` slug,
 * and rejecting service tokens on proxied services are the admin op's validations.
 * The returned `id` is the handle for revokeToken and the row listTokens shows.
 */
export async function issueToken(input: {
  kind: TokenKind;
  refId: string;
  expiresIn?: number | "never";
}): Promise<{ id: string; token: string }> {
  // deps: D1 `token` · crypto.getRandomValues · crypto.subtle
  throw new Error("unimplemented");
}

/**
 * Every token in the namespace, newest first — live, expired, and revoked rows
 * alike, because rotation state is what the listing is for (prefix plus coarse
 * lastUsedAt shows which token a bot is actually on). Ownership is resolved through
 * each token's referenced service/account row; tokens whose referent is gone are
 * already deleted (deleteTokensFor) and never appear.
 */
export async function listTokens(ownerId: string): Promise<TokenInfo[]> {
  // deps: D1 `token` · D1 `service` · D1 `service_account`
  throw new Error("unimplemented");
}

/**
 * Revokes one token: immediately dead on every consumer surface — the next request
 * carrying it gets 401. Returns false when `id` names no token inside `ownerId`'s
 * namespace (nonexistent and foreign are one answer, so the op layer shows a uniform
 * not-found). Idempotent: revoking a revoked token returns true and changes nothing.
 * Never touches live sockets — closing a tunneled service's connection when its
 * token is revoked (close 4001) is the admin op's cascade.
 */
export async function revokeToken(ownerId: string, id: string): Promise<boolean> {
  // deps: D1 `token` · D1 `service` · D1 `service_account`
  throw new Error("unimplemented");
}

/**
 * Hard-deletes every token row bound to this service or account id — the
 * service_delete/account_delete/user-delete cascade helper (token.ref_id has no
 * foreign key; this is its other half). Deletion, not revocation: the rows leave the
 * listings entirely. Keyed by opaque id, so recreating a slug can never resurrect
 * old credentials. Idempotent; zero matching rows is a success.
 */
export async function deleteTokensFor(refId: string): Promise<void> {
  // deps: D1 `token`
  throw new Error("unimplemented");
}

/**
 * The mountable better-auth surface — login and TOTP challenge endpoints, passkey
 * ceremonies, RFC 8628 device flow (codes shortened to ~10 minutes), session
 * management, and the bearer plugin the CLI rides — returned as one route group (a
 * Hono sub-app at implementation; typed unknown so no framework type leaks). This is
 * the only place better-auth is instantiated (per-request, D1 being request-scoped).
 * Successful passkey sign-ins stamp our last_used_at extension column; logins and
 * device approvals write audit rows. Mounted by the composition root under the
 * reserved auth paths; the credential family here is deliberately never exposed as
 * pmcp tools.
 */
export function authRoutes(): unknown {
  // deps: better-auth · audit.record · D1 `passkey`
  throw new Error("unimplemented");
}

/**
 * GET /api/whoami — the one non-MCP data route the CLI depends on; the response
 * shape `{ principal, namespace }` is the pinned CLI↔server contract (§8). Accepts
 * both consumer credential kinds: a `pmcp_sa_` key resolves to `sa:<slug>` with the
 * owner's username as namespace; a session token to `user:<name>`; `pmcp_svc_` is
 * always 401; no valid principal → 401 + `WWW-Authenticate: Bearer`. Exists outside
 * MCP because endpoint URLs embed the very username whoami discovers, and because it
 * must resolve service-account keys, which better-auth cannot.
 */
export function whoamiRoute(): unknown {
  // deps: better-auth · D1 `token` · D1 `service_account` · D1 `user` · crypto.subtle
  throw new Error("unimplemented");
}

/**
 * POST /internal/users — create / list / delete / reset-password for the users
 * script, guarded by the BOOTSTRAP_SECRET wrangler secret. While the secret is
 * unset, the route does not exist: 404 for everything, indistinguishable from any
 * unknown path, so the owner keeps it disabled between uses. The secret compare is
 * constant-time, and every invocation — accepted or refused — writes an audit row
 * (principal `bootstrap`). reset-password leaves TOTP/passkey enrollment intact, so
 * the secret alone never defeats a second factor. User deletion hands the namespace
 * teardown (token/row cascade, socket severing, DO wipes) to the admin-owned
 * cascade before better-auth's user rows go.
 */
export function bootstrapRoute(): unknown {
  // deps: better-auth · admin.provisionUser · admin.deleteUser · audit.record · D1 `user` · crypto.subtle
  throw new Error("unimplemented");
}
