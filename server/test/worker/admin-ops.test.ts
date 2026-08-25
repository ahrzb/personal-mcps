// admin-ops.test.ts — the ops table pinned AS a table (§8, §15).
//
// What this suite pins: the reservation of the `pmcp` slug as a property of the ops
// TABLE rather than of any op — swept over `Object.keys(ops)`, never over a hand-kept
// list, so an op added tomorrow cannot forget the reservation (§8: "one error, every op,
// never per-tool"); the audit discipline of each op (§8: every mutating op writes exactly
// one `admin.<tool>` row, reads write none, and the side events some ops write beside
// their own); the D1-side atomicity of the deleting cascades (§15: both rows gone or
// neither); and parity direction A (§8's parity invariant) — every op renders as a `pmcp`
// tool from its ONE schema, total in both directions, so the MCP front and the web form
// can never drift apart.
//
// Project: `worker` — real D1, every sibling module real, no sockets. The ops are D1
// writes, so they belong where D1 is real. The half of each deleting cascade that closes
// a live socket (4001 before the DO wipe) and the §15 ordering pin ("at the moment 4001
// is seen, D1 already has no rows") need a frame on the wire and are pinned by
// tunnel/lifecycle.test.ts instead; this file pins only the D1 half — that the batch is
// one batch. Per-file storage isolation is automatic and load-bearing here: every cascade
// case begins from the seeded fixture alone, so "row gone" is unambiguous.
//
// Deliberately NOT pinned here: the gateway pipeline these ops ride
// (admin-pipeline.test.ts), the 401/404 matrix in front of them (auth-matrix.test.ts),
// per-op input validation owned by the modules underneath (registry.test.ts for slug and
// grant rules, upstream-credentials.test.ts for the headers-vs-oauth exclusivity), and
// the global sentinel sweep proving no column ever holds token material
// (hygiene.test.ts). This file pins that a ledger row exists and says what it should —
// not the hygiene law over every column.
//
// deps: harness/seed (namespace fixture: owner, one tunneled + one proxied service, one
//   service account, one token per kind) · ../../src/admin (ops, adminBackend) ·
//   ../../src/registry · ../../src/identity · ../../src/audit · applyD1Migrations (setup)
//   · env.DB

import { describe, it } from "vitest";
import type { ops } from "../../src/admin";
import type { AuditEntry } from "../../src/audit";

/**
 * An ops-table key. `keyof typeof ops` is `string` today because `ops` is typed
 * `Record<string, AdminOp>` — the alias is documentation, not a constraint. The real
 * guard against a forgotten op is the runner's totality assertion (rows ≡
 * `Object.keys(ops)`), which no type could give us.
 */
export type OpName = keyof typeof ops;

/**
 * One row of the ops classification table — the columns exist so the sweeps below can
 * drive themselves over the REAL `ops` object instead of over a list someone has to
 * remember to extend.
 *
 * `sample` is what makes the refusal and its allow-twin one row rather than two (§9
 * rule 2): the sweep calls the op once with `sample` unchanged (must succeed) and once
 * with its slug field replaced by the reserved `pmcp` (must be refused by the one
 * uniform error). No row lists a refusal without its twin, because the twin is
 * generated from the same cell.
 */
export type AdminOpRow = {
  /** The ops key. The table is total over `Object.keys(ops)` — see runAdminOpTable. */
  op: OpName;
  /**
   * Which reserved-slug sweep applies: `"service"` ops take a service slug and must
   * refuse `pmcp`; `"account"` ops take an account slug (no reservation, but the column
   * says so explicitly rather than by omission); `"none"` ops take neither.
   */
  slugArg: "service" | "account" | "none";
  /** Decides the audit expectation: exactly one `admin.<op>` row, or none at all (§8). */
  writes: "mutating" | "read";
  /**
   * Audit events this op writes BESIDE its own `admin.<op>` row — the writes that belong
   * to a module underneath (e.g. `upstream.auth_mode_changed` on an auth flip,
   * `upstream.disconnected`, approvals' own lifecycle row). Empty for most ops.
   */
  sideEvents: readonly AuditEntry["event"][];
  /**
   * The row families this op removes in its ONE atomic D1 batch (§15). Empty for
   * non-deleting ops; the sweep asserts all-or-nothing over exactly these tables.
   */
  cascade: readonly ("service" | "service_account" | "grant_" | "token")[];
  /** Parity direction A: whether the op declares an outputSchema (§8 — token_issue alone). */
  declaresOutputSchema: boolean;
  /**
   * The smallest input that SUCCEEDS against the seeded fixture. Both twins come from
   * this one cell (see the type comment). Typed loosely on purpose: at implementation
   * each op's zod schema is the input's only source of truth, and a test-side mirror of
   * that shape would be a second definition of it.
   */
  sample: Record<string, unknown>;
};

