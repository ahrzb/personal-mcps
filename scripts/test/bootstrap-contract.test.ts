/**
 * scripts/test/bootstrap-contract.test.ts — the operator side of §12's bootstrap
 * contract: how `scripts/users.ts` talks to POST /internal/users, and what it
 * tells the operator when the route answers something other than success.
 *
 * Two things are pinned here. First, the STATUS MAPPING as a table: 404 means the
 * route does not exist because BOOTSTRAP_SECRET is unset on the Worker — a
 * configuration fact the operator must be told, never a "not found" — 401 means
 * the secret is wrong, and any other non-2xx fails carrying its status. Second,
 * the COPIED wire shapes (BootstrapRequest / BootstrapResponse) against the
 * bootstrap contract fixture (§4), read-only: this is the client copy of a shape
 * the server owns, and the fixture is what keeps the two copies honest with no
 * shared package.
 *
 * Project: `scripts` + clients (plain Node, parallel). Cases share nothing.
 *
 * The fetch stub, and why it is legitimate exactly here (strategy §3, §9):
 * everything else in this suite reaches a real implementation — never a faked
 * sibling module, never a faked D1 or DO. `bootstrap()` is one HTTP call whose
 * entire behavior is the mapping from a status to an operator-facing outcome, and
 * the route it calls is guarded by an all-namespaces master key that no test may
 * hold. So the stub fakes the STATUS and BODY only; it does real request
 * inspection (method, URL, headers, serialized body) and must not fake the
 * request shape, the header placement of the secret, or the call count.
 *
 * Durable vs incidental (§7): durable are the CLASSIFICATION of each status —
 * disabled vs wrong-secret vs plain failure — that the secret rides the
 * Authorization header and nowhere else, that a password is printed exactly once,
 * and that nothing retries. The message prose is incidental: rows carry a failure
 * class, never a sentence, so rewording the CLI costs no test churn. §7's rule
 * applied literally — "assert code + presence", not the string.
 *
 * Not pinned here, deliberately: everything §12 hides server-side — password
 * generation, the constant-time compare (strategy §11 E1: reviewed, not tested,
 * since timing is not behaviorally observable), the route-absent-while-unset
 * behavior itself, the audit rows, namespace teardown on delete. Those belong to
 * the server suites; this file pins only the messenger.
 */

// deps: a bare fetch stub (status + body only — see header) · scripts/users.ts (bootstrap, main) · contracts/bootstrap.json (read-only; server/test/worker/contracts.test.ts is its only writer, §4)

import { describe, it } from "vitest";
import type { BootstrapRequest, BootstrapResponse } from "../users";

describe("the request · §12", () => {
  it.todo("§12 · the POST targets <origin>/internal/users and carries the secret as `Authorization: Bearer` — never in the body, never in the URL or query string, so it stays out of logs and process listings");
  it.todo("§12 · one op per request: the serialized body is exactly the BootstrapRequest for that invocation, with no extra fields and no password in either direction of a `create`");
  it.todo("§12 · bootstrap never retries on its own — the stub sees exactly one call per invocation, for a 5xx as much as for a 200: `create` is not idempotent and every accepted invocation is audited server-side");
});

describe("the status mapping · §12", () => {
  it.todo("the table below — one case per row, refusals and the 2xx twin in one list");
});

describe("the copied wire shapes · §4", () => {
  it.todo("§4 · each BootstrapRequest variant serializes deep-equal to its request shape in the fixture — the client copy is checked against the oracle, not against itself");
  it.todo("§4 · each fixture response shape parses into the BootstrapResponse variant echoing its `op`, including `list` with an empty `usernames` array");
  it.todo("§12 · `delete` of an absent username is an ordinary success shape — the postcondition is absence, not existence; twin: `delete` of a live username produces the same shape, so the caller cannot use the response to probe which usernames exist");
});

describe("main(), the printing contract · §12", () => {
  it.todo("§12 · `create` and `reset-password` write the generated password to stdout exactly once and the rotate-the-master-key reminder to stderr; the secret itself is never printed on either stream");
  it.todo("§12 · exit 0 on success and 1 on any failure, and a missing BOOTSTRAP_SECRET or PMCP_URL fails before any request is made — the master key is read from the environment, never from a flag");
});

/**
 * One row of §12's status mapping.
 *
 * `req` is a column because the op is part of the contract, not scenery: the
 * no-retry rule matters most for the non-idempotent `create`, and the 2xx rows
 * need an op to shape their body. `failure` is a CLASSIFICATION rather than a
 * message — `null` is the success twin, "route-disabled" is the 404 that must
 * never read as a plain not-found, "wrong-secret" is the 401, and "http" is
 * everything else. `namesStatus` applies to the "http" class alone: the operator
 * has to be able to tell a 500 from a 502, so the status must survive into the
 * failure even though its wording does not.
 */
export type BootstrapStatusRow = {
  /** spec reference printed in the case title, e.g. "§12 · 404 · route disabled, not not-found" */
  spec: string;
  /** the invocation this row answers */
  req: BootstrapRequest;
  /** the status the stub returns */
  status: number;
  /** the body the stub serves — a fixture-shaped BootstrapResponse on 2xx, arbitrary otherwise */
  body: unknown;
  /** null means bootstrap resolves with the parsed response; otherwise the failure class */
  failure: null | "route-disabled" | "wrong-secret" | "http";
  /** "http" rows only: the status must be recoverable from the failure */
  namesStatus?: boolean;
};

/**
 * Rows are OWNER-AUTHORED in a separate commit before implementation (strategy
 * §9 rule 1) — agents never fill them. The oracle is §12 plus the failure mapping
 * spelled in scripts/users.ts's own contract comment, read from the spec and
 * never from an implementation.
 */
export const bootstrapStatusRows: readonly BootstrapStatusRow[] = [];

/**
 * The table runner: one case per row, titled with the row's `spec` so a failure
 * names the sentence to re-read (strategy §8). It stubs fetch to answer the row's
 * status and body, invokes bootstrap() with the row's request, and checks the
 * outcome against `failure` — resolving rows additionally deep-equal their parsed
 * BootstrapResponse. This is all the assertion logic for the mapping, so adding a
 * status is one row.
 */
export function runBootstrapStatusTable(rows: readonly BootstrapStatusRow[]): void {
  // deps: a bare fetch stub · scripts/users.ts (bootstrap)
  throw new Error("unimplemented");
}

/**
 * The fixture side of the shape cases: one canonical example per `op`, read from
 * contracts/bootstrap.json. Declared as a signature so the fixture's own layout
 * (how it keys the four ops, whether requests and responses sit in one document
 * or two) is decided once with the producer suite instead of at each call site.
 * Read-only — nothing in this file writes a fixture.
 */
export function fixtureResponses(): readonly BootstrapResponse[] {
  // deps: node:fs · contracts/bootstrap.json
  throw new Error("unimplemented");
}
