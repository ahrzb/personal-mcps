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
// recent auth), and §12's bootstrap route being 404-shaped while BOOTSTRAP_SECRET is
// unset.
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
import { requireOwnerSession, resolvePrincipal } from "../../src/identity";
import type { Principal, TokenKind } from "../../src/identity";
import type { JsonRpcResponse } from "../../src/gateway";
import { PMCP_SLUG, Registry } from "../../src/registry";
import { seedNamespace, seedOwnerSession } from "../harness/seed";
import type { SeededNamespace } from "../harness/seed";

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
 */
export type AuthSurface =
  | { route: "mcp-aggregated"; namespace: "self" | "foreign" | "absent" }
  | {
      route: "mcp-scoped";
      namespace: "self" | "foreign" | "absent";
      slug: "granted" | "ungranted" | "absent" | "pmcp";
    }
  | { route: "whoami" }
  | { route: "account"; recentAuth: boolean }
  | { route: "bootstrap"; secret: "unset" | "correct" | "wrong" };

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
   * `principal` is `"none"` for the one surface that answers without resolving a
   * principal at all: §12's `/internal/users` is guarded by a shared secret, not by
   * `resolvePrincipal`, so naming a `Principal["kind"]` there would assert a resolution
   * that never happens. "Allow" still means what it means everywhere else — the surface
   * admitted the request — which keeps the twin law (a refusal names an ALLOW row) total
   * over the table.
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
    // §7 step 1: "**401** … regardless of whether `<user>` exists". Two rows, one answer.
    expect(await answerTo(TITLES.noHeaderOnSelf)).toEqual(await answerTo(TITLES.noHeaderOnAbsent));

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
  if (row.surface.route.startsWith("mcp")) {
    return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  }
  return undefined;
}

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
});

describe("the table's own invariants", () => {
  runTableInvariants();
});
