// order.table.test.ts — §7's check order as the table it already is (~16 rows).
//
// What this suite pins: that the pipeline's four checks run in the ONE pinned order —
// filter (-32001) → archived (-32002) → the approval gate (-32003, availability-first) →
// availability (-32000) — and that the order is observable, because only the order
// decides which code a request that fails several checks receives. The regressions that
// give the table its shape: ungranted + archived answers -32001, never -32002 (an
// ungranted account must not learn a service is archived); an unknown aggregated prefix
// and a name with no `_` at all both answer -32001, indistinguishable from
// not-permitted; the aggregated name splits at the FIRST `_` (slugs contain no
// underscore, §7); `server/discover` is answered by the hub itself; every other method
// is -32601. Plus the 2026-08-25 availability-first decision: a service the hub already
// knows cannot execute fails -32000 with no pending row, no push, and no pass consumed.
//
// Why a table: four green unit tests compose into a wrong order. The order is one spec
// sentence, and a suite that spends sixteen hand-written tests on it amplifies every edit
// to that sentence sixteenfold. Rows are data; the runner is the only assertion logic;
// each row names the STAGE that produced its answer, so the §9 rule 3 mutation ("swap two
// check-order stages") goes red naming the row whose stage it broke rather than failing
// an anonymous heap of tests.
//
// Project: `worker` — the pipeline driven through `exports.default.fetch` against real
// D1, no sockets. That bounds the table honestly: the tunnel side is reachable here only
// in its OFFLINE state (a DO that has never had a socket), which is exactly what the
// -32000 and availability-first rows need. Rows where a tunneled call must actually reach
// a live service belong to tunnel/pipeline-tunnel.test.ts; the dispatch-reaching
// allow-twins in THIS table ride the `pmcp` builtin (always available, no fake at all)
// and a connected proxied service on the fake upstream. See the `backend` column.
//
// Not pinned here: authentication in front of the pipeline (auth-matrix.test.ts), the
// approval machine's internals — dedup, the CAS claim, MRTR settlement, lazy expiry
// (approvals.test.ts, tunnel/approval-e2e.test.ts) — and the upstream failure classes
// behind a -32000 (upstream-proxy.test.ts). This table pins WHICH answer, and which stage
// produced it; the machinery behind each answer is its own file's.
//
// deps: harness/seed (owner + one account; one tunneled service never connected, one
//   proxied service, plus grants in each mode) · harness/fake-upstream
//   (miniflare.outboundService) · ../../src/index (default.fetch) · ../../src/gateway ·
//   ../../src/registry · ../../src/approvals · applyD1Migrations (setup) · env.DB

import { describe, it } from "vitest";
import type { GrantMode } from "../../src/registry";
import type { UpstreamConnectionStatus } from "../../src/upstream";

/**
 * The stage that produced a row's answer — the column that turns "the order is right"
 * from an inference into an assertion. `dispatch` means every check passed and the call
 * reached a backend; `hub` means the hub answered the method itself (`server/discover`)
 * or refused the method outright (-32601), before any service was resolved.
 */
export type CheckStage = "hub" | "filter" | "archived" | "approval" | "availability" | "dispatch";

/**
 * The caller's access to the service, exactly as §7 step 2 resolves it. `GrantMode` is
 * the registry's own vocabulary (grants store `allow` or `approval`, never `deny`);
 * "ungranted" is the unmatched case and "granted-undeclared" is the distinct, normal
 * state where a granted role has vanished from the declaration — it still counts as a
 * grant (empty tools/list and -32001, never a 404).
 */
export type RowAccess = GrantMode | "ungranted" | "granted-undeclared";

/**
 * Which backend the row's service resolves to, and in what state the hub already KNOWS it
 * to be — the availability-first input (§7). `tunnel` appears here only as `offline`: a
 * live registered socket cannot exist in this project, and the online rows are
 * tunnel/pipeline-tunnel.test.ts's. `proxy` carries upstream's own status vocabulary, so
 * the two modules cannot disagree about what "known unavailable" means. `pmcp` is always
 * available and needs no fixture — the cheapest allow-twin in the file.
 */
export type RowBackend =
  | { kind: "tunnel"; status: "offline" }
  | { kind: "proxy"; status: UpstreamConnectionStatus }
  | { kind: "pmcp" };

/**
 * The answer, as the durable contract states it: a code from §7's pinned five, or `null`
 * for the rows that must succeed. `dataKeys` lists the keys `data` must carry — presence
 * only, never prose (§7 of the strategy: error prose is incidental, `approvalUrl`'s
 * presence is not). Empty on every code but -32003, where it is the whole point.
 */
export type OrderOutcome = {
  code: -32000 | -32001 | -32002 | -32003 | -32601 | null;
  dataKeys: readonly ("approvalId" | "approvalUrl" | "expiresAt")[];
};

/**
 * What the row must leave behind. These columns are why availability-first is testable at
 * all: "-32000 with no pending row, no push, and an existing pass untouched" is four
 * assertions about side effects, and a code-only table would call the wrong behavior
 * green.
 */
export type OrderEffects = {
  /** The backend was actually reached (the fake service/upstream counted an invocation). */
  dispatched: boolean;
  /** A fresh `pending` approval row was inserted (dedup means a retry inserts none). */
  pendingCreated: boolean;
  /** An `approved` row was consumed by the claim (exactly-once's observable half). */
  passConsumed: boolean;
  /** A Web Push was attempted to the owner (the fake push endpoint counted it). */
  pushSent: boolean;
};

