// filter.test.ts — grants plus a declaration resolve into a verdict: buildToolFilter.
//
// PINS §7 step 2's resolution rules, the half that decides what a caller may call once
// the pattern language (unit/pattern.test.ts) has decided what a pattern means:
// the built-in `all` contributes `.*` WITHOUT touching the declaration and is reserved
// yet grantable (§2); a granted role no longer present in the declaration still counts
// as a grant — it appears in `roleNames`, matches nothing, and so yields an empty
// tools/list and -32001 rather than a 404; an account holding no grants at all
// resolves to an EMPTY `roleNames`, which is the gateway's scoped-404 signal and the
// one distinction that keeps a zero-grant account from enumerating the namespace;
// allow beats approval per tool, whatever order the grant entries arrive in; and
// filterList drops only `deny` — approval-gated tools list like any other, because an
// agent must see a tool to call it.
//
// PROJECT: `unit` — plain Node, parallel, milliseconds. buildToolFilter's deps line is
// `matchesPattern`: a sibling pure function, which the strategy forbids faking (§9,
// "never faked, anywhere") and which needs no faking — it has no I/O. No D1, no DO, no
// binding, nothing to isolate, no ordering constraint between rows.
//
// NOT HERE: that the DECLARATION is re-read per request (worker/registry.test.ts —
// resolveAccess against real D1), that `roleNames` reaches a service as `hub/roles`
// with `all` still literal (tunnel/pipeline-tunnel.test.ts), and the codes the gateway
// turns these verdicts into, in order (worker/order.table.test.ts). This file pins the
// verdict, never its wire consequence.

// deps: none (no harness — pure seam) · registry.buildToolFilter · registry.matchesPattern (real sibling, never faked) · no platform APIs

import { describe, it } from "vitest";
import type { AccessMode, GrantEntry, RoleDeclaration } from "../../src/registry";

/**
 * One scenario = one (grants, declaration) pair plus everything that pair determines.
 * Deliberately NOT one row per tool: `roleNames` is a property of the pair, so a
 * per-tool table would repeat it on every row and a one-line spec change about
 * roleNames would edit forty of them — the change amplification strategy §1 exists to
 * prevent. A scenario carries its whole verdict set instead, which also puts every
 * refusal beside its allow-twin inside a single row (§9 rule 2).
 */
export type FilterScenario = {
  /** Stable scenario key, used in the test title and by `allowTwin` references. */
  name: string;
  /** Grants exactly as stored — or the synthesized owner grant [{role: "all", mode: "allow"}]. */
  grants: GrantEntry[];
  /** The service's declaration as of this resolve; `{}` is a legitimate value. */
  declared: RoleDeclaration;
  /** The filter's roleNames: granted names verbatim — never expanded, never filtered by the declaration. */
  roleNames: string[];
  /** The per-tool oracle. Tool names are UNPREFIXED — prefix splitting happens before the filter (§7). */
  verdicts: { tool: string; mode: AccessMode }[];
  /**
   * Required when, and only when, every verdict in this scenario is `deny` — the
   * zero-grant and granted-but-undeclared scenarios, whose entire content is refusal.
   * Names the scenario that reaches the same tools with a grant that resolves, so the
   * table can never be satisfied by a filter that denies everything (§9 rule 2).
   */
  allowTwin?: string;
  note: string;
};

/**
 * Rows are OWNER-AUTHORED in a separate commit before implementation (strategy §9
 * rule 1) — agents never fill them.
 */
export const filterScenarios: readonly FilterScenario[] = [];

/**
 * The scenario runner: builds one filter per scenario and asserts its `roleNames` plus
 * one case per verdict, titled `§7 step 2 · <scenario> · <tool> → <mode>` so a failure
 * names the sentence to re-read (§8). Enforces the table's honesty invariant first — a
 * scenario that is all-deny and names no `allowTwin` fails as a malformed oracle.
 * Also runs, per scenario, the two laws that must hold for every pair rather than for
 * chosen tools: filterList keeps exactly the non-denied tools, and the verdict is
 * invariant under permutation of the grant entries.
 */
export function runFilterScenarioTable(rows: readonly FilterScenario[]): void {
  // deps: vitest describe/it/expect · registry.buildToolFilter
  throw new Error("unimplemented");
}

describe("§7 step 2 · buildToolFilter — the scenario table", () => {
  it.todo("§9 rule 2 · the table itself · every all-deny scenario names its allow-twin");
  it.todo("§7 step 2 · owner grant · `all` allows every tool and the declaration is never consulted");
  it.todo("§2 · `all` granted against an empty declaration still allows — reserved, yet grantable");
  it.todo("§7 step 2 · granted-but-undeclared role · present in roleNames, matches nothing (twin: the declared scenario below)");
  it.todo("§7 step 2 · the same role once declared · matches its patterns, denies the rest");
  it.todo("§7 step 2 · zero grants · roleNames is empty — the gateway's scoped-404 signal (twin: the one-grant scenario below)");
  it.todo("§7 step 2 · one grant on the service · roleNames is non-empty even when no tool matches");
  it.todo("§7 step 2 · allow-mode and approval-mode roles both matching a tool · allow wins");
  it.todo("§7 step 2 · approval-only match → approval; no match → deny");
  it.todo("§7 step 2 · union across roles · a tool matched by either granted role is reachable");
  it.todo("§7 step 2 · a declaration holding an uncompilable pattern · its role matches nothing, the sibling role still resolves");
});

describe("§7 step 2 · buildToolFilter — laws", () => {
  it.todo("§7 step 2 · law · allow beats approval under every permutation of the grant entries (rules out order-dependent precedence)");
  it.todo("§7 step 2 · law · filterList keeps exactly the tools check() does not deny — the two answers can never disagree");
  it.todo("§7 step 2 · law · filterList preserves input order and element identity — it filters, it never rebuilds");
  it.todo("§7 step 2 · law · roleNames is the granted names verbatim · `all` stays literal, undeclared names stay present");
  it.todo("§7 step 2 · law · check() is total · any string answers with a mode, never throws");
  it.todo("§7 step 2 · law · buildToolFilter is pure · neither the entries array nor the declaration is mutated");
});
