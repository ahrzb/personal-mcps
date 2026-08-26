// auth-matrix.test.ts — §7 step 1 and its mirrors, as ONE table (~25 rows).
//
// What this suite pins: who gets in, who is refused, and — the part that only a table can
// hold honestly — that refusals are INDISTINGUISHABLE where the spec says they must be.
// 401-vs-404 anti-enumeration (§7 step 1: no valid principal → 401 regardless of whether
// `<user>` exists; a resolved principal on a foreign or absent namespace → 404,
// indistinguishable from route-not-found), `pmcp_svc_` never falling through to session
// lookup, cookies never consulted on `/<user>/mcp*`, query-string tokens rejected, the
// Content-Type requirement and the if-present-must-match Origin rule (403), §8's
// `/api/whoami` mirror of the same resolution, §4/§13's session-scope guards (a
// bearer-sourced device-flow session never reaches `/account`, and `/account` demands
// recent auth), §12's bootstrap route being 404-shaped while BOOTSTRAP_SECRET is
// unset, and — since §7's 2026-08-26 amendment — that the `initialize` handshake is a
// message behind that same door rather than a public preamble to it.
//
// Why a table and not thirty tests: this is the densest change-amplification risk in the
// system — one sentence of §7 step 1 touches every row of it. Rows are data, the assertion
// logic is one runner, and every row prints its spec section, so a failure names the
// sentence to re-read (§8 of the strategy). The `twin` column makes §9 rule 2 executable
// rather than aspirational: a deny-only oracle is satisfied by `throw` everywhere, so
// every refusal row must NAME an allow row in this same table, and the runner enforces it.
//
// Project: `worker` — real D1, real better-auth, real crypto, `exports.default.fetch` as
// the entry (SELF is deprecated). No sockets, so per-file storage isolation applies and
// each row starts from the same seeded namespace fixture. Ordering between rows is never
// load-bearing: every row builds its own request; the only cross-row coupling is the twin
// reference, which is a lookup, not an execution order.
//
// Load-bearing prerequisite (strategy §11): better-auth 1.7 on D1 inside workerd must be
// verified working BEFORE this file is written — sources conflict on the Kysely D1
// dialect, and half these rows resolve a real session.
//
// Not pinned here: what a resolved principal may then DO (order.table.test.ts), the
// bootstrap route's own semantics beyond reachability (routes.test.ts, web-pages.test.ts),
// and the exact whoami body shape, which is a cross-language contract fixture owned by
// contracts.test.ts — this table pins the STATUS and the resolved principal, not the JSON.
//
// deps: harness/seed (two namespaces: the fixture owner and a foreign owner, each with an
//   account, a live/revoked/expired token per kind, and a password session — the expired
//   one minted through TokenSpec.expired, i.e. issueToken at a backdated now(), so no row
//   of this table sleeps) · ../../src/index (default.fetch, Env) · ../../src/identity
//   (resolvePrincipal/resolveServiceToken and their optional now()) · ../../src/gateway ·
//   applyD1Migrations (setup) · env with and without BOOTSTRAP_SECRET

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/index";
import { AUTH_BASE_PATH, requireOwnerSession, resolvePrincipal } from "../../src/identity";
import type { Principal, TokenKind } from "../../src/identity";
import type { JsonRpcResponse } from "../../src/gateway";
import { TOKEN_LAST_USED_STAMP_MS } from "../../src/limits";
import { revokeConnection, upsertBinding } from "../../src/oauth";
import { PMCP_SLUG, Registry } from "../../src/registry";
import { seedNamespace, seedOwnerSession } from "../harness/seed";
import type { SeededNamespace, SeededSession } from "../harness/seed";

/**
 * Which surface the row aims at. The four are one table because they share ONE resolution
 * rule (§7 step 1, mirrored by §8's whoami and guarded further by §4's session scopes) —
 * splitting them would let the mirrors drift from the original, which is exactly the bug
 * class this file exists for.
 *
 * `namespace` is relative to the seeded fixture, never a literal username: "self" is the
 * credential's own namespace, "foreign" another live owner's, "absent" a username no row
 * has ever had. `slug` on the scoped route distinguishes the ways a service can be
 * invisible to a service account — ungranted, nonexistent, and the reserved `pmcp` no
 * account may ever hold a grant on (§8) — because §7 step 2 pins all three to ONE answer,
 * beside the granted slug that is their allow-twin.
 *
 * `method` is what the row's JSON-RPC body ASKS for, and exists because the door is
 * decided before the body is read: without it this table is method-monomorphic, and §7's
 * 2026-08-26 amendment (`initialize` answered by the Worker rather than refused -32601)
 * would be pinned by nobody as being subject to the door at all. Absent means `tools/list`,
 * which is what every row written before the amendment sends.
 */
export type AuthSurface =
  | { route: "mcp-aggregated"; namespace: "self" | "foreign" | "absent"; method?: McpMethod }
  | {
      route: "mcp-scoped";
      namespace: "self" | "foreign" | "absent";
      slug: "granted" | "ungranted" | "absent" | "pmcp";
      method?: McpMethod;
    }
  | { route: "whoami" }
  | { route: "account"; recentAuth: boolean }
  | { route: "bootstrap"; secret: "unset" | "correct" | "wrong" };

/**
 * The two consumer methods this table can ask for. Not the whole dispatch table (§7 serves
 * four): a door row is about who gets THROUGH, and the two that matter here are the one
 * every pre-amendment row already sends and the one the amendment added. What each method
 * then ANSWERS is order.table.test.ts's.
 */
export type McpMethod = "tools/list" | "initialize";

/**
 * What the request carries. `kind` is the token table's own column (§4: kind is checked
 * as a column, never inferred from the prefix), so a row can express "a `pmcp_svc_` token
 * presented as a consumer credential" — the never-a-session case — without the test
 * knowing the prefix strings. `state` covers every way a credential can be less than
 * valid; §7 pins them all to the SAME answer, which is why they are rows rather than
 * branches.
 *
 * `expired` is a full member of that set — not a row this table has to do without.
 * identity's optional `now()` (decided 2026-08-25) lets seed mint at a backdated t0 and
 * this table resolve past the expiry, so the expired refusal sits beside its live
 * allow-twin (§9 rule 2) with no sleeping and no mint-dead-token affordance behind the
 * seam. Seeding it is harness/seed's TokenSpec.expired; this file only spends it.
 */
export type AuthCredential =
  | { sort: "absent" }
  /** A bearer matching no token prefix and no session — the fall-through floor. */
  | { sort: "garbage" }
  | {
      sort: "token";
      kind: TokenKind;
      state: "live" | "revoked" | "expired" | "referent-deleted";
      owner: "self" | "foreign";
    }
  | {
      sort: "session";
      /** How the session was minted: §4 — a device-flow (bearer-sourced) session is scope-limited. */
      source: "password" | "device-flow";
      owner: "self" | "foreign";
    };

/**
 * Where the credential rides. Two of the three are refusals by construction (§7 step 1:
 * cookies are never consulted on `/<user>/mcp*`, query-string tokens are rejected), and
 * they are columns rather than separate tests so the refusal sits beside the identical
 * credential in the accepted carrier.
 */
export type AuthCarrier = "authorization-bearer" | "cookie" | "query-string";

/**
 * The pinned answer. Allow rows name the resolved principal KIND (`Principal["kind"]`),
 * not a body: bodies are contract-fixture territory. Refusals name the status and, for
 * 401, whether `WWW-Authenticate: Bearer` must be present — the header is part of the
 * durable contract (§7 step 1), the message prose is not (§7 of the strategy: prose is
 * incidental). `login-redirect` is the web surfaces' refusal shape (§13).
 */
export type AuthOutcome =
  /**
   * `principal` is `"none"` wherever the answer names no principal. Two cases, one word:
   * §12's `/internal/users` is guarded by a shared secret rather than by
   * `resolvePrincipal`, so naming a `Principal["kind"]` there would assert a resolution
   * that never happens; and §7's `initialize` DOES resolve one at the door and then
   * answers statelessly, so its result names nobody either. "Allow" still means what it
   * means everywhere else — the surface admitted the request — which keeps the twin law (a
   * refusal names an ALLOW row) total over the table.
   */
  | { verdict: "allow"; principal: Principal["kind"] | "none" }
  | { verdict: "refuse"; status: 401 | 403 | 404; wwwAuthenticate: boolean }
  | { verdict: "login-redirect" };

/**
 * One row. `contentType` and `origin` are meaningful only on the `mcp-*` routes (§7 step
 * 1 requires `application/json` and applies the if-present-must-match Origin rule there);
 * on the other surfaces they are set to the neutral values and carry no expectation.
 *
 * `twin` is the title of another row in this same table whose verdict is `allow` and
 * which differs from this one in as few columns as possible — the concrete answer to "and
 * what does the same request look like when it should succeed?". Allow rows name
 * themselves.
 */
export type AuthMatrixRow = {
  /** e.g. "§7 step 1 · `pmcp_svc_` bearer never falls through to session lookup". */
  title: string;
  surface: AuthSurface;
  credential: AuthCredential;
  carrier: AuthCarrier;
  contentType: "application/json" | "text/plain" | "absent";
  origin: "absent" | "hub" | "foreign";
  expect: AuthOutcome;
  twin: string;
};

/**
 * The rows are OWNER-AUTHORED, in a separate commit before implementation (strategy §9
 * rule 1), from the spec sections alone — never from the implementation, and never by an
 * agent. Empty here is the correct committed state.
 */