/**
 * One row of the check-order table.
 *
 * `toolName` is spelled as the CONSUMER spells it — prefixed on the aggregated endpoint,
 * bare on the scoped one — because the split itself is under test. `pass` is the state of
 * any existing approval row for this exact (account, service, tool, args) binding.
 * `twin` names the allow row this refusal sits beside (§9 rule 2): for most rows it is
 * the same row with one column flipped, which is precisely what makes the order
 * observable rather than merely asserted.
 */
export type OrderRow = {
  /** e.g. "§7 step 3 · ungranted + archived → -32001, not -32002". */
  title: string;
  endpoint: "aggregated" | "scoped";
  /** `other` stands for any method outside the served set — the -32601 rows. */
  method: "tools/call" | "tools/list" | "server/discover" | "other";
  toolName: string;
  principal: "owner" | "account";
  access: RowAccess;
  archived: boolean;
  backend: RowBackend;
  /** Tunneled only: whether the tool is present in the DO's cached catalog (a miss → -32001). */
  inCatalog: boolean;
  pass: "none" | "pending" | "approved" | "rejected" | "expired" | "used";
  stage: CheckStage;
  expect: OrderOutcome;
  effects: OrderEffects;
  twin: string;
};

/**
 * The rows are OWNER-AUTHORED, in a separate commit before implementation (strategy §9
 * rule 1), transcribed from §7 alone. Agents never fill them: this table IS the spec
 * sentence, and an agent filling it from an implementation would freeze whatever order
 * that implementation happens to have.
 */
export const ORDER_ROWS: readonly OrderRow[] = [];

/**
 * The one assertion path for the check order: build the row's request, drive it through
 * `exports.default.fetch`, and check the code, the `data` keys, and all four effect
 * columns. Effects are checked on EVERY row, not only the approval ones — "no pending row
 * was created" is a claim a refusal row makes just as strongly as an approval row makes
 * the opposite.
 *
 * Table-level invariants the runner owns: every refusal row's `twin` resolves to a row in
 * this table whose code is `null` (§9 rule 2); every row's `stage` is consistent with its
 * code, so a row cannot claim an answer the named stage could not produce; and the rows
 * pinned as indistinguishable (-32001 for ungranted, for an unknown prefix, for an
 * unsplittable name, and for a catalog miss) answer identically to each other, since
 * indistinguishability is a sameness property no single row can assert.
 */
export function runOrderTable(rows: readonly OrderRow[]): void {
  // deps: harness/seed · harness/fake-upstream · ../../src/index (default.fetch) · env.DB
  throw new Error("unimplemented");
}

describe("§7 step 3 — the fixed order, filter first", () => {
  it.todo("§7 step 3 · ungranted + archived → -32001, never -32002 (filter runs before archived)");
  it.todo("§7 step 3 · ungranted + known-offline → -32001 (filter runs before availability)");
  it.todo("§7 step 3 · granted-undeclared role → -32001, and an empty tools/list, not a 404");
  it.todo("§7 step 3 · granted-allow + archived → -32002 (archived runs before the approval gate)");
  it.todo("§7 step 3 · granted-approval + archived → -32002 with no pending row (same ordering, gate never entered)");
  it.todo("§7 step 3 · granted-allow + available → dispatch (the anchor allow-twin of the whole table)");
});

describe("§7 — availability-first inside the approval gate (decided 2026-08-25)", () => {
  it.todo("§7 · approval-mode, no pass, known-offline service → -32000: no pending row, no push, nothing read");
  it.todo("§7 · approval-mode, approved pass, known-offline service → -32000 with the pass NOT consumed");
  it.todo("§7 · approval-mode, no pass, available service → -32003 carrying approvalId + approvalUrl + expiresAt");
  it.todo("§7 · approval-mode, approved pass, available service → dispatch, pass consumed exactly once");
  it.todo("§7 step 2 · approval-mode, pending pass, retried → -32003 with the same approvalId and no new row");
  it.todo("§7 step 4 · approval-mode, expired pass → -32003 with a fresh pending row");
  it.todo("§7 step 4 · approval-mode, rejected pass → -32003 with a fresh pending row");
  it.todo("§7 step 2 · approval-mode, tool absent from the tunneled cached catalog → -32001 (decided 2026-08-25), no pending row");
  it.todo("§7 · an owner is never routed into the gate at all — [\"all\"] resolves allow, whatever the grants say");
});

describe("§7 — name splitting and methods", () => {
  it.todo("§7 · an aggregated name with no `_` at all → -32001, indistinguishable from not-permitted");
  it.todo("§7 · an aggregated prefix matching no visible service → the same -32001");
  it.todo("§7 · an aggregated name splits at the FIRST `_` — a tool whose own name contains `_` survives intact");
  it.todo("§7 · the scoped endpoint takes the bare name and binds the same approval row as the prefixed call");
  it.todo("§7 · `server/discover` is answered by the hub on both endpoint shapes, no service resolved");
  it.todo("§7 · any other method → -32601");
});

describe("the table's own invariants", () => {
  it.todo("§9 rule 2 · every refusal row names an allow-twin present in this table");
  it.todo("§9 rule 3 · every row names the stage that produced its answer — swapping two stages fails naming the row");
  it.todo("§7 · the four -32001 sources answer identically to one another; `data` is present only on -32003");
});
