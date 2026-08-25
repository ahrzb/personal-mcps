// identity-tokens.test.ts — the machine-credential half of identity (§5, §6): minting,
// listing, revoking, deleting, and the one-answer-for-every-failure rule on
// `resolveServiceToken`.
//
// Two properties carry the file. First, plaintext-once: `issueToken` hands the secret
// back exactly once and no surface ever hands it back again — a regression here is
// invisible until a listing leaks a live credential. Second, the upgrade verdict is
// TOTAL and uniform: every way a `pmcp_svc_` bearer can be short of fully valid — absent,
// foreign prefix, unknown, wrong kind column, revoked, expired, referent row gone —
// answers `null` and nothing else, so the 401 the upgrade handler builds on it cannot
// tell an attacker which check failed. That is exactly the shape §9 rule 2 warns about:
// a function that returned null unconditionally would pass a refusals-only table, so the
// valid-credential row sits in the same table as its `defect: "none"` twin.
//
// Boundaries: `resolvePrincipal`'s consumer 401/404 matrix belongs to auth-matrix.test.ts
// (that is where the anti-enumeration rows and their allow-twins live), and severing a
// live socket when a token is revoked is admin's cascade, observed in
// tunnel/lifecycle.test.ts. This file stops at the row and the verdict.
//
// Project: `worker` — real D1, no socket, per-file storage isolation, parallel. Order
// free.
//
// deps: test/harness/seed (namespace, service, account, token rows) · server/src/identity
// (issueToken, listTokens, revokeToken, deleteTokensFor, resolveServiceToken) ·
// server/src/limits (window constants — never literals) · env.DB (real D1)

import { describe, it } from "vitest";
import type { TokenKind } from "../../src/identity";

/**
 * The single defect introduced into an otherwise-valid `pmcp_svc_` upgrade request.
 *
 * One defect per row, and `none` is a real member: the allow-twin rides in the same
 * table rather than in a neighbouring describe, so a table that lost its accepting row
 * fails coverage rather than passing quietly. `wrong_kind_column` is the one that looks
 * redundant and is not — §6 pins that kind is read from the column, never inferred from
 * the prefix, so a `pmcp_svc_`-prefixed secret stored as `service_account` must still
 * refuse.
 */
export type ServiceTokenDefect =
  | "none"
  | "no_authorization_header"
  | "service_account_prefix"
  | "session_token"
  | "query_string_token"
  | "unknown_secret"
  | "wrong_kind_column"
  | "revoked"
  | "expired"
  | "referent_row_deleted";

/**
 * One row of the resolve matrix. `storedKind` is the token row's kind COLUMN — `service`
 * on every row but the wrong-kind one, where it disagrees with the prefix on purpose.
 * `expect` has exactly two members because the function has exactly two answers: a bound
 * service id, or null. Nothing about which check failed is observable, and nothing in
 * the row type invites asserting it.
 */
export type ServiceTokenRow = {
  title: string;
  storedKind: TokenKind;
  defect: ServiceTokenDefect;
  expect: "service_id" | "null";
};

/**
 * Rows are OWNER-AUTHORED in a separate commit before implementation (strategy §9
 * rule 1) — agents never fill them.
 */
export const serviceTokenRows: readonly ServiceTokenRow[] = [];

/**
 * Registers one case per row: the request built from the row resolves to the bound
 * service id, or to null. Two table-wide laws ride along, because they are properties of
 * the SET of rows rather than of any one row: every defect of the union appears exactly
 * once (a defect added to the union without a row fails here), and every `null` answer is
 * indistinguishable from every other — same value, no thrown error carrying a reason.
 */
export function runServiceTokenTable(rows: readonly ServiceTokenRow[]): void {
  // deps: test/harness/seed · server/src/identity (resolveServiceToken)
  throw new Error("unimplemented");
}

describe("§6 · resolveServiceToken: one null for every failure", () => {
  it.todo("one case per serviceTokenRow — title as authored");
  it.todo("§6 · the union is exhausted: every ServiceTokenDefect has a row, and every refusing row answers the identical value");
});

describe("§5 · minting and plaintext-once", () => {
  it.todo("§5 · issueToken returns the plaintext once; listTokens shows the prefix and no surface returns the secret again");
  it.todo("§5 · the issued token authenticates on its own credential surface · twin to the row above: sealed, not lost");
  it.todo("§5 · expiry defaults by kind — a service_account token carries an expiry, a service token carries none (the bot on a home server must not silently die). The window's value is incidental (§7); its presence is not");
  it.todo("§5 · an explicit expiresIn and an explicit 'never' each override the per-kind default, in both directions");
});

describe("§8 · revoke versus delete", () => {
  it.todo("§8 · a revoked token is refused immediately on the next resolve · twin: the same token resolved before the revoke");
  it.todo("§8 · revokeToken is idempotent — revoking a revoked token succeeds and changes nothing");
  it.todo("§8 · revokeToken answers false identically for an unknown id and for another namespace's token — one uniform not-found, so the op layer cannot leak existence");
  it.todo("§6 · a revoked token still appears in listTokens with revokedAt stamped — rotation state is what the listing is for · twin: the live token lists too");
  it.todo("§8 · deleteTokensFor removes the rows from the listing entirely — deletion, not revocation, is what the service_delete cascade does");
  it.todo("§5 · deleteTokensFor is keyed by opaque id: recreating a deleted service's slug resurrects no credential");
  it.todo("§8 · deleteTokensFor over zero matching rows succeeds");
});

describe("§7 · listing and use", () => {
  it.todo("§7 · listTokens spans live, expired and revoked rows in one namespace, and never shows a token whose referent row is gone");
  it.todo("§7 · a successful resolve stamps last_used_at and a refused one stamps nothing — the stamping cadence itself is incidental (§7) and is not asserted");
});
