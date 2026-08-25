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

import { describe, it } from "vitest";
import type { Principal, TokenKind } from "../../src/identity";

/**
 * Which surface the row aims at. The four are one table because they share ONE resolution
 * rule (§7 step 1, mirrored by §8's whoami and guarded further by §4's session scopes) —
 * splitting them would let the mirrors drift from the original, which is exactly the bug
 * class this file exists for.
 *
 * `namespace` is relative to the seeded fixture, never a literal username: "self" is the
 * credential's own namespace, "foreign" another live owner's, "absent" a username no row
 * has ever had. `slug` on the scoped route distinguishes the three ways a service can be
 * invisible — granted, ungranted, nonexistent — because §7 pins them to ONE answer.
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
  | { verdict: "allow"; principal: Principal["kind"] }
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
export const AUTH_MATRIX_ROWS: readonly AuthMatrixRow[] = [];

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
 * equal-status — 401-on-an-existing-user against 401-on-an-absent-one, and 404-foreign
 * against 404-route-not-found. Anti-enumeration is a sameness property; asserting each
 * side alone would miss the leak entirely.
 */
export function runAuthMatrix(rows: readonly AuthMatrixRow[]): void {
  // deps: harness/seed · ../../src/index (default.fetch) · env.DB · env.BOOTSTRAP_SECRET
  throw new Error("unimplemented");
}

describe("§7 step 1 — resolution dispatches on prefix", () => {
  it.todo("§7 step 1 · a live `pmcp_sa_` key resolves to its service account (the anchor allow-twin)");
  it.todo("§7 step 1 · a revoked `pmcp_sa_` key is refused 401 + WWW-Authenticate");
  it.todo("§7 step 1 · an expired `pmcp_sa_` key is refused identically to a revoked one — issued at a backdated now() and resolved past its expiry, never slept for");
  it.todo("§7 step 1 · a `pmcp_sa_` key whose account row is gone is refused identically again");
  it.todo("§7 step 1 · a live `pmcp_svc_` key is refused and never falls through to session lookup");
  it.todo("§7 step 1 · a better-auth session token as Bearer resolves to the owner (the user allow-twin)");
  it.todo("§7 step 1 · a bearer matching no prefix and no session is refused");
  it.todo("§7 step 1 · no Authorization header at all is refused with the same 401");
});

describe("§7 step 1 — namespaces never leak existence", () => {
  it.todo("§7 step 1 · a resolved account on its own namespace is admitted");
  it.todo("§7 step 1 · a resolved account on a foreign namespace gets 404, not 403");
  it.todo("§7 step 1 · a resolved owner on a foreign namespace gets the same 404");
  it.todo("§7 step 1 · any resolved principal on a nonexistent username gets 404 — byte-identical to route-not-found");
  it.todo("§7 step 1 · an unauthenticated request gets the same 401 whether `<user>` exists or not");
  it.todo("§7 step 2 · a service account on a scoped slug it holds no grants on gets 404 — identical to a nonexistent slug");
});

describe("§7 step 1 — carrier and transport hygiene", () => {
  it.todo("§7 step 1 · a valid session cookie with no Authorization header is refused on /mcp — cookies are never consulted");
  it.todo("§7 step 1 · a valid key in the query string is refused; the same key as a bearer is admitted (its twin)");
  it.todo("§7 step 1 · a non-JSON Content-Type is refused; `application/json` is admitted");
  it.todo("§7 step 1 · an absent Origin is admitted — every legitimate consumer sends none");
  it.todo("§7 step 1 · an Origin equal to the hub's origin is admitted");
  it.todo("§7 step 1 · a foreign Origin is refused 403 — the one 403 on this surface");
});

describe("§8 — /api/whoami mirrors step 1 exactly", () => {
  it.todo("§8 · a `pmcp_sa_` key resolves to the service-account principal in the owner's namespace");
  it.todo("§8 · a session resolves to the user principal");
  it.todo("§8 · a `pmcp_svc_` key is refused 401, never a session lookup");
  it.todo("§8 · no credential is refused 401 + WWW-Authenticate");
});

describe("§4/§13 — session-scope guards on /account", () => {
  it.todo("§4 · a password session with recent auth reaches /account (the twin)");
  it.todo("§4 · a device-flow (bearer-sourced) session replayed as a cookie is sent to /login instead");
  it.todo("§13 · a password session without recent auth is forced through a fresh sign-in");
});

describe("§12 — the bootstrap route exists only while its secret does", () => {
  it.todo("§12 · with BOOTSTRAP_SECRET unset, every request 404s — indistinguishable from an unknown path");
  it.todo("§12 · with the secret set, the correct secret is admitted (the twin)");
  it.todo("§12 · with the secret set, a wrong secret is refused");
});

describe("the table's own invariants", () => {
  it.todo("§9 rule 2 · every refusal row names an allow-twin present in this table");
  it.todo("§7 step 1 · rows pinned as indistinguishable answer byte-identically, not merely with equal status");
});