/**
 * The rows are OWNER-AUTHORED, in a separate commit before implementation (strategy §9
 * rule 1) — agents write the runner, never the oracle. Empty here is the correct
 * committed state, and `runAdminOpTable`'s totality assertion means an empty table
 * cannot masquerade as a passing sweep.
 */
export const ADMIN_OP_ROWS: readonly AdminOpRow[] = [];

/**
 * The one place assertion logic lives for the ops table: a spec change edits rows, a code
 * regression touches none (§1). Per row it runs the reserved-slug pair (refusal + its
 * generated allow-twin), the audit expectation (exactly one `admin.<op>` row for mutating
 * ops with the declared side events beside it, none for reads), the cascade's
 * all-or-nothing check over `cascade`, and parity direction A for that op.
 *
 * Its own invariant, and the reason a hand-listed table would be worthless here: the row
 * set must equal `Object.keys(ops)` exactly. An op added without a row fails loudly, an
 * op deleted leaves a row pointing at nothing — either way the sweep names the drift
 * instead of silently shrinking.
 */
export function runAdminOpTable(rows: readonly AdminOpRow[]): void {
  // deps: ../../src/admin (ops, adminBackend) · harness/seed · ../../src/audit (query) · env.DB
  throw new Error("unimplemented");
}

describe("§8 — the reserved `pmcp` slug is a property of the table", () => {
  it.todo("§8 · every slug-taking op refuses `pmcp` with the one uniform error, swept over Object.keys(ops)");
  it.todo("§8 · the same op accepts the fixture's real slug — the allow-twin the sweep generates per row");
  it.todo("§8 · the row set equals Object.keys(ops) — a new op fails the sweep instead of skipping it");
  it.todo("§8 · service_get('pmcp') refuses like every other slug-taking op — the builtin surfaces only through service_list");
  it.todo("§8 · grant_set refuses `pmcp` as its service — accounts can never hold admin grants");
});

describe("§8 — audit discipline, one row per mutating op", () => {
  it.todo("§8 · every mutating op writes exactly one `admin.<op>` row, in the namespace it changed");
  it.todo("§8 · every read op writes no `admin.*` row (approval_list's lazy `approval.expired` is approvals' write)");
  it.todo("§8 · an op refused for the reserved slug writes no `admin.<op>` row — no summary of a change that did not happen");
  it.todo("§8 · service_update flipping `auth` writes `upstream.auth_mode_changed` beside its own row");
  it.todo("§8 · service_disconnect writes `upstream.disconnected` beside its own row");
  it.todo("§8 · approval_decide's own row sits beside approvals' `approval.approved` — two writers, one call");
  it.todo("§8 · token_issue's row names kind and referent, never the plaintext key");
});

describe("§15 — deleting cascades are one atomic D1 batch", () => {
  it.todo("§15 · service_delete removes the service row and its token rows together — both gone or neither");
  it.todo("§15 · the namespace's other services, tokens, and grants are untouched by it (the allow-twin)");
  it.todo("§15 · account_delete removes the account row, its grants (FK cascade), and its token rows together");
  it.todo("§15 · a service_delete refused at validation leaves every row in place — no partial batch");
  it.todo("§15 · service_delete on a proxied service stops after the batch: no DO, no tokens");
});

describe("§8 — parity direction A: one schema, three fronts", () => {
  it.todo("§8 · every ops key renders as a `pmcp` Tool whose inputSchema is that op's own schema");
  it.todo("§8 · every tool adminBackend lists names an ops key — totality in the other direction");
  it.todo("§8 · token_issue alone declares an outputSchema, and its key field carries `writeOnly`");
  it.todo("§8 · adminBackend.sensitivePaths answers `{ args: [], results: [...] }` for known ops and null for an unknown name");
});