export const AUTH_MATRIX_ROWS: readonly AuthMatrixRow[] = [
  // Reading conventions, stated once so no row repeats them:
  //
  // · `contentType`/`origin` are meaningful only on the `mcp-*` routes. Everywhere else
  //   they carry the neutral values ("absent"/"absent") and no expectation — the whoami,
  //   /account, and bootstrap rows are about resolution and scope, not transport hygiene.
  // · Allow rows name THEMSELVES in `twin` (the type's rule), so the runner's twin check
  //   is total over the table without a nullable column.
  // · Every refusal names the allow row it differs from in as few columns as possible; the
  //   anchor pair is row 1 (a live `pmcp_sa_` key) for machine credentials and row 6 (a
  //   session as Bearer) for human ones. §9 rule 2 exists because a deny-only oracle is
  //   satisfied by `throw` everywhere — these two rows are what makes that impossible.
  // · The 401 rows on `/<user>/mcp*` and `/api/whoami` all set `wwwAuthenticate: true`:
  //   §7 step 1 attaches the header to those SURFACES' 401 ("**401** with a
  //   `WWW-Authenticate: Bearer` header"), not to one cause, and §18 decision 13 keeps
  //   sending it deliberately as the OAuth-discovery upgrade path. It stops there: §12's
  //   bootstrap route is not a Bearer-principal surface and no line asks it to advertise
  //   one, so its 401 row sets the column false.

  // ── §7 step 1: resolution dispatches on prefix ─────────────────────────────────────────
  // §7 step 1: "`pmcp_sa_` prefix → SHA-256 lookup in `token` with an explicit
  // `kind = 'service_account'` check (unrevoked, unexpired, `ref_id` resolves to a live
  // service account) → service account." The anchor: the request every refusal below is one
  // column away from.
  {
    title: "§7 step 1 · a live `pmcp_sa_` key resolves to its service account (the anchor allow-twin)",
    surface: { route: "mcp-aggregated", namespace: "self" },
    credential: { sort: "token", kind: "service_account", state: "live", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "allow", principal: "service_account" },
    twin: "§7 step 1 · a live `pmcp_sa_` key resolves to its service account (the anchor allow-twin)",
  },
  // §7 step 1's "unrevoked" clause; §15: "consumer tokens are checked on every request, so
  // revocation is immediate there."
  {
    title: "§7 step 1 · a revoked `pmcp_sa_` key is refused 401 + WWW-Authenticate",
    surface: { route: "mcp-aggregated", namespace: "self" },
    credential: { sort: "token", kind: "service_account", state: "revoked", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "refuse", status: 401, wwwAuthenticate: true },
    twin: "§7 step 1 · a live `pmcp_sa_` key resolves to its service account (the anchor allow-twin)",
  },
  // §7 step 1's "unexpired" clause. The mechanism is seed's TokenSpec.expired (FINDINGS 2):
  // issue at a backdated now(), resolve under the real clock — the refusal sits beside its
  // live twin with nothing slept for and no mint-a-dead-token affordance in production code.
  {
    title: "§7 step 1 · an expired `pmcp_sa_` key is refused identically to a revoked one — issued at a backdated now() and resolved past its expiry, never slept for",
    surface: { route: "mcp-aggregated", namespace: "self" },
    credential: { sort: "token", kind: "service_account", state: "expired", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "refuse", status: 401, wwwAuthenticate: true },
    twin: "§7 step 1 · a live `pmcp_sa_` key resolves to its service account (the anchor allow-twin)",
  },
  // §7 step 1's third clause: "`ref_id` resolves to a live service account". The token row
  // itself is live and unexpired here — only its referent is gone (registry.deleteAccount
  // leaves `token.ref_id` dangling; §5 gives it no FK), so this row fails a check no other
  // row exercises and must still answer the same 401.
  {
    title: "§7 step 1 · a `pmcp_sa_` key whose account row is gone is refused identically again",
    surface: { route: "mcp-aggregated", namespace: "self" },
    credential: { sort: "token", kind: "service_account", state: "referent-deleted", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "refuse", status: 401, wwwAuthenticate: true },
    twin: "§7 step 1 · a live `pmcp_sa_` key resolves to its service account (the anchor allow-twin)",
  },
  // §7 step 1: "`pmcp_svc_` / `pmcp_sa_`-prefixed tokens **never** fall through to session
  // lookup". A perfectly valid credential — on /connect (§6) — and nothing at all here. The
  // mutation this catches is the "if the token lookup missed, try the session" shortcut.
  {
    title: "§7 step 1 · a live `pmcp_svc_` key is refused and never falls through to session lookup",
    surface: { route: "mcp-aggregated", namespace: "self" },
    credential: { sort: "token", kind: "service", state: "live", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "refuse", status: 401, wwwAuthenticate: true },
    twin: "§7 step 1 · a live `pmcp_sa_` key resolves to its service account (the anchor allow-twin)",
  },
  // §7 step 1: "anything else → better-auth session lookup → user", riding §4's `bearer()`
  // plugin. The human anchor — every session refusal below is one column from this row.
  {
    title: "§7 step 1 · a better-auth session token as Bearer resolves to the owner (the user allow-twin)",
    surface: { route: "mcp-aggregated", namespace: "self" },
    credential: { sort: "session", source: "password", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "allow", principal: "user" },
    twin: "§7 step 1 · a better-auth session token as Bearer resolves to the owner (the user allow-twin)",
  },
  // §4's device flow exists to issue "**session tokens** for the CLI", and §8 pins that the
  // CLI "performs every admin operation by calling these tools — the CLI has no private
  // admin API": a device-flow session MUST resolve to `user` on `/<user>/mcp*`, or the CLI
  // cannot work at all. The row is here because its absence inverts the /account guard
  // below — a table holding only the reject half is satisfied by an implementation that
  // rejects bearer-sourced sessions EVERYWHERE, and §4's guard is a scope limit on the
  // credential-management routes, not a rejection of the credential.
  {
    title: "§4/§8 · a device-flow (bearer-sourced) session is admitted on /<user>/mcp — the §4 guard limits its SCOPE, it does not reject the session",
    surface: { route: "mcp-aggregated", namespace: "self" },
    credential: { sort: "session", source: "device-flow", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "allow", principal: "user" },
    twin: "§4/§8 · a device-flow (bearer-sourced) session is admitted on /<user>/mcp — the §4 guard limits its SCOPE, it does not reject the session",
  },
  // The fall-through floor: a bearer that is neither prefix and matches no session. Its twin
  // is the session row, because this is the branch a session lookup answers `null` on.
  {
    title: "§7 step 1 · a bearer matching no prefix and no session is refused",
    surface: { route: "mcp-aggregated", namespace: "self" },
    credential: { sort: "garbage" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "refuse", status: 401, wwwAuthenticate: true },
    twin: "§7 step 1 · a better-auth session token as Bearer resolves to the owner (the user allow-twin)",
  },
  // §7 step 1: "any request that doesn't resolve to a valid principal → **401**". The
  // baseline, and the byte-comparison partner of the unauthenticated-absent-namespace row
  // below — anti-enumeration is a SAMENESS property, so neither row can state it alone.
  {
    title: "§7 step 1 · no Authorization header at all is refused with the same 401",
    surface: { route: "mcp-aggregated", namespace: "self" },
    credential: { sort: "absent" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "refuse", status: 401, wwwAuthenticate: true },
    twin: "§7 step 1 · a live `pmcp_sa_` key resolves to its service account (the anchor allow-twin)",
  },

  // ── §7 step 1–2: namespaces never leak existence ──────────────────────────────────────
  // The scoped allow-twin, spelled on the route where a service account can be told apart
  // from a stranger: its own namespace, a slug it holds grants on. The 404 rows below each
  // differ from this row in exactly one column.
  {
    title: "§7 step 1 · a resolved account on its own namespace is admitted",
    surface: { route: "mcp-scoped", namespace: "self", slug: "granted" },
    credential: { sort: "token", kind: "service_account", state: "live", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "allow", principal: "service_account" },
    twin: "§7 step 1 · a resolved account on its own namespace is admitted",
  },
  // §7 step 1: "A *resolved* principal on another user's namespace … → **404** (namespaces
  // don't leak existence)." 403 would confirm the namespace exists, which is the leak.
  {
    title: "§7 step 1 · a resolved account on a foreign namespace gets 404, not 403",
    surface: { route: "mcp-aggregated", namespace: "foreign" },
    credential: { sort: "token", kind: "service_account", state: "live", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "refuse", status: 404, wwwAuthenticate: false },
    twin: "§7 step 1 · a live `pmcp_sa_` key resolves to its service account (the anchor allow-twin)",
  },
  // §18 decision 2: "Namespaces are silos … there is no sharing, no global admin." An OWNER
  // is not more privileged across the boundary than a machine — same answer, both kinds.
  {
    title: "§7 step 1 · a resolved owner on a foreign namespace gets the same 404",
    surface: { route: "mcp-aggregated", namespace: "foreign" },
    credential: { sort: "session", source: "password", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "refuse", status: 404, wwwAuthenticate: false },
    twin: "§7 step 1 · a better-auth session token as Bearer resolves to the owner (the user allow-twin)",
  },
  // §7 step 1: "(or a nonexistent user) → **404** … indistinguishable from route-not-found."
  // The runner compares this answer byte for byte against an unrouted path: a 404 that says
  // "no such user" and a 404 that says nothing are the same status and a different leak.
  {
    title: "§7 step 1 · any resolved principal on a nonexistent username gets 404 — byte-identical to route-not-found",
    surface: { route: "mcp-aggregated", namespace: "absent" },
    credential: { sort: "token", kind: "service_account", state: "live", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "refuse", status: 404, wwwAuthenticate: false },
    twin: "§7 step 1 · a live `pmcp_sa_` key resolves to its service account (the anchor allow-twin)",
  },
  // §7 step 1: "**401** … regardless of whether `<user>` exists (so unauthenticated probes
  // can't enumerate usernames)". Byte-compared against the no-header row on the EXISTING
  // namespace: the anonymous probe must not be able to tell the two apart.
  {
    title: "§7 step 1 · an unauthenticated request gets the same 401 whether `<user>` exists or not",
    surface: { route: "mcp-aggregated", namespace: "absent" },
    credential: { sort: "absent" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "refuse", status: 401, wwwAuthenticate: true },
    twin: "§7 step 1 · a live `pmcp_sa_` key resolves to its service account (the anchor allow-twin)",
  },
  // §7 step 2: "On the scoped endpoint a service account gets **404** both for a nonexistent
  // slug and for a service it holds no grants on — indistinguishable, so zero-grant accounts
  // can't enumerate the namespace." One column from its twin (the granted slug), and byte-
  // compared by the runner against the same request on a slug no row has ever had.
  {
    title: "§7 step 2 · a service account on a scoped slug it holds no grants on gets 404 — identical to a nonexistent slug",
    surface: { route: "mcp-scoped", namespace: "self", slug: "ungranted" },
    credential: { sort: "token", kind: "service_account", state: "live", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "refuse", status: 404, wwwAuthenticate: false },
    twin: "§7 step 1 · a resolved account on its own namespace is admitted",
  },
  // The other half of that same sentence, and the reason it is a ROW rather than a request
  // the runner improvises: indistinguishability is a sameness property, so both sides have
  // to be under the same oracle for the byte-comparison to compare two things this table
  // describes. Every other sameness pair here is spelled as two rows for exactly that
  // reason (401-existing beside 401-absent, 404-foreign beside 404-absent-username).
  {
    title: "§7 step 2 · a service account on a scoped slug that does not exist gets the same 404 — the pair's other half, byte-compared against it",
    surface: { route: "mcp-scoped", namespace: "self", slug: "absent" },
    credential: { sort: "token", kind: "service_account", state: "live", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "refuse", status: 404, wwwAuthenticate: false },
    twin: "§7 step 1 · a resolved account on its own namespace is admitted",
  },
  // §8: "The `pmcp` slug is **reserved and virtual** … Access is admin (user) tokens only in
  // v1 — service accounts can't hold `pmcp` grants", and §7 step 2 supplies the answer: a
  // slug an account holds no grants on is a 404. So the admin endpoint owes a machine
  // credential the ORDINARY 404 — never a 401 (which would say "authenticate differently"),
  // never a JSON-RPC code (which would confirm the builtin exists). §7 L470-471 names
  // `/<user>/mcp/pmcp` a first-class surface, so this is an auth-table answer, not an
  // admin-pipeline detail.
  {
    title: "§8 · a live service-account key on scoped /mcp/pmcp gets 404 — the same answer as any slug it holds no grants on, never a 401",
    surface: { route: "mcp-scoped", namespace: "self", slug: "pmcp" },
    credential: { sort: "token", kind: "service_account", state: "live", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "refuse", status: 404, wwwAuthenticate: false },
    twin: "§8 · the owner reaches scoped /mcp/pmcp — admin (user) tokens are exactly who may",
  },
  // Its twin, without which the row above is satisfied by a hub with no admin endpoint at
  // all: §8's "admin (user) tokens only" is a statement about who DOES get in as much as
  // about who does not.
  {
    title: "§8 · the owner reaches scoped /mcp/pmcp — admin (user) tokens are exactly who may",
    surface: { route: "mcp-scoped", namespace: "self", slug: "pmcp" },
    credential: { sort: "session", source: "password", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "allow", principal: "user" },
    twin: "§8 · the owner reaches scoped /mcp/pmcp — admin (user) tokens are exactly who may",
  },

  // ── §7 step 1: carrier and transport hygiene ──────────────────────────────────────────
  // §7 step 1: "**`Authorization: Bearer` only** — session cookies are never consulted on
  // `/<user>/mcp*` (this single rule removes the whole browser-CSRF surface for the admin
  // MCP)". The credential is genuinely valid; only the carrier is wrong.
  {
    title: "§7 step 1 · a valid session cookie with no Authorization header is refused on /mcp — cookies are never consulted",
    surface: { route: "mcp-aggregated", namespace: "self" },
    credential: { sort: "session", source: "password", owner: "self" },
    carrier: "cookie",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "refuse", status: 401, wwwAuthenticate: true },
    twin: "§7 step 1 · a better-auth session token as Bearer resolves to the owner (the user allow-twin)",
  },
  // §7 step 1: "tokens in query strings are rejected" (§18 decision 13 keeps that promise
  // for the OAuth upgrade path). The row's own twin IS the anchor: same key, right carrier.
  {
    title: "§7 step 1 · a valid key in the query string is refused; the same key as a bearer is admitted (its twin)",
    surface: { route: "mcp-aggregated", namespace: "self" },
    credential: { sort: "token", kind: "service_account", state: "live", owner: "self" },
    carrier: "query-string",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "refuse", status: 401, wwwAuthenticate: true },
    twin: "§7 step 1 · a live `pmcp_sa_` key resolves to its service account (the anchor allow-twin)",
  },
  // §7 step 1: "`Content-Type: application/json` is required". The status is pinned by
  // elimination, not by prose: the outcome vocabulary offers 401/403/404, the foreign-Origin
  // row below is "the one 403 on this surface", and 404 is the namespace answer — so a
  // request that fails transport hygiene is refused as one that resolved no principal.
  //
  // OPEN, and deliberately left as it stands rather than guessed at a second time. §7 gives
  // the Origin failure an explicit 403 and gives this one no status at all, so the silence
  // is conspicuous; the credential here is a live `pmcp_sa_` key, which DOES resolve to a
  // valid principal, so §7 step 1's own definition of the 401 ("any request that doesn't
  // resolve to a valid principal") does not reach it, and the conventional answers (415,
  // 400) cannot even be spelled in AuthOutcome. Resolving this is an owner decision
  // recorded as a `spec:` sentence in §7 step 1 — plus a widened status union if the answer
  // is 415/400 — not a test-side re-guess. Until then the row keeps the status the outcome
  // vocabulary forces, and this comment is the flag on it.
  {
    title: "§7 step 1 · a non-JSON Content-Type is refused; `application/json` is admitted",
    surface: { route: "mcp-aggregated", namespace: "self" },
    credential: { sort: "token", kind: "service_account", state: "live", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "text/plain",
    origin: "absent",
    expect: { verdict: "refuse", status: 401, wwwAuthenticate: true },
    twin: "§7 step 1 · a live `pmcp_sa_` key resolves to its service account (the anchor allow-twin)",
  },
  // §7 step 1: "requests without an `Origin` pass — every legitimate consumer (CLI, agents,
  // server-side MCP clients) is a non-browser client that sends none". Deliberately the same
  // request as the anchor: §7 states the pass as its own sentence, and the Origin trio below
  // is only readable as a trio if its neutral member is in the table beside the other two.
  {
    title: "§7 step 1 · an absent Origin is admitted — every legitimate consumer sends none",
    surface: { route: "mcp-aggregated", namespace: "self" },
    credential: { sort: "token", kind: "service_account", state: "live", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "allow", principal: "service_account" },
    twin: "§7 step 1 · an absent Origin is admitted — every legitimate consumer sends none",
  },
  // §7 step 1: "an `Origin` header, when present, must match the hub's own origin" — the
  // matching half, and the twin the 403 below is one column from.
  {
    title: "§7 step 1 · an Origin equal to the hub's origin is admitted",
    surface: { route: "mcp-aggregated", namespace: "self" },
    credential: { sort: "token", kind: "service_account", state: "live", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "hub",
    expect: { verdict: "allow", principal: "service_account" },
    twin: "§7 step 1 · an Origin equal to the hub's origin is admitted",
  },
  // §7 step 1: "(else **403**)" — the same if-present-must-match semantics as the SDK's
  // `originValidation` middleware, which `createMcpHandler` does NOT apply on its own.
  {
    title: "§7 step 1 · a foreign Origin is refused 403 — the one 403 on this surface",
    surface: { route: "mcp-aggregated", namespace: "self" },
    credential: { sort: "token", kind: "service_account", state: "live", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "foreign",
    expect: { verdict: "refuse", status: 403, wwwAuthenticate: false },
    twin: "§7 step 1 · an Origin equal to the hub's origin is admitted",
  },

  // ── §8: /api/whoami mirrors step 1 exactly ────────────────────────────────────────────
  // §8: "Resolution mirrors §7 step 1". These four rows are in THIS table rather than a
  // whoami suite for exactly that reason: a mirror that drifts is the bug, and it can only
  // be seen with both surfaces under one oracle. The body shape is contracts.test.ts's.
  {
    title: "§8 · a `pmcp_sa_` key resolves to the service-account principal in the owner's namespace",
    surface: { route: "whoami" },
    credential: { sort: "token", kind: "service_account", state: "live", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "absent",
    origin: "absent",
    expect: { verdict: "allow", principal: "service_account" },
    twin: "§8 · a `pmcp_sa_` key resolves to the service-account principal in the owner's namespace",
  },
  {
    title: "§8 · a session resolves to the user principal",
    surface: { route: "whoami" },
    credential: { sort: "session", source: "password", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "absent",
    origin: "absent",
    expect: { verdict: "allow", principal: "user" },
    twin: "§8 · a session resolves to the user principal",
  },
  // §8: "a `pmcp_svc_`-prefixed bearer → **401**, never a session lookup." The mirror of the
  // never-fall-through rule, on the one route the CLI reaches before it knows its own name.
  {
    title: "§8 · a `pmcp_svc_` key is refused 401, never a session lookup",
    surface: { route: "whoami" },
    credential: { sort: "token", kind: "service", state: "live", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "absent",
    origin: "absent",
    expect: { verdict: "refuse", status: 401, wwwAuthenticate: true },
    twin: "§8 · a `pmcp_sa_` key resolves to the service-account principal in the owner's namespace",
  },
  // §8: "no valid principal → **401** with `WWW-Authenticate: Bearer`."
  {
    title: "§8 · no credential is refused 401 + WWW-Authenticate",
    surface: { route: "whoami" },
    credential: { sort: "absent" },
    carrier: "authorization-bearer",
    contentType: "absent",
    origin: "absent",
    expect: { verdict: "refuse", status: 401, wwwAuthenticate: true },
    twin: "§8 · a `pmcp_sa_` key resolves to the service-account principal in the owner's namespace",
  },

  // ── §4/§13: session-scope guards on /account ──────────────────────────────────────────
  // §4: credential-management endpoints "require a cookie-authenticated web session with
  // recent authentication". The twin both guards below are one column from.
  {
    title: "§4 · a password session with recent auth reaches /account (the twin)",
    surface: { route: "account", recentAuth: true },
    credential: { sort: "session", source: "password", owner: "self" },
    carrier: "cookie",
    contentType: "absent",
    origin: "absent",
    expect: { verdict: "allow", principal: "user" },
    twin: "§4 · a password session with recent auth reaches /account (the twin)",
  },
  // §4: "bearer-sourced (CLI) sessions are rejected there, so a stolen CLI token cannot
  // enroll new credentials and become persistent account takeover" — and identity's guard
  // rejects it "even replayed as a cookie", which is precisely how this row presents it:
  // the CARRIER is right and the session's ORIGIN is not.
  {
    title: "§4 · a device-flow (bearer-sourced) session replayed as a cookie is sent to /login instead",
    surface: { route: "account", recentAuth: true },
    credential: { sort: "session", source: "device-flow", owner: "self" },
    carrier: "cookie",
    contentType: "absent",
    origin: "absent",
    expect: { verdict: "login-redirect" },
    twin: "§4 · a password session with recent auth reaches /account (the twin)",
  },
  // §13/§4: the recency half of the same guard — a week-old browser session is a session,
  // and still not enough to enroll a second factor.
  {
    title: "§13 · a password session without recent auth is forced through a fresh sign-in",
    surface: { route: "account", recentAuth: false },
    credential: { sort: "session", source: "password", owner: "self" },
    carrier: "cookie",
    contentType: "absent",
    origin: "absent",
    expect: { verdict: "login-redirect" },
    twin: "§4 · a password session with recent auth reaches /account (the twin)",
  },

  // ── §12: the bootstrap route exists only while its secret does ────────────────────────
  // The secret rides `Authorization: Bearer` (scripts/users.ts's copied contract) but is not
  // a PRINCIPAL credential — no row of the `token`/`session` vocabulary describes it — so it
  // lives in the surface column and `credential` stays `absent` on all three rows.
  //
  // §12: "When the secret is **unset, the route does not exist** (404 for everything)"; the
  // runner byte-compares this answer with an unrouted path, the same sameness property the
  // namespace rows carry.
  {
    title: "§12 · with BOOTSTRAP_SECRET unset, every request 404s — indistinguishable from an unknown path",
    surface: { route: "bootstrap", secret: "unset" },
    credential: { sort: "absent" },
    carrier: "authorization-bearer",
    contentType: "absent",
    origin: "absent",
    expect: { verdict: "refuse", status: 404, wwwAuthenticate: false },
    twin: "§12 · with the secret set, the correct secret is admitted (the twin)",
  },
  // The allow-twin without which the row above is satisfied by a worker that has no such
  // route at all. `principal: "none"` says what this surface actually does: §12's route is
  // guarded by a shared-secret compare, not by resolvePrincipal, so it admits the request
  // without resolving anyone — the allow verdict is "the route answered", and no row has to
  // pretend a `user` was found. Its own semantics (create/list/delete/reset-password) belong
  // to routes.test.ts and the scripts contract.
  {
    title: "§12 · with the secret set, the correct secret is admitted (the twin)",
    surface: { route: "bootstrap", secret: "correct" },
    credential: { sort: "absent" },
    carrier: "authorization-bearer",
    contentType: "absent",
    origin: "absent",
    expect: { verdict: "allow", principal: "none" },
    twin: "§12 · with the secret set, the correct secret is admitted (the twin)",
  },
  // §12's constant-time compare, from the outside: a wrong secret is a wrong CREDENTIAL
  // (401), never a missing route (404) — the two statuses are the operator's only signal for
  // "rotate the secret" versus "the secret is unset on the Worker", and scripts/users.ts's
  // bootstrap contract header pins that split as the CLI's ("404 means the route is
  // disabled … 401 is a wrong secret"). The header is where the pin stops: no `WWW-
  // Authenticate` is owed here, and inventing one would advertise a Bearer challenge on a
  // route that answers no principal — §7 step 1 and §8 attach that header to `/<user>/mcp*`
  // and `/api/whoami`, and §12 and identity.bootstrapRoute's contract mention neither it nor
  // any 401 shape.
  {
    title: "§12 · with the secret set, a wrong secret is refused",
    surface: { route: "bootstrap", secret: "wrong" },
    credential: { sort: "absent" },
    carrier: "authorization-bearer",
    contentType: "absent",
    origin: "absent",
    expect: { verdict: "refuse", status: 401, wwwAuthenticate: false },
    twin: "§12 · with the secret set, the correct secret is admitted (the twin)",
  },

  // ── §7 step 1, amended 2026-08-26: the handshake is behind the same door ──────────────
  // The amendment moved `initialize` out of -32601 — "the MCP handshake every
  // standards-compliant client opens with … answered statelessly on both endpoint shapes"
  // — and every other `mcp-*` row of this table sends `tools/list`, which left the door
  // METHOD-MONOMORPHIC: nothing here said the handshake is a message like any other rather
  // than a public preamble. The mutation that shape invites is the natural one, because the
  // answer genuinely needs no caller — answer `initialize` before resolving anyone — and it
  // passes every row above while handing an anonymous prober the hub's protocol version,
  // its capabilities, its serverInfo, and (by 200-versus-404) whether a username exists,
  // which is precisely what §7 step 1's anti-enumeration sentence forbids.
  //
  // Five rows: the four credentials of the anchor block re-asked as a handshake, plus one
  // scoped row, because §7 step 2's visibility 404 is decided at the same door and a
  // handshake that preceded it would leak slug existence the same way.
  {
    title: "§7 step 1 · a live `pmcp_sa_` key opens the MCP handshake — `initialize` is behind the auth door and answered through it (the handshake allow-twin)",
    surface: { route: "mcp-aggregated", namespace: "self", method: "initialize" },
    credential: { sort: "token", kind: "service_account", state: "live", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "allow", principal: "none" },
    twin: "§7 step 1 · a live `pmcp_sa_` key opens the MCP handshake — `initialize` is behind the auth door and answered through it (the handshake allow-twin)",
  },
  // §7 step 1: "any request that doesn't resolve to a valid principal → **401**" — a
  // request, not a request whose method the hub happens to need state for.
  {
    title: "§7 step 1 · an anonymous `initialize` is refused 401 + WWW-Authenticate — the handshake is not a public preamble",
    surface: { route: "mcp-aggregated", namespace: "self", method: "initialize" },
    credential: { sort: "absent" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "refuse", status: 401, wwwAuthenticate: true },
    twin: "§7 step 1 · a live `pmcp_sa_` key opens the MCP handshake — `initialize` is behind the auth door and answered through it (the handshake allow-twin)",
  },
  // The fall-through floor, re-asked: a bearer matching no prefix and no session.
  {
    title: "§7 step 1 · an `initialize` under a bearer matching no prefix and no session is refused with the same 401",
    surface: { route: "mcp-aggregated", namespace: "self", method: "initialize" },
    credential: { sort: "garbage" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "refuse", status: 401, wwwAuthenticate: true },
    twin: "§7 step 1 · a live `pmcp_sa_` key opens the MCP handshake — `initialize` is behind the auth door and answered through it (the handshake allow-twin)",
  },
  // §7 step 1's never-fall-through rule on the handshake: a `pmcp_svc_` key is a perfectly
  // valid credential on /connect (§6) and nothing at all here, whatever it asks for.
  {
    title: "§7 step 1 · an `initialize` under a live `pmcp_svc_` key is refused 401 — the wrong-kind credential never falls through on the handshake either",
    surface: { route: "mcp-aggregated", namespace: "self", method: "initialize" },
    credential: { sort: "token", kind: "service", state: "live", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "refuse", status: 401, wwwAuthenticate: true },
    twin: "§7 step 1 · a live `pmcp_sa_` key opens the MCP handshake — `initialize` is behind the auth door and answered through it (the handshake allow-twin)",
  },
  // §7 step 2, on the shape the amendment also serves: visibility is decided before the
  // body is read, so a handshake at an ungranted slug is the namespace's ordinary 404 —
  // never a handshake that confirms the slug and then refuses the calls.
  {
    title: "§7 step 2 · an `initialize` at a scoped slug the caller holds no grants on gets the namespace's 404 — the handshake never precedes visibility",
    surface: { route: "mcp-scoped", namespace: "self", slug: "ungranted", method: "initialize" },
    credential: { sort: "token", kind: "service_account", state: "live", owner: "self" },
    carrier: "authorization-bearer",
    contentType: "application/json",
    origin: "absent",
    expect: { verdict: "refuse", status: 404, wwwAuthenticate: false },
    twin: "§7 step 1 · a live `pmcp_sa_` key opens the MCP handshake — `initialize` is behind the auth door and answered through it (the handshake allow-twin)",
  },
];

/**
 * The single assertion path for every row: build the request the row describes against
 * the seeded fixture, drive it through `exports.default.fetch`, and check the verdict —
 * status, the `WWW-Authenticate` presence for 401s, and for allow rows the principal kind
 * the surface reports.
 *
 * Two invariants belong to the runner rather than to any row, because they are properties
 * OF the table: (1) every refusal row's `twin` resolves to an allow row present in the
 * same table (§9 rule 2 — without this, `throw` everywhere passes); (2) rows the spec
 * pins as indistinguishable are asserted byte-identical to each other, not merely
 * equal-status — 401-on-an-existing-user against 401-on-an-absent-one, 404-foreign against
 * 404-route-not-found, and the scoped trio (ungranted slug, absent slug, `pmcp`) against
 * one another. Anti-enumeration is a sameness property; asserting each side alone would
 * miss the leak entirely, and every side is a ROW here so the comparison is between two
 * requests this table describes rather than one row and an improvised request.
 */
export function runAuthMatrix(rows: readonly AuthMatrixRow[]): void {
  // deps: harness/seed · ../../src/index (default.fetch) · env.DB · env.BOOTSTRAP_SECRET
  //
  // The two table-wide invariants live in runTableInvariants below rather than here: the
  // authored describes group the rows into five sections, so this function is called five
  // times, and a property OF the table must be asserted once.
  for (const row of rows) {
    it(row.title, async () => {
      const response = await call(requestFor(row), envFor(row));
      switch (row.expect.verdict) {
        case "refuse":
          expect(response.status).toBe(row.expect.status);
          // The header is contract; the message prose is not, and is not asserted.
          expect(response.headers.has("WWW-Authenticate")).toBe(row.expect.wwwAuthenticate);
          return;
        case "login-redirect":
          expect(response.status).toBe(302);
          expect(response.headers.get("Location")).toMatch(/^\/login(\?|$)/);
          return;
        case "allow":
          expect(REFUSAL_STATUSES).not.toContain(response.status);
          expect(response.status).not.toBe(302);
          await expectAdmittedAs(row, response);
      }
    });
  }
}

/**
 * The two invariants that are properties of the SET of rows. Registered once, in the
 * table's own describe (see runAuthMatrix's note).
 */
export function runTableInvariants(): void {
  it("§9 rule 2 · every refusal row names an allow-twin present in this table", () => {
    for (const row of AUTH_MATRIX_ROWS) {
      const twin = AUTH_MATRIX_ROWS.find((candidate) => candidate.title === row.twin);
      // A deny-only oracle is satisfied by `throw` everywhere — this is the check that
      // makes each refusal carry the request that must still succeed.
      expect(twin, `no row titled "${row.twin}", named as the twin of "${row.title}"`).toBeDefined();
      expect(twin?.expect.verdict, `the twin of "${row.title}" is not an allow row`).toBe("allow");
      if (row.expect.verdict === "allow") expect(row.twin).toBe(row.title);
    }
  });

  it("§7 step 1 · rows pinned as indistinguishable answer byte-identically, not merely with equal status", async () => {
    const answerTo = async (title: string) => {
      const row = rowTitled(title);
      return bytesOf(await call(requestFor(row), envFor(row)));
    };
    // §7 step 1 / §19.2: "**401** … regardless of whether `<user>` exists". Under §19 the
    // 401's `WWW-Authenticate` names the per-namespace `resource_metadata`, derived from the
    // request PATH and looked up nowhere — so the ONLY thing that differs between two 401s is
    // the username the caller itself named in the URL (which is no existence signal: the
    // caller typed it). Normalizing each answer's own namespace out leaves the two byte-
    // identical, which is exactly §19.8's "same bytes whether `<user>` exists or not"; the
    // same-username-live-vs-absent form of the property is the door block's `§19.8/§7 · …
    // byte-identical` case. Everything else here — status, body, every other header — is
    // asserted equal by the substitution touching only the username.
    const withoutNamespace = (bytes: string, username: string) => bytes.split(username).join("<ns>");
    expect(
      withoutNamespace(await answerTo(TITLES.noHeaderOnSelf), fixture.self.owner.username),
    ).toEqual(withoutNamespace(await answerTo(TITLES.noHeaderOnAbsent), ABSENT_USERNAME));

    // §7 step 1: "…**404** (namespaces don't leak existence) … indistinguishable from
    // route-not-found". The third answer is a path this worker does not route at all.
    const routeNotFound = await bytesOf(
      await call(new Request(`${ORIGIN}/${UNROUTED_PATH}`, { method: "POST" })),
    );
    expect(await answerTo(TITLES.foreignNamespace)).toEqual(routeNotFound);
    expect(await answerTo(TITLES.absentUsername)).toEqual(routeNotFound);

    // §7 step 2 / §8: the scoped trio — no grants, no such slug, and the reserved builtin.
    const trio = [
      await answerTo(TITLES.ungrantedSlug),
      await answerTo(TITLES.absentSlug),
      await answerTo(TITLES.pmcpForAccount),
    ];
    expect(new Set(trio).size, `the scoped 404s differ: ${trio.join(" | ")}`).toBe(1);
  });
}

// ── the fixture every row is built against ────────────────────────────────────────────

/** The hub's own origin, as the worker under test knows it (§7's Origin rule reads it). */
const ORIGIN = (env as unknown as Env).PUBLIC_ORIGIN;

/** A browser origin that is not the hub's — the one 403 on the consumer surface. */
const FOREIGN_ORIGIN = "https://evil.example";

/** Slugs the `AuthSurface.slug` roles map onto. None contains `_` (§7's split rule); the
 *  reserved one is registry's own constant, never a second spelling of it. */
const GRANTED_SLUG = "news";
const UNGRANTED_SLUG = "solo";
const ABSENT_SLUG = "nowhere";

/** A username no row has ever had, and a path this worker routes nothing to. */
const ABSENT_USERNAME = "nobody-here";
const UNROUTED_PATH = "definitely-not-a-route";

/** §12's master key, fixture-side. Obviously fake, and never a real-looking secret. */
const BOOTSTRAP_SECRET = "FAKE0000-bootstrap-secret";
const WRONG_BOOTSTRAP_SECRET = "FAKE0000-wrong-bootstrap-secret";

/** A bearer matching no prefix and no session: the fall-through floor's fixture. */
const GARBAGE_BEARER = "FAKE0000-neither-a-token-nor-a-session";

/** The statuses this table's refusals are spelled in; an allow row is none of them. */
const REFUSAL_STATUSES = [401, 403, 404];

/** The `pmcp_sa_` token states the credential column names, keyed as its `state` is. */
type TokenHandle = "live" | "revoked" | "expired" | "referent-deleted" | "service";

/**
 * One session as a row presents it: the raw token, and the browser cookie IF one exists.
 * A device-flow session has none — the hub mints no cookie for the CLI — which is the
 * difference the /account rows turn on.
 */
type PresentedSession = { token: string; cookie: string | null };

/**
 * The seeded world. One namespace with everything a row can present, one FOREIGN owner
 * that exists only to be someone else, and the three sessions the human rows need — a
 * fresh browser sign-in, a second sign-in aged past recency, and a real device-flow
 * exchange (which yields a bearer and, deliberately, no cookie).
 */
type Fixture = {
  self: SeededNamespace;
  foreign: string;
  sessions: { fresh: PresentedSession; stale: PresentedSession; device: PresentedSession };
  /** better-auth's session cookie name, read off a real Set-Cookie rather than spelled. */
  cookieName: string;
};
let fixture: Fixture;

beforeAll(async () => {
  const self = await seedNamespace(env.DB, {
    services: [
      {
        slug: GRANTED_SLUG,
        kind: "proxy",
        upstreamUrl: "https://upstream.invalid/mcp",
        roles: { reader: ["get.*"] },
      },
      { slug: UNGRANTED_SLUG, kind: "tunnel", tokens: [{ as: "service" }] },
    ],
    accounts: [
      {
        slug: "agent",
        grants: { [GRANTED_SLUG]: [{ role: "reader", mode: "allow" }] },
        tokens: [
          { as: "live" },
          { as: "revoked", revoked: true },
          // Backdated mint, not a sleep (seed FINDINGS 2).
          { as: "expired", expired: true },
        ],
      },
      { slug: "ghost", tokens: [{ as: "referent-deleted" }] },
    ],
  });
  // §7 step 1's third clause, seeded through the seam that actually produces it:
  // registry.deleteAccount removes the account and leaves `token.ref_id` dangling (§5
  // gives that reference no FK), so the credential is live and its referent is gone.
  await new Registry(env.DB).deleteAccount(self.accounts.ghost.id);

  const foreign = await seedNamespace(env.DB, {});
  // Two sign-ins, because the /account rows need a browser session on each side of the
  // recency line and aging one must not age the other.
  const fresh = await seedOwnerSession(self.owner);
  const stale = await seedOwnerSession(self.owner);
  await ageSession(stale.token);
  const device = await deviceFlowSession(fresh.cookie);

  fixture = {
    self,
    foreign: foreign.owner.username,
    sessions: { fresh, stale, device },
    cookieName: fresh.cookie.split("=")[0],
  };
});

/** Drives the worker exactly as a request reaches it: `exports.default.fetch`. */
async function call(request: Request, overrides: Partial<Env> = {}): Promise<Response> {
  return worker.fetch(request, { ...(env as unknown as Env), ...overrides });
}

/**
 * The RFC 8628 exchange, driven end to end through the same routes the CLI and the
 * /device page use: request a code, claim it and approve it as the signed-in owner, then
 * redeem it. What comes back is a session token and NO cookie — which is exactly why a
 * device-flow session cannot be presented as a browser session (§4).
 */
async function deviceFlowSession(ownerCookie: string): Promise<PresentedSession> {
  const asOwner = { "content-type": "application/json", origin: ORIGIN, cookie: ownerCookie };
  const codes = (await (
    await call(
      new Request(`${ORIGIN}/api/auth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: DEVICE_CLIENT_ID }),
      }),
    )
  ).json()) as { device_code: string; user_code: string };

  // The /device page's two steps: the signed-in browser claims the user code, then
  // approves it.
  await call(
    new Request(`${ORIGIN}/api/auth/device?user_code=${codes.user_code}`, { headers: asOwner }),
  );
  const approved = await call(
    new Request(`${ORIGIN}/api/auth/device/approve`, {
      method: "POST",
      headers: asOwner,
      body: JSON.stringify({ userCode: codes.user_code }),
    }),
  );
  if (approved.status !== 200) {
    throw new Error(`device approval failed: ${approved.status} ${await approved.text()}`);
  }
  const redeemed = await call(
    new Request(`${ORIGIN}/api/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: codes.device_code,
        client_id: DEVICE_CLIENT_ID,
      }),
    }),
  );
  const body = (await redeemed.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`device token failed: ${JSON.stringify(body)}`);
  return { token: body.access_token, cookie: null };
}

/** The CLI's client id in the device flow — a fixture name, nothing is registered. */
const DEVICE_CLIENT_ID = "pmcp-cli";

/**
 * Age one session past better-auth's freshness window — the passage of time, and the one
 * state no seam can express (identity has no clock parameter on requireOwnerSession, and
 * a production affordance for "make this session old" is exactly what must not exist).
 * The column is better-auth's own and holds ISO-8601 text (its SQLite adapter stores
 * dates as strings), so the write speaks that.
 */
async function ageSession(token: string): Promise<void> {
  await (env.DB as RawD1)
    .prepare(`UPDATE "session" SET "createdAt" = ? WHERE "token" = ?`)
    .bind(new Date(Date.now() - AGED_SESSION_MS).toISOString(), token)
    .run();
}

/** Comfortably past better-auth's one-day `freshAge`, and nowhere near session expiry. */
const AGED_SESSION_MS = 3 * 24 * 60 * 60 * 1000;

/** The raw D1 reach ageSession names its reason for: never a shortcut for state. */
type RawD1 = {
  prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
};

// ── one row → one request ─────────────────────────────────────────────────────────────

/** The username a row's `namespace` names, relative to the fixture. */
function namespaceFor(namespace: "self" | "foreign" | "absent"): string {
  if (namespace === "self") return fixture.self.owner.username;
  return namespace === "foreign" ? fixture.foreign : ABSENT_USERNAME;
}

/** The slug a row's scoped `slug` names. */
function slugFor(slug: "granted" | "ungranted" | "absent" | "pmcp"): string {
  return { granted: GRANTED_SLUG, ungranted: UNGRANTED_SLUG, absent: ABSENT_SLUG, pmcp: PMCP_SLUG }[
    slug
  ];
}

/** The URL a row addresses, before its carrier gets a say. */
function urlFor(row: AuthMatrixRow): string {
  switch (row.surface.route) {
    case "mcp-aggregated":
      return `${ORIGIN}/${namespaceFor(row.surface.namespace)}/mcp`;
    case "mcp-scoped":
      return `${ORIGIN}/${namespaceFor(row.surface.namespace)}/mcp/${slugFor(row.surface.slug)}`;
    case "whoami":
      return `${ORIGIN}/api/whoami`;
    case "account":
      return `${ORIGIN}/account`;
    case "bootstrap":
      return `${ORIGIN}/internal/users`;
  }
}

/**
 * The credential string a row presents, in whatever carrier it names — or null when it
 * presents none. The bootstrap rows carry no PRINCIPAL credential (their `credential` is
 * `absent`): what rides their bearer is §12's shared secret, which is a property of the
 * surface, and that is where it is read from.
 */
function credentialFor(row: AuthMatrixRow): string | null {
  if (row.surface.route === "bootstrap") {
    return row.surface.secret === "wrong" ? WRONG_BOOTSTRAP_SECRET : BOOTSTRAP_SECRET;
  }
  switch (row.credential.sort) {
    case "absent":
      return null;
    case "garbage":
      return GARBAGE_BEARER;
    case "token":
      return fixture.self.tokens[tokenHandleFor(row.credential)].token;
    case "session":
      return sessionFor(row).token;
  }
}

/** Which seeded token a `token` credential means — one handle per (kind, state) pair. */
function tokenHandleFor(credential: Extract<AuthCredential, { sort: "token" }>): TokenHandle {
  return credential.kind === "service" ? "service" : credential.state;
}

/**
 * Which seeded session a `session` credential means. The password sessions are two — a
 * fresh one and one aged past recency — and the row that asks for the aged one is the
 * /account row whose surface says `recentAuth: false`: recency is a property of the
 * session presented, and the surface column is where the table spells it.
 */
function sessionFor(row: AuthMatrixRow): PresentedSession {
  if (row.credential.sort !== "session") throw new Error(`${row.title} presents no session`);
  if (row.credential.source === "device-flow") return fixture.sessions.device;
  const stale = row.surface.route === "account" && !row.surface.recentAuth;
  return stale ? fixture.sessions.stale : fixture.sessions.fresh;
}

/**
 * What a `cookie`-carrier row puts in the Cookie header. A password session has a real
 * signed cookie, which is the only thing better-auth accepts there. A device-flow session
 * has none — the hub never mints one for it — so the only way to "replay it as a cookie"
 * is the raw bearer token, which is precisely what a stolen CLI token is.
 */
function cookieFor(row: AuthMatrixRow): string {
  const session = sessionFor(row);
  return session.cookie ?? `${fixture.cookieName}=${session.token}`;
}

/** The body a row's surface expects: a JSON-RPC message, a bootstrap op, or none. */
function bodyFor(row: AuthMatrixRow): string | undefined {
  if (row.surface.route === "bootstrap") return JSON.stringify({ op: "list" });
  const method = mcpMethodOf(row.surface);
  if (method === undefined) return undefined;
  // The handshake carries the params a real client sends; `tools/list` carries none, which
  // is what every row written before the amendment sent and still sends.
  const params = method === "initialize" ? { params: CLIENT_HANDSHAKE } : {};
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...params });
}

/** The JSON-RPC method a row asks for, or undefined on the surfaces that speak no
 *  JSON-RPC at all (whoami, /account, bootstrap). */
function mcpMethodOf(surface: AuthSurface): McpMethod | undefined {
  if (surface.route !== "mcp-aggregated" && surface.route !== "mcp-scoped") return undefined;
  return surface.method ?? "tools/list";
}

/**
 * The `initialize` params a compliant MCP client opens with — the CLIENT's own declared
 * revision and an obviously-fake identity, not the hub's (nothing the door decides may
 * depend on either). Sent in full rather than as `{}` because a row that sent an empty
 * params object would let an implementation that misreads them pass; what the hub ANSWERS
 * is order.table.test.ts's, which carries the same fixture for that side.
 */
const CLIENT_HANDSHAKE = {
  protocolVersion: "2026-07-28",
  capabilities: {},
  clientInfo: { name: "pmcp-auth-matrix-client", version: "0.0.0-FAKE0000" },
};

/** The row's request, built fresh each time — a body is read once, and rows re-ask. */
function requestFor(row: AuthMatrixRow): Request {
  const headers = new Headers();
  if (row.contentType !== "absent") headers.set("Content-Type", row.contentType);
  if (row.origin === "hub") headers.set("Origin", ORIGIN);
  if (row.origin === "foreign") headers.set("Origin", FOREIGN_ORIGIN);

  const credential = credentialFor(row);
  let url = urlFor(row);
  if (credential !== null) {
    if (row.carrier === "authorization-bearer") headers.set("Authorization", `Bearer ${credential}`);
    if (row.carrier === "cookie") headers.set("Cookie", cookieFor(row));
    // §7 step 1: "tokens in query strings are rejected" — the credential moves, and the
    // Authorization header stays empty, so the row tests the transport and not the secret.
    if (row.carrier === "query-string") url += `?token=${encodeURIComponent(credential)}`;
  }
  const body = bodyFor(row);
  return new Request(url, { method: body === undefined ? "GET" : "POST", headers, body });
}

/**
 * The env variant a row runs under: §12's secret is the only per-row binding. "unset" is
 * spelled as an explicit `undefined` rather than as an absent key — the pool's bindings
 * come from the developer's own `.env`, so a row that merely declines to SET the secret
 * runs with whatever that file holds, and §12's "the route does not exist" row would pass
 * or fail depending on whose machine it ran on.
 */
function envFor(row: AuthMatrixRow): Partial<Env> {
  if (row.surface.route !== "bootstrap") return {};
  return { BOOTSTRAP_SECRET: row.surface.secret === "unset" ? undefined : BOOTSTRAP_SECRET };
}

/**
 * Who the surface admitted — read, wherever the surface can say it, off THIS row's own
 * answer rather than off a second request down a different path. The status already
 * proved the door did not refuse; this names the principal, each surface answering in its
 * own vocabulary:
 *
 * · whoami says it outright, in its body.
 * · The consumer endpoints say it through §8's one asymmetry: the builtin `pmcp` service
 *   participates in an OWNER's listing and can never appear in a service account's. So
 *   "did the tools this caller was served include the builtin" IS the pipeline's
 *   statement about the principal it resolved, for the exact request the row made. That
 *   covers every aggregated row and the scoped `/mcp/pmcp` one.
 *
 * Two rows are left where the surface genuinely cannot name its caller, and both fall
 * back to calling the guard by hand — which is a stated CEILING, not an oracle: their
 * `principal` half is proven against identity, while the surface itself is proven only to
 * have admitted.
 * · /account — the page behind the guard is a 501 stub.
 * · scoped `/mcp/<granted>` — a tools/list there names tools, not callers, and the row's
 *   service is a proxied one whose far side is unreachable in this fixture.
 * Both close the day the row's outcome vocabulary may say `principal: "none"` for a
 * surface that answers no principal — a member §12's bootstrap rows already use.
 */
async function expectAdmittedAs(row: AuthMatrixRow, response: Response): Promise<void> {
  if (row.expect.verdict !== "allow") throw new Error("not an allow row");
  const expected = row.expect.principal;
  if (mcpMethodOf(row.surface) === "initialize") {
    // §7's amended dispatch answers the handshake STATELESSLY: the door resolved a
    // principal, and the answer names none — so `principal: "none"` is this row's honest
    // word, and "admitted" means the handshake HAPPENED. Read the way a client reads it,
    // because every refusal on this surface is also a 200 (§7: refusals are payloads, not
    // statuses) — including the `-32601` this amendment moved `initialize` out of, which a
    // status check alone would accept as admission.
    expect(expected, `${row.title}: the handshake names no principal`).toBe("none");
    const body = (await response.json()) as JsonRpcResponse;
    expect(body.error, `${row.title}: the handshake was refused behind a 200`).toBeUndefined();
    expect(
      (body.result as { protocolVersion?: unknown } | undefined)?.protocolVersion,
      `${row.title}: the answer carries no protocolVersion`,
    ).toBeTruthy();
    return;
  }
  if (expected === "none") {
    // §12's route resolves nobody: "admitted" is the route answering at all.
    expect(response.status).toBe(200);
    return;
  }
  switch (row.surface.route) {
    case "whoami": {
      const body = (await response.json()) as { principal: string };
      expect(principalKindOf(body.principal)).toBe(expected);
      return;
    }
    case "account": {
      // Ceiling, not oracle — the header above says why.
      const session = await requireOwnerSession(requestFor(row), { recent: row.surface.recentAuth });
      expect(session.user.kind).toBe(expected);
      return;
    }
    default: {
      if (row.surface.route === "mcp-scoped" && row.surface.slug !== "pmcp") {
        // The other ceiling: a scoped list names tools, not callers.
        expect((await resolvePrincipal(requestFor(row))).kind).toBe(expected);
        return;
      }
      const served = await servedTools(response);
      expect(served, `${row.title}: the pipeline answered no tool list`).not.toBeNull();
      expect(
        (served ?? []).some(namesTheBuiltin),
        `${row.title}: an owner's listing carries the builtin and an account's never can (§8) — got ${JSON.stringify(served)}`,
      ).toBe(expected === "user");
    }
  }
}

/** The tool names in a JSON-RPC `tools/list` answer, or null when it answered no list. */
async function servedTools(response: Response): Promise<string[] | null> {
  const body = (await response.json()) as JsonRpcResponse;
  const tools = (body.result as { tools?: { name?: unknown }[] } | undefined)?.tools;
  if (!Array.isArray(tools)) return null;
  return tools.map((tool) => String(tool.name));
}

/**
 * Whether a served tool name is one of the builtin's — `pmcp_<op>` on the aggregated
 * endpoint, bare on scoped `/mcp/pmcp`. One op name is enough to recognize the table, and
 * `service_list` is the op §8 pins first.
 */
function namesTheBuiltin(name: string): boolean {
  return name === BUILTIN_OP || name === `${PMCP_SLUG}_${BUILTIN_OP}`;
}

/** An op no other service could plausibly serve — the builtin's fingerprint (§8). */
const BUILTIN_OP = "service_list";

/** `user:` / `sa:` back to the kind — formatPrincipal's one format, read the other way. */
function principalKindOf(principal: string): Principal["kind"] {
  if (principal.startsWith("sa:")) return "service_account";
  if (principal.startsWith("user:")) return "user";
  throw new Error(`unrecognized principal string: ${principal}`);
}

/** A response reduced to what "indistinguishable" means: status, headers, body. */
async function bytesOf(response: Response): Promise<string> {
  const headers: [string, string][] = [];
  response.headers.forEach((value, name) => headers.push([name, value]));
  headers.sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({ status: response.status, headers, body: await response.text() });
}

/** One row by title — the lookup the invariants and the section split both read. */
function rowTitled(title: string): AuthMatrixRow {
  const row = AUTH_MATRIX_ROWS.find((candidate) => candidate.title === title);
  if (!row) throw new Error(`no row titled "${title}"`);
  return row;
}

/**
 * The handful of titles named twice — once by a row, once by an assertion about that row.
 * Spelled here so a retitled row breaks in ONE place instead of drifting silently.
 */
const TITLES = {
  noHeaderOnSelf: "§7 step 1 · no Authorization header at all is refused with the same 401",
  noHeaderOnAbsent:
    "§7 step 1 · an unauthenticated request gets the same 401 whether `<user>` exists or not",
  foreignNamespace: "§7 step 1 · a resolved account on a foreign namespace gets 404, not 403",
  absentUsername:
    "§7 step 1 · any resolved principal on a nonexistent username gets 404 — byte-identical to route-not-found",
  ungrantedSlug:
    "§7 step 2 · a service account on a scoped slug it holds no grants on gets 404 — identical to a nonexistent slug",
  absentSlug:
    "§7 step 2 · a service account on a scoped slug that does not exist gets the same 404 — the pair's other half, byte-compared against it",
  pmcpForAccount:
    "§8 · a live service-account key on scoped /mcp/pmcp gets 404 — the same answer as any slug it holds no grants on, never a 401",
} as const;

/**
 * The authored table is written in the order of the describes below, one contiguous block
 * per section. Naming each block's FIRST row is enough to split it, and is the smallest
 * thing that has to stay in step with the table (naming all thirty-odd titles twice would
 * be the change amplification this file exists to avoid).
 */
const SECTION_ANCHORS = [
  "§7 step 1 · a live `pmcp_sa_` key resolves to its service account (the anchor allow-twin)",
  "§7 step 1 · a resolved account on its own namespace is admitted",
  "§7 step 1 · a valid session cookie with no Authorization header is refused on /mcp — cookies are never consulted",
  "§8 · a `pmcp_sa_` key resolves to the service-account principal in the owner's namespace",
  "§4 · a password session with recent auth reaches /account (the twin)",
  "§12 · with BOOTSTRAP_SECRET unset, every request 404s — indistinguishable from an unknown path",
  "§7 step 1 · a live `pmcp_sa_` key opens the MCP handshake — `initialize` is behind the auth door and answered through it (the handshake allow-twin)",
] as const;

/** The sections as slices, computed once — a malformed anchor list fails at import. */
const SECTIONS: AuthMatrixRow[][] = (() => {
  const starts = SECTION_ANCHORS.map((title) => AUTH_MATRIX_ROWS.indexOf(rowTitled(title)));
  if (starts[0] !== 0 || starts.some((at, i) => i > 0 && at <= starts[i - 1])) {
    throw new Error("SECTION_ANCHORS must name the first row of each section, in table order");
  }
  return starts.map((at, i) => [...AUTH_MATRIX_ROWS.slice(at, starts[i + 1] ?? AUTH_MATRIX_ROWS.length)]);
})();

describe("§7 step 1 — resolution dispatches on prefix", () => {
  runAuthMatrix(SECTIONS[0]);
});

describe("§7 step 1 — namespaces never leak existence", () => {
  runAuthMatrix(SECTIONS[1]);
});

describe("§7 step 1 — carrier and transport hygiene", () => {
  runAuthMatrix(SECTIONS[2]);
});

describe("§8 — /api/whoami mirrors step 1 exactly", () => {
  runAuthMatrix(SECTIONS[3]);
});

describe("§4/§13 — session-scope guards on /account", () => {
  runAuthMatrix(SECTIONS[4]);
});

describe("§12 — the bootstrap route exists only while its secret does", () => {
  runAuthMatrix(SECTIONS[5]);

  // §12/§2: POST /internal/users is "the only user management surface" — so better-auth's
  // own /sign-up/email, live on the same public /api/auth mount, must NOT self-provision.
  // Driven as the attacker's request actually arrives: no cookie, no Origin (which is what
  // skips better-auth's CSRF check), a valid username and a long password — the one input
  // combination that WOULD create the row if sign-up were open.
  it("§12 · anonymous POST /api/auth/sign-up/email cannot create a user", async () => {
    const response = await call(
      new Request(`${ORIGIN}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "intruder",
          email: "intruder@example.com",
          password: "correct-horse-battery-staple",
          username: "intruder",
        }),
      }),
    );
    expect(response.ok).toBe(false);
    // And the namespace it tried to claim does not exist afterwards.
    const whoami = await call(
      new Request(`${ORIGIN}/api/whoami`, { headers: { authorization: "Bearer pmcp_sa_FAKE0000" } }),
    );
    expect(whoami.status).toBe(401);
  });
});

describe("§7 step 1, amended 2026-08-26 — the handshake is behind the same door", () => {
  runAuthMatrix(SECTIONS[6]);
});

describe("the table's own invariants", () => {
  runTableInvariants();
});

/**
 * §4's session-scope guard, at the door the /account wrappers do not stand in front of.
 *
 * The rows above pin that a device-flow session cannot reach `/account`, and identity's
 * `requireOwnerSession` earns that by reading Cookie ONLY. But better-auth's own credential
 * endpoints are live on the same public `/api/auth` mount, and §4's `bearer()` plugin
 * rewrites any `Authorization` header into a session for better-auth's middleware — so a
 * request straight at the mount never routes through a wrapper at all, and the Cookie-only
 * guard never runs. §4's harm sentence is exactly that path: "a stolen CLI token cannot
 * enroll new credentials and become persistent account takeover".
 *
 * Deliberately NOT table rows: AUTH_MATRIX_ROWS is the owner-authored oracle (strategy §9
 * rule 1, "agents … never rows"). These are agent-written regression cases, beside the §12
 * sign-up case above — which exists for the same reason, about the same mount: what
 * better-auth serves under it is a surface of ours whether or not a row describes it.
 *
 * The actor is the real credential: `fixture.sessions.device` came out of the whole RFC
 * 8628 exchange, so a hub with no guard admits it. A fabricated token would be refused by
 * anything and would pin nothing. Last in the file on purpose — under red these calls
 * genuinely revoke sessions the rows above spend.
 */
describe("§4 — the credential family is out of a bearer's reach on better-auth's own mount", () => {
  /**
   * The family members these cases drive, as method + endpoint beneath AUTH_BASE_PATH.
   * Two are §4's own words ("session revocation"; TOTP removal), and the third is the
   * session LISTING — its rows carry session tokens (web.ts reads `{ id, token }` off it),
   * so a bearer that reaches it walks away with the browser cookie's session and the
   * cookie-only guard has been routed around rather than enforced. The destructive members
   * (`/update-user`, `/delete-user`) are guarded and deliberately not driven: red would
   * have run them against the fixture.
   *
   * The last two are the account-LINKING core, and they are here because a guard written
   * as a list of family names cannot see them: better-auth serves `/list-accounts` and
   * `/unlink-account` on this mount from its core, under no plugin this hub configured, so
   * a guard that enumerates has to have been told about them. §4's harm sentence is these
   * two exactly — the login methods behind the account are what "enroll new credentials
   * and become persistent account takeover" means. `/unlink-account` is driven with a body
   * better-auth rejects on purpose: under red the guard is not there, and a valid body
   * would have taken the fixture owner's password login away with it.
   */
  const CREDENTIAL_CALLS: readonly {
    method: "GET" | "POST";
    endpoint: string;
    body?: Record<string, unknown>;
  }[] = [
    { method: "POST", endpoint: "/revoke-sessions", body: {} },
    { method: "POST", endpoint: "/two-factor/disable", body: { password: "FAKE0000-not-a-password" } },
    { method: "GET", endpoint: "/list-sessions" },
    { method: "GET", endpoint: "/list-accounts" },
    { method: "POST", endpoint: "/unlink-account", body: { providerId: "credential" } },
  ];

  for (const { method, endpoint, body } of CREDENTIAL_CALLS) {
    it(`§4 · a device-flow bearer is refused at ${AUTH_BASE_PATH}${endpoint} — the mount is gated, not merely the wrappers`, async () => {
      const response = await call(bearerCall(method, endpoint, fixture.sessions.device.token, body));
      expect(response.status).toBe(403);
      // No challenge: a credential that is refused for its SCOPE is not one to retry with a
      // better token, and §7 attaches `WWW-Authenticate` to the consumer surfaces alone.
      expect(response.headers.has("WWW-Authenticate")).toBe(false);
      // §15: the refusal carries no credential material back out.
      expect(await response.text()).not.toContain(fixture.sessions.device.token);
    });
  }

  // The carrier is what the gate reads, not the session's source — which is the whole
  // reason it is structural. A password session is the ONE session §4 lets near credential
  // management, and even it may only arrive as the signed cookie the /account rows above
  // present (their allow-twin, not duplicated here).
  it("§4 · a password-sourced session presented as a bearer is refused there too — the same session's cookie is what /account accepts", async () => {
    const response = await call(bearerCall("POST", "/revoke-sessions", fixture.sessions.fresh.token, {}));
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(fixture.sessions.fresh.token);
  });

  // §9 rule 2's twin, and the regression the fix must not become: §4 limits a CLI session's
  // SCOPE, it does not reject the credential. The device token this suite just had refused
  // three times still resolves everywhere the CLI needs it — §8's whoami and §7's consumer
  // endpoint — which is also proof the refusals above are not a token that had simply died.
  it("§4/§8 · the same device-flow bearer still reads /api/whoami and still reaches /<user>/mcp", async () => {
    const token = fixture.sessions.device.token;
    const whoami = await call(
      new Request(`${ORIGIN}/api/whoami`, { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(whoami.status).toBe(200);
    expect(((await whoami.json()) as { principal: string }).principal).toBe(
      `user:${fixture.self.owner.username}`,
    );
    const mcp = await call(
      new Request(`${ORIGIN}/${fixture.self.owner.username}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(mcp.status).toBe(200);
  });

  // Strategy §9 rule 4a, the device flow's half — but the exclusion runs the OTHER way from
  // sign-out. A device APPROVAL is how a second session comes to exist, so admitting a bearer
  // there lets a stolen CLI token self-approve a fresh owner session that outlives revocation
  // of the stolen one (§4's persistent-takeover sentence, reached through this very door). So
  // the claim and the approval are cookie-only: a bearer is REFUSED at both, exactly like any
  // other family member, while the anonymous `/device/code` leg it needs first is not. The
  // legitimate path is the cookie one `deviceFlowSession` drives — which the whole fixture
  // already rests on, since `fixture.sessions.device` is minted through it — so the debt this
  // exclusion owes is paid there rather than re-driven here.
  it("§4/§14 · a session bearer is refused at the `/device` approval legs — approving a device is not something a bearer may do", async () => {
    const token = fixture.sessions.fresh.token;
    const codes = (await (
      await call(
        new Request(`${ORIGIN}${AUTH_BASE_PATH}/device/code`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ client_id: DEVICE_CLIENT_ID }),
        }),
      )
    ).json()) as { user_code: string };
    // The bare `/device` claim and the approval POST both sit outside the allowlist — the
    // guard answers 403 before better-auth ever sees the code, so a bearer cannot even claim.
    const claimed = await call(
      bearerCall("GET", `/device?user_code=${encodeURIComponent(codes.user_code)}`, token),
    );
    expect(claimed.status).toBe(403);
    expect(claimed.headers.has("WWW-Authenticate")).toBe(false);
    const approved = await call(
      bearerCall("POST", "/device/approve", token, { userCode: codes.user_code }),
    );
    expect(approved.status).toBe(403);
    expect(await approved.text()).not.toContain(token);
  });

  // Strategy §9 rule 4a — an exclusion is a debt owed to another case: the guard's list
  // deliberately leaves `/sign-out` out, because `pmcp logout` posts it with exactly this
  // header (cli/src/main.ts) and a session that destroys only itself escalates nothing. So
  // the exclusion is SPENT here rather than asserted in prose, and the postcondition is the
  // logout the CLI is entitled to: the token that just signed out resolves to nobody.
  // Last in the file — this case ends the session every case above spends.
  it("§4/§10 · /sign-out is deliberately outside the family — `pmcp logout` still posts it as a bearer, and the session is gone afterwards", async () => {
    const token = fixture.sessions.device.token;
    const signedOut = await call(bearerCall("POST", "/sign-out", token, {}));
    expect(signedOut.status).not.toBe(403);
    expect(signedOut.ok).toBe(true);
    const after = await call(
      new Request(`${ORIGIN}/api/whoami`, { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(after.status).toBe(401);
  });
});

/**
 * One request at better-auth's own mount, carrying a session token the way a stolen one
 * arrives: `Authorization: Bearer`, and no cookie anywhere.
 */
function bearerCall(
  method: "GET" | "POST",
  endpoint: string,
  token: string,
  body?: Record<string, unknown>,
): Request {
  return new Request(`${ORIGIN}${AUTH_BASE_PATH}${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// ─────────────────────────────── §19: the OAuth door ───────────────────────────────
//
// §19.6/§19.8, the OAuth leg of the same door §7 step 1 owns: a JWT-shaped bearer becomes a
// `service_account` principal indistinguishable from that account's `pmcp_sa_` key, or one of
// many 401s. These are agent-written cases, NOT AUTH_MATRIX_ROWS (strategy §9 rule 1: agents
// author no oracle rows), beside the §12 sign-up and §4 credential-family blocks — for the same
// reason: the OAuth surface is a surface of ours whether or not a row of the owner's table names
// it, and the plan's oracle-style titles for the door are copied here VERBATIM.
//
// Every valid token is minted through the REAL provider flow (register → authorize → consent →
// token), never hand-forged: a hub-signed access token is one only the authorization server can
// produce, so the fixture drives it exactly as claude.ai would, with cookies and no Authorization
// header (§19.7), then binds the client with the same `oauth.upsertBinding` seam the consent page
// uses. The refusal cases each reach a state the door must reject — a foreign audience, an expired
// exp, a missing `mcp` scope, a scoped-URL audience, a tampered signature, no binding, a revoked
// one, a deleted account — each beside its live allow-twin (the same valid token, or the account's
// key). The crown jewel is `§7/§19.6 · no OAuth-leg failure resolves as the owner`: a JWT-shaped
// bearer that fails on anything is a 401, never a fall-through to the session lookup.

const OAUTH2 = `${ORIGIN}/api/auth/oauth2`;
/** claude.ai's real redirect URI shape (§19.6): https, non-loopback, so the provider's "web"
 *  application-type policy accepts it. */
const OAUTH_REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
/** RFC 7636 Appendix B's PKCE pair — a real verifier and its S256 challenge, not a secret. */
const PKCE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const PKCE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

/** The door fixture's two proxied services — one the account has a grant on, one it does not.
 *  Proxied to an unreachable upstream: the pipeline is reached (past the door) and answers the
 *  SAME bytes for either carrier, which is all these cases read. */
const DOOR_GRANTED = "news";
const DOOR_UNGRANTED = "solo";
const DOOR_UPSTREAM = "https://upstream.invalid/mcp";

/** §19.3's namespace resource identifier — the aggregated URL a token's `aud` must equal. */
function oauthResourceFor(username: string): string {
  return `${ORIGIN}/${username}/mcp`;
}

/** A minted access token and the client it was issued to. */
type OAuthClient = { token: string; clientId: string };

/** Register a public client through anonymous DCR (§19.3) and return its server-assigned id. */
async function registerOAuthClient(send: (request: Request) => Promise<Response>): Promise<string> {
  const response = await send(
    new Request(`${OAUTH2}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "pmcp door test",
        redirect_uris: [OAUTH_REDIRECT_URI],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
  );
  const id = ((await response.json()) as { client_id?: string }).client_id;
  if (id === undefined) throw new Error(`registerOAuthClient: ${response.status}`);
  return id;
}

/** The provider answers its redirects as `{ redirect, url }` (accept: application/json) —
 *  `redirect_uri` is the OpenAPI spelling; read whichever it gives. */
function redirectUrlOf(body: unknown): string {
  const value = body as { url?: string; redirect_uri?: string };
  return value.url ?? value.redirect_uri ?? "";
}

/**
 * The whole authorization-code + PKCE flow as claude.ai runs it, driven through the provider's
 * own endpoints with the owner's cookie and NO Authorization header (§19.7): register → authorize
 * (→ the signed consent query) → provider `/oauth2/consent` (→ the code) → token. `resource: null`
 * omits RFC 8707 and yields an opaque token; a scope other than "mcp" and a scoped resource are how
 * the refusal cases reach the state the door must reject. `send` is the composition-root `call` by
 * default; the §19.7 case passes a guarded one that records any Authorization header.
 */
async function driveOAuth(opts: {
  cookie: string;
  scope?: string;
  resource: string | null;
  send?: (request: Request) => Promise<Response>;
}): Promise<OAuthClient> {
  const send = opts.send ?? ((request: Request) => call(request));
  const clientId = await registerOAuthClient(send);
  const params: Record<string, string> = {
    client_id: clientId,
    redirect_uri: OAUTH_REDIRECT_URI,
    response_type: "code",
    scope: opts.scope ?? "mcp",
    code_challenge: PKCE_CHALLENGE,
    code_challenge_method: "S256",
  };
  if (opts.resource !== null) params.resource = opts.resource;
  const authorize = await send(
    new Request(`${OAUTH2}/authorize?${new URLSearchParams(params)}`, {
      headers: { cookie: opts.cookie, accept: "application/json" },
    }),
  );
  const oauthQuery = redirectUrlOf(await authorize.json()).split("?")[1] ?? "";
  const consent = await send(
    new Request(`${OAUTH2}/consent`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: opts.cookie, origin: ORIGIN, accept: "application/json" },
      body: JSON.stringify({ accept: true, oauth_query: oauthQuery }),
    }),
  );
  const code = new URL(redirectUrlOf(await consent.json())).searchParams.get("code");
  if (code === null) throw new Error("driveOAuth: consent issued no code");
  const tokenBody: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: OAUTH_REDIRECT_URI,
    client_id: clientId,
    code_verifier: PKCE_VERIFIER,
  };
  if (opts.resource !== null) tokenBody.resource = opts.resource;
  // The provider's token endpoint accepts application/x-www-form-urlencoded ONLY.
  const token = await send(
    new Request(`${OAUTH2}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(tokenBody).toString(),
    }),
  );
  const accessToken = ((await token.json()) as { access_token?: string }).access_token;
  if (accessToken === undefined) throw new Error(`driveOAuth: token exchange ${token.status}`);
  return { token: accessToken, clientId };
}

/** Bind a client to a service account through the consent page's own seam (§19.5). */
async function bindClient(ownerId: string, clientId: string, serviceAccountId: string): Promise<{ id: string }> {
  const upsert = await upsertBinding({ ownerId, clientId, serviceAccountId });
  if (upsert === null) throw new Error("bindClient: the account is not in that namespace");
  return { id: upsert.id };
}

/** One JSON-RPC request at an MCP endpoint, with an optional bearer. */
function mcpCall(url: string, token: string | null, method: string, params?: unknown): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return call(
    new Request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
    }),
  );
}

/** Flip one character of a JWT's signature segment: the claims are untouched (right aud, iss,
 *  scope), only the signature no longer verifies against the hub's JWKS — a token signed by an
 *  unknown key, still exactly three base64url segments. */
function tamperSignature(jwt: string): string {
  const [header, payload, signature] = jwt.split(".");
  const flipped = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
  return `${header}.${payload}.${flipped}`;
}

/** GET /api/auth/token with a cookie session (§19.2): a correctly-signed, correctly-issued
 *  hub JWT that is NOT an access token — no `mcp` scope, `aud` the origin root, not a namespace. */
async function mintSessionJwt(cookie: string): Promise<string> {
  const response = await call(new Request(`${ORIGIN}${AUTH_BASE_PATH}/token`, { headers: { cookie } }));
  const token = ((await response.json()) as { token?: string }).token;
  if (token === undefined) throw new Error(`/api/auth/token: ${response.status}`);
  return token;
}

/** The coarse `last_used_at` stamp on one binding row, read straight from D1. */
async function bindingLastUsed(id: string): Promise<number | null> {
  const row = await (env.DB as D1Like)
    .prepare(`SELECT "last_used_at" AS n FROM oauth_binding WHERE "id" = ?`)
    .bind(id)
    .first<{ n: number | null }>();
  return row?.n ?? null;
}

/**
 * The door fixture: one namespace with a granted and an ungranted proxied service, an `agent`
 * account holding a `pmcp_sa_` key and a live OAuth binding, and a SECOND namespace whose token's
 * audience is deliberately foreign to the first.
 */
type DoorFixture = {
  self: SeededNamespace;
  user: string;
  ownerId: string;
  agentId: string;
  session: SeededSession;
  validClient: OAuthClient;
  agentKey: string;
  /** A fully valid access token for ANOTHER namespace — its `aud` names `foreign`, not `self`. */
  foreignAudToken: string;
};
let door: DoorFixture;

describe("§19.6/§19.8 — the OAuth door", () => {
  beforeAll(async () => {
    const self = await seedNamespace(env.DB, {
      services: [
        { slug: DOOR_GRANTED, kind: "proxy", upstreamUrl: DOOR_UPSTREAM, roles: { reader: ["get.*"] } },
        { slug: DOOR_UNGRANTED, kind: "proxy", upstreamUrl: DOOR_UPSTREAM, roles: { reader: ["get.*"] } },
      ],
      accounts: [
        {
          slug: "agent",
          grants: { [DOOR_GRANTED]: [{ role: "reader", mode: "allow" }] },
          tokens: [{ as: "key" }],
        },
      ],
    });
    const session = await seedOwnerSession(self.owner);
    const validClient = await driveOAuth({ cookie: session.cookie, resource: oauthResourceFor(self.owner.username) });
    await bindClient(self.owner.userId, validClient.clientId, self.accounts.agent.id);

    // A real, live token for a DIFFERENT namespace — the audience-mismatch cases present it here.
    const foreign = await seedNamespace(env.DB, { accounts: [{ slug: "agent" }] });
    const foreignSession = await seedOwnerSession(foreign.owner);
    const foreignClient = await driveOAuth({
      cookie: foreignSession.cookie,
      resource: oauthResourceFor(foreign.owner.username),
    });
    await bindClient(foreign.owner.userId, foreignClient.clientId, foreign.accounts.agent.id);

    door = {
      self,
      user: self.owner.username,
      ownerId: self.owner.userId,
      agentId: self.accounts.agent.id,
      session,
      validClient,
      agentKey: self.tokens.key.token,
      foreignAudToken: foreignClient.token,
    };
  });

  it("§19.6 · a valid OAuth access token resolves to sa:<slug> and reaches tools/call · the same account's pmcp_sa_ key resolves identically (the twin — nothing downstream branches on carrier)", async () => {
    const aggregated = `${ORIGIN}/${door.user}/mcp`;
    // Resolves to the SERVICE ACCOUNT — the aggregated listing carries no builtin (only an
    // owner's does, §8) — and it is the SAME listing the account's own key produces.
    const oauthTools = await servedTools(await mcpCall(aggregated, door.validClient.token, "tools/list"));
    const keyTools = await servedTools(await mcpCall(aggregated, door.agentKey, "tools/list"));
    expect(oauthTools, "the OAuth token was refused at the door").not.toBeNull();
    expect(oauthTools?.some(namesTheBuiltin)).toBe(false);
    expect(oauthTools).toEqual(keyTools);
    // Reaches tools/call on the granted service — past the door, the SAME bytes either carrier.
    const scoped = `${ORIGIN}/${door.user}/mcp/${DOOR_GRANTED}`;
    const oauthCall = await mcpCall(scoped, door.validClient.token, "tools/call", { name: "get.thing", arguments: {} });
    const keyCall = await mcpCall(scoped, door.agentKey, "tools/call", { name: "get.thing", arguments: {} });
    expect(oauthCall.status).toBe(200);
    expect(await oauthCall.text()).toEqual(await keyCall.text());
  });

  it("§19.6/§8 · an OAuth-resolved principal on /<user>/mcp/pmcp gets the same 404 a pmcp_sa_ key gets — the namespace-wide audience resolves, and the refusal comes from grants, not from the door", async () => {
    const url = `${ORIGIN}/${door.user}/mcp/${PMCP_SLUG}`;
    const oauth = await mcpCall(url, door.validClient.token, "tools/list");
    const key = await mcpCall(url, door.agentKey, "tools/list");
    expect(oauth.status).toBe(404);
    // Byte-identical to the key's 404: the audience resolved, and a service account holds no
    // `pmcp` grant (§8), so the refusal is the anonymous 404, not a door 401.
    expect(await bytesOf(oauth)).toEqual(await bytesOf(key));
  });

  it("§19.6 · a namespace-audience JWT reaches /<user>/mcp/<slug> and is filtered by that account's grants · the same account's pmcp_sa_ key behaves identically on the same URL (the twin — the audience is namespace-wide, so neither carrier is weaker)", async () => {
    // The granted slug: the namespace-wide audience reaches the scoped service, past the door.
    const granted = `${ORIGIN}/${door.user}/mcp/${DOOR_GRANTED}`;
    const oauthGranted = await mcpCall(granted, door.validClient.token, "tools/list");
    const keyGranted = await mcpCall(granted, door.agentKey, "tools/list");
    expect(oauthGranted.status).toBe(200);
    expect(await oauthGranted.text()).toEqual(await keyGranted.text());
    // A slug the account holds no grant on: the same 404 the key gets — grants filter, not the door.
    const ungranted = `${ORIGIN}/${door.user}/mcp/${DOOR_UNGRANTED}`;
    const oauthUngranted = await mcpCall(ungranted, door.validClient.token, "tools/list");
    const keyUngranted = await mcpCall(ungranted, door.agentKey, "tools/list");
    expect(oauthUngranted.status).toBe(404);
    expect(await bytesOf(oauthUngranted)).toEqual(await bytesOf(keyUngranted));
  });

  it("§19.8 · no Authorization on /<user>/mcp → 401 whose WWW-Authenticate names resource_metadata for that namespace and scope \"mcp\"", async () => {
    const response = await mcpCall(`${ORIGIN}/${door.user}/mcp`, null, "tools/list");
    expect(response.status).toBe(401);
    const challenge = response.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/${door.user}/mcp"`,
    );
    expect(challenge).toContain('scope="mcp"');
  });

  it("§19.8/§7 · the 401 challenge on a live namespace and on a nonexistent one are byte-identical", async () => {
    // The SAME username, its existence toggled: the challenge is derived from the path and
    // looked up nowhere, so seeding and then deleting the namespace cannot move a byte of it.
    const ns = await seedNamespace(env.DB, {});
    const url = `${ORIGIN}/${ns.owner.username}/mcp`;
    const live = await bytesOf(await mcpCall(url, null, "tools/list"));
    await ns.teardown();
    const absent = await bytesOf(await mcpCall(url, null, "tools/list"));
    expect(live).toEqual(absent);
  });

  it("§19.8 · a JWT whose aud names another namespace is 401 on this one, never a 404 — audience is a resolution failure, not a namespace judgment", async () => {
    const response = await mcpCall(`${ORIGIN}/${door.user}/mcp`, door.foreignAudToken, "tools/list");
    expect(response.status).toBe(401);
    expect(response.headers.has("WWW-Authenticate")).toBe(true);
    // A 404 would be the answer for a RESOLVED principal on a foreign namespace; a wrong audience
    // resolves nobody, so it is the 401 no-token gets, learning nothing about either namespace.
    expect(response.status).not.toBe(404);
  });

  it("§19.6 · a JWT whose aud is the scoped URL /<user>/mcp/<slug> rather than the namespace's canonical aggregated URL is refused on BOTH endpoint shapes — namespace-wide means exactly one string", async () => {
    const scopedResource = `${ORIGIN}/${door.user}/mcp/${DOOR_GRANTED}`;
    // No PRM or oauthResource for a scoped URL exists in production (§19.9); inserting one here
    // is the only way to MINT a token whose aud is the scoped URL — the state the door must
    // refuse. Binding the client proves the refusal is the AUDIENCE, not a missing binding.
    await (env.DB as D1Like)
      .prepare(`INSERT INTO "oauthResource" ("id", "identifier", "name") VALUES (?, ?, ?)`)
      .bind(crypto.randomUUID(), scopedResource, `${door.user}/${DOOR_GRANTED}`)
      .run();
    try {
      const client = await driveOAuth({ cookie: door.session.cookie, resource: scopedResource });
      await bindClient(door.ownerId, client.clientId, door.agentId);
      const aggregated = await mcpCall(`${ORIGIN}/${door.user}/mcp`, client.token, "tools/list");
      const scoped = await mcpCall(scopedResource, client.token, "tools/list");
      expect(aggregated.status).toBe(401);
      expect(scoped.status).toBe(401);
    } finally {
      await (env.DB as D1Like)
        .prepare(`DELETE FROM "oauthResource" WHERE "identifier" = ?`)
        .bind(scopedResource)
        .run();
    }
  });

  it("§19.6 · a JWT signed by an unknown key is refused · a real access token from the hub's own authorization server is accepted (the twin — the acceptance test is the claims, not the signer)", async () => {
    const refused = await mcpCall(`${ORIGIN}/${door.user}/mcp`, tamperSignature(door.validClient.token), "tools/list");
    expect(refused.status).toBe(401);
    // The twin: the untampered token, identical claims, verifies and is accepted.
    const accepted = await mcpCall(`${ORIGIN}/${door.user}/mcp`, door.validClient.token, "tools/list");
    expect(accepted.status).toBe(200);
  });

  it("§19.6/§19.2 · a JWT minted from a live cookie session at /api/auth/token is refused at /<user>/mcp — hub-signed is not sufficient", async () => {
    const sessionJwt = await mintSessionJwt(door.session.cookie);
    const response = await mcpCall(`${ORIGIN}/${door.user}/mcp`, sessionJwt, "tools/list");
    expect(response.status).toBe(401);
  });

  it("§7/§19.6 · \"JWT-shaped\" is exactly three non-empty base64url segments — a two- or four-segment bearer takes the session path, a three-segment base64url string that verifies as nothing takes the OAuth path and 401s (both directions)", async () => {
    const aggregated = `${ORIGIN}/${door.user}/mcp`;
    // A better-auth session bearer is ONE segment — not JWT-shaped — so it takes the session
    // path and resolves to the OWNER, whose aggregated listing carries the builtin (§8).
    const asOwner = await mcpCall(aggregated, door.session.token, "tools/list");
    expect(asOwner.status).toBe(200);
    expect((await servedTools(asOwner))?.some(namesTheBuiltin)).toBe(true);
    // A three-segment access token takes the OAuth path and resolves to the SERVICE ACCOUNT
    // (no builtin) — the other direction, observable in WHO each carrier resolves to.
    const asAccount = await mcpCall(aggregated, door.validClient.token, "tools/list");
    expect(asAccount.status).toBe(200);
    expect((await servedTools(asAccount))?.some(namesTheBuiltin)).toBe(false);
    // Two- and four-segment bearers are not JWT-shaped → session path → refused (junk).
    expect((await mcpCall(aggregated, "aa.bb", "tools/list")).status).toBe(401);
    expect((await mcpCall(aggregated, "aa.bb.cc.dd", "tools/list")).status).toBe(401);
    // Exactly three base64url segments that verify as nothing → OAuth path → 401.
    expect((await mcpCall(aggregated, "aaa.bbb.ccc", "tools/list")).status).toBe(401);
  });

  it("§7/§19.6 · no OAuth-leg failure resolves as the owner — a JWT-shaped bearer never reaches the session lookup, whatever it fails on (the leg is terminal, fail-closed)", async () => {
    const sessionJwt = await mintSessionJwt(door.session.cookie);
    // Each is JWT-shaped and fails the OAuth leg on a DIFFERENT thing; none may fall through to
    // the session lookup and resolve as the owner — an owner resolution is a 200 tools/list, so
    // a terminal leg answers every one with a 401.
    const failing = [
      sessionJwt, // hub-signed, wrong aud + no mcp scope
      tamperSignature(door.validClient.token), // signature does not verify
      door.foreignAudToken, // another namespace's audience
      "aaa.bbb.ccc", // verifies as nothing
    ];
    for (const token of failing) {
      const response = await mcpCall(`${ORIGIN}/${door.user}/mcp`, token, "tools/list");
      expect(response.status, "a JWT-shaped bearer resolved past its OAuth-leg failure").toBe(401);
    }
  });

  it("§19.6 · an expired JWT is refused with the challenge", async () => {
    const ns = await seedNamespace(env.DB, { accounts: [{ slug: "agent" }] });
    const cookie = (await seedOwnerSession(ns.owner)).cookie;
    const resource = oauthResourceFor(ns.owner.username);
    // Born expired: a negative access-token TTL on this namespace's resource, so the minted
    // token's exp is already past when the door verifies it. Restored in `finally`.
    await (env.DB as D1Like)
      .prepare(`UPDATE "oauthResource" SET "accessTokenTtl" = ? WHERE "identifier" = ?`)
      .bind(-3600, resource)
      .run();
    try {
      const client = await driveOAuth({ cookie, resource });
      await bindClient(ns.owner.userId, client.clientId, ns.accounts.agent.id);
      const response = await mcpCall(`${ORIGIN}/${ns.owner.username}/mcp`, client.token, "tools/list");
      expect(response.status).toBe(401);
      expect(response.headers.has("WWW-Authenticate")).toBe(true);
    } finally {
      await (env.DB as D1Like)
        .prepare(`UPDATE "oauthResource" SET "accessTokenTtl" = NULL WHERE "identifier" = ?`)
        .bind(resource)
        .run();
    }
  });

  it("§19.6 · a JWT lacking the \"mcp\" scope is refused", async () => {
    // scope=offline_access only, correct aud, bound — so the ONLY thing missing is the mcp scope.
    const client = await driveOAuth({ cookie: door.session.cookie, scope: "offline_access", resource: oauthResourceFor(door.user) });
    await bindClient(door.ownerId, client.clientId, door.agentId);
    const response = await mcpCall(`${ORIGIN}/${door.user}/mcp`, client.token, "tools/list");
    expect(response.status).toBe(401);
  });

  it("§19.8 · a JWT with no oauth_binding row is refused with the challenge (unknown client)", async () => {
    // Minted and correctly signed for this namespace, but never bound to any account.
    const client = await driveOAuth({ cookie: door.session.cookie, resource: oauthResourceFor(door.user) });
    const response = await mcpCall(`${ORIGIN}/${door.user}/mcp`, client.token, "tools/list");
    expect(response.status).toBe(401);
    expect(response.headers.has("WWW-Authenticate")).toBe(true);
  });

  it("§19.8 · a binding revoked between two calls refuses the second — revocation is immediate, not exp-bound", async () => {
    const client = await driveOAuth({ cookie: door.session.cookie, resource: oauthResourceFor(door.user) });
    const binding = await bindClient(door.ownerId, client.clientId, door.agentId);
    expect((await mcpCall(`${ORIGIN}/${door.user}/mcp`, client.token, "tools/list")).status).toBe(200);
    await revokeConnection(door.ownerId, binding.id);
    expect((await mcpCall(`${ORIGIN}/${door.user}/mcp`, client.token, "tools/list")).status).toBe(401);
  });

  it("§19.8 · deleting the bound service account refuses the next call (the FK cascade is the revocation)", async () => {
    const ns = await seedNamespace(env.DB, { accounts: [{ slug: "agent" }] });
    const cookie = (await seedOwnerSession(ns.owner)).cookie;
    const client = await driveOAuth({ cookie, resource: oauthResourceFor(ns.owner.username) });
    await bindClient(ns.owner.userId, client.clientId, ns.accounts.agent.id);
    expect((await mcpCall(`${ORIGIN}/${ns.owner.username}/mcp`, client.token, "tools/list")).status).toBe(200);
    // The binding's service_account_id FK is ON DELETE CASCADE (§19.4): deleting the account
    // removes the binding, so the door's per-call read finds nothing.
    await new Registry(env.DB).deleteAccount(ns.accounts.agent.id);
    expect((await mcpCall(`${ORIGIN}/${ns.owner.username}/mcp`, client.token, "tools/list")).status).toBe(401);
  });

  it("§19.6 · an opaque access token (no RFC 8707 resource on the token request) is refused with the challenge", async () => {
    // No `resource` → the provider issues an OPAQUE token (one segment, not a JWT), which the
    // hub cannot validate in-worker and so refuses at the door.
    const client = await driveOAuth({ cookie: door.session.cookie, resource: null });
    const response = await mcpCall(`${ORIGIN}/${door.user}/mcp`, client.token, "tools/list");
    expect(response.status).toBe(401);
    expect(response.headers.has("WWW-Authenticate")).toBe(true);
  });

  it("§19.6 · a successful OAuth call stamps oauth_binding.last_used_at at most once per TOKEN_LAST_USED_STAMP_MS", async () => {
    const client = await driveOAuth({ cookie: door.session.cookie, resource: oauthResourceFor(door.user) });
    const binding = await bindClient(door.ownerId, client.clientId, door.agentId);
    expect(await bindingLastUsed(binding.id)).toBeNull(); // fresh binding, never used
    await mcpCall(`${ORIGIN}/${door.user}/mcp`, client.token, "tools/list");
    const first = await bindingLastUsed(binding.id);
    expect(first).not.toBeNull();
    // A second call moments later — well within the coarse window — must not advance the stamp.
    await mcpCall(`${ORIGIN}/${door.user}/mcp`, client.token, "tools/list");
    expect(await bindingLastUsed(binding.id)).toBe(first);
    expect(Date.now() - (first ?? 0)).toBeLessThan(TOKEN_LAST_USED_STAMP_MS);
  });

  it("§8/§19.2 · /api/whoami's 401 carries the bare Bearer challenge — no resource_metadata, because it is not an MCP resource", async () => {
    const response = await call(new Request(`${ORIGIN}/api/whoami`));
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("§8/§19.6 · /api/whoami refuses a JWT-shaped bearer with 401 and runs neither the OAuth leg nor a session lookup for it · a pmcp_sa_ key still answers sa:<slug> (the twin — the leg lives only on /<user>/mcp*)", async () => {
    // A valid access token for `self`'s namespace, presented where there is no namespace to bind
    // its audience to: refused, with the bare Bearer challenge — no OAuth leg, no session lookup.
    const jwt = await call(new Request(`${ORIGIN}/api/whoami`, { headers: { authorization: `Bearer ${door.validClient.token}` } }));
    expect(jwt.status).toBe(401);
    expect(jwt.headers.get("WWW-Authenticate")).toBe("Bearer");
    // The twin: the account's key still resolves on the same route.
    const key = await call(new Request(`${ORIGIN}/api/whoami`, { headers: { authorization: `Bearer ${door.agentKey}` } }));
    expect(key.status).toBe(200);
    expect(((await key.json()) as { principal: string }).principal).toBe("sa:agent");
  });

  it("§19.7 · D11's allowlist admits an Authorization header under /api/auth only at /sign-out and /device/* · a bearer on /api/auth/token is refused there like every unlisted path (the twin — the gate is an allowlist, so a plugin's new endpoint is refused without being named)", async () => {
    const bearer = "pmcp-not-a-real-credential-FAKE0000";
    // /api/auth/token — jwt()'s side-effect endpoint (§19.2) — is not on the allowlist: 403.
    const token = await call(new Request(`${ORIGIN}${AUTH_BASE_PATH}/token`, { headers: { authorization: `Bearer ${bearer}` } }));
    expect(token.status).toBe(403);
    // The twin: the allowlisted /sign-out and /device/code admit a bearer past the gate.
    const signOut = await call(new Request(`${ORIGIN}${AUTH_BASE_PATH}/sign-out`, { method: "POST", headers: { authorization: `Bearer ${bearer}` } }));
    expect(signOut.status).not.toBe(403);
    const deviceCode = await call(
      new Request(`${ORIGIN}${AUTH_BASE_PATH}/device/code`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ client_id: "pmcp-cli" }),
      }),
    );
    expect(deviceCode.status).not.toBe(403);
  });

  it("§19.7 · the OAuth flow needs no allowlist entry — a full round-trip completes with no Authorization header on any /api/auth request, because every supported client is public (§19.3)", async () => {
    const withAuthorization: string[] = [];
    const guarded = (request: Request): Promise<Response> => {
      if (new URL(request.url).pathname.startsWith(AUTH_BASE_PATH) && request.headers.get("Authorization") !== null) {
        withAuthorization.push(request.url);
      }
      return call(request);
    };
    const client = await driveOAuth({ cookie: door.session.cookie, resource: oauthResourceFor(door.user), send: guarded });
    await bindClient(door.ownerId, client.clientId, door.agentId);
    // The whole round-trip carried no Authorization header to any /api/auth request…
    expect(withAuthorization).toEqual([]);
    // …and the token it produced reaches the door as a service account.
    expect((await mcpCall(`${ORIGIN}/${door.user}/mcp`, client.token, "tools/list")).status).toBe(200);
  });
});
