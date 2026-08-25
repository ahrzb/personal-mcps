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

import { describe, it, expect } from "vitest";
import { buildToolFilter, type AccessMode, type GrantEntry, type RoleDeclaration } from "../../src/registry";

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
export const filterScenarios: readonly FilterScenario[] = [
  // §7 step 2: "the built-in `all` role contributes `.*` without ever appearing in
  // `roles_json`" — `delete_everything` is declared by no role, and is allowed anyway, which is
  // what "the declaration is never consulted" means operationally.
  {
    name: "owner-all",
    grants: [{ role: "all", mode: "allow" }],
    declared: { reader: ["get_news"] },
    roleNames: ["all"],
    verdicts: [
      { tool: "get_news", mode: "allow" },
      { tool: "delete_everything", mode: "allow" },
    ],
    note: "owner grant · `all` allows every tool and the declaration is never consulted",
  },
  // §2: `all` is "a reserved role name — never declarable, only grantable"; §6 keeps it out of
  // every declaration, so an empty one is its normal companion, not an edge case.
  {
    name: "all-empty-declaration",
    grants: [{ role: "all", mode: "allow" }],
    declared: {},
    roleNames: ["all"],
    verdicts: [
      { tool: "get_news", mode: "allow" },
      { tool: "set_config", mode: "allow" },
    ],
    note: "§2 · `all` granted against an empty declaration still allows — reserved, yet grantable",
  },
  // §7 step 2: "A granted role no longer present in `roles_json` resolves to the empty pattern
  // set — it still counts as a grant (the account gets an empty `tools/list` and `-32001`, not a
  // 404)." All-deny, so it names the scenario that reaches the same tools with a grant that
  // resolves (§9 rule 2).
  {
    name: "granted-but-undeclared",
    grants: [{ role: "reader", mode: "allow" }],
    declared: { writer: ["set_config"] },
    roleNames: ["reader"],
    verdicts: [
      { tool: "get_news", mode: "deny" },
      { tool: "set_config", mode: "deny" },
    ],
    allowTwin: "declared-reader",
    note: "granted-but-undeclared role · present in roleNames, matches nothing",
  },
  // The twin: one dimension changed — the declaration now carries `reader`. `set_config` stays
  // denied, so the grant, not the declaration alone, is what opens a tool.
  {
    name: "declared-reader",
    grants: [{ role: "reader", mode: "allow" }],
    declared: { reader: ["get_news", "search_.*"], writer: ["set_config"] },
    roleNames: ["reader"],
    verdicts: [
      { tool: "get_news", mode: "allow" },
      { tool: "search_docs", mode: "allow" },
      { tool: "set_config", mode: "deny" },
    ],
    note: "the same role once declared · matches its patterns, denies the rest",
  },
  // §7 step 2: "On the scoped endpoint a service account gets 404 both for a nonexistent slug
  // and for a service it holds no grants on — indistinguishable, so zero-grant accounts can't
  // enumerate the namespace." The empty roleNames IS that signal; the one-grant scenario below
  // is the contrast that makes it a signal rather than a coincidence.
  {
    name: "zero-grants",
    grants: [],
    declared: { reader: ["get_news"] },
    roleNames: [],
    verdicts: [{ tool: "get_news", mode: "deny" }],
    allowTwin: "declared-reader",
    note: "zero grants · roleNames is empty — the gateway's scoped-404 signal",
  },
  // Same empty tool set as `zero-grants`, different roleNames: a grant on a role declared with no
  // patterns is a normal state (-32001), not a 404.
  {
    name: "one-grant-no-match",
    grants: [{ role: "reader", mode: "allow" }],
    declared: { reader: [] },
    roleNames: ["reader"],
    verdicts: [{ tool: "get_news", mode: "deny" }],
    allowTwin: "declared-reader",
    note: "one grant on the service · roleNames is non-empty even when no tool matches",
  },
  // §2: "A tool matched by both an allow-mode and an approval-mode role is allowed outright
  // (allow wins; approval is the weaker form of allow)." The approval-mode role is listed FIRST
  // so a first-match-wins implementation goes red here, before the permutation law runs.
  {
    name: "mixed-modes",
    grants: [
      { role: "reader", mode: "approval" },
      { role: "editor", mode: "allow" },
    ],
    declared: { reader: ["get_news", "search_.*"], editor: ["get_news", "set_config"] },
    roleNames: ["reader", "editor"],
    verdicts: [
      { tool: "get_news", mode: "allow" },
      { tool: "search_docs", mode: "approval" },
      { tool: "set_config", mode: "allow" },
      { tool: "delete_everything", mode: "deny" },
    ],
    note: "allow-mode and approval-mode roles both matching a tool · allow wins; approval-only → approval; no match → deny",
  },
  // §2: "A service account may call exactly the tools matched by the UNION of its granted roles
  // per service."
  {
    name: "union-across-roles",
    grants: [
      { role: "reader", mode: "allow" },
      { role: "writer", mode: "allow" },
    ],
    declared: { reader: ["get_news"], writer: ["set_config"] },
    roleNames: ["reader", "writer"],
    verdicts: [
      { tool: "get_news", mode: "allow" },
      { tool: "set_config", mode: "allow" },
      { tool: "delete_everything", mode: "deny" },
    ],
    note: "union across roles · a tool matched by either granted role is reachable",
  },
  // §7 step 2 + registry.matchesPattern: "a pattern that fails to compile matches nothing" and
  // never throws — so a broken declaration costs its own role and nothing else. The sibling
  // role's allow is the proof the resolve did not abort.
  {
    name: "uncompilable-declared",
    grants: [
      { role: "broken", mode: "allow" },
      { role: "reader", mode: "allow" },
    ],
    declared: { broken: ["get_(.*"], reader: ["get_news"] },
    roleNames: ["broken", "reader"],
    verdicts: [
      { tool: "get_news", mode: "allow" },
      { tool: "get_(.*", mode: "deny" },
      { tool: "get_anything", mode: "deny" },
    ],
    note: "a declaration holding an uncompilable pattern · its role matches nothing, the sibling role still resolves",
  },
];

/**
 * The scenario runner: builds one filter per scenario and asserts its `roleNames` plus
 * one case per verdict, titled `§7 step 2 · <scenario> · <tool> → <mode>` so a failure
 * names the sentence to re-read (§8). Enforces the table's honesty invariant first — a
 * scenario that is all-deny and names no `allowTwin` fails as a malformed oracle.
 * Also runs, per scenario, the two laws that must hold for every pair rather than for
 * chosen tools: filterList keeps exactly the non-denied tools, and the verdict is
 * invariant under permutation of the grant entries.
 */
/** Every ordering of a short array — used to check that a verdict never depends on grant order. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([items[i], ...tail]);
  }
  return out;
}

export function runFilterScenarioTable(rows: readonly FilterScenario[]): void {
  // deps: vitest describe/it/expect · registry.buildToolFilter
  const scenario = (name: string): FilterScenario => {
    const found = rows.find((r) => r.name === name);
    if (!found) throw new Error(`missing scenario "${name}"`);
    return found;
  };

  // Builds the filter and asserts each verdict with a message naming the exact
  // sentence to re-read on failure (§8), so a table row's diagnosis never needs
  // the test title alone.
  const assertVerdicts = (row: FilterScenario, verdicts: { tool: string; mode: AccessMode }[]) => {
    const filter = buildToolFilter(row.grants, row.declared);
    for (const v of verdicts) {
      expect(filter.check(v.tool), `§7 step 2 · ${row.name} · ${v.tool} → ${v.mode}`).toBe(v.mode);
    }
    return filter;
  };

  it("§9 rule 2 · the table itself · every all-deny scenario names its allow-twin", () => {
    for (const row of rows) {
      const allDeny = row.verdicts.every((v) => v.mode === "deny");
      if (allDeny) {
        expect(row.allowTwin, `scenario "${row.name}" is all-deny and must name an allowTwin`).toBeTruthy();
        expect(rows.some((r) => r.name === row.allowTwin)).toBe(true);
      }
    }
  });

  it("§7 step 2 · owner grant · `all` allows every tool and the declaration is never consulted", () => {
    const row = scenario("owner-all");
    const filter = assertVerdicts(row, row.verdicts);
    expect(filter.roleNames).toEqual(row.roleNames);
  });

  it("§2 · `all` granted against an empty declaration still allows — reserved, yet grantable", () => {
    const row = scenario("all-empty-declaration");
    const filter = assertVerdicts(row, row.verdicts);
    expect(filter.roleNames).toEqual(row.roleNames);
  });

  it("§7 step 2 · granted-but-undeclared role · present in roleNames, matches nothing (twin: the declared scenario below)", () => {
    const row = scenario("granted-but-undeclared");
    const filter = assertVerdicts(row, row.verdicts);
    expect(filter.roleNames).toEqual(row.roleNames);
  });

  it("§7 step 2 · the same role once declared · matches its patterns, denies the rest", () => {
    const row = scenario("declared-reader");
    const filter = assertVerdicts(row, row.verdicts);
    expect(filter.roleNames).toEqual(row.roleNames);
  });

  it("§7 step 2 · zero grants · roleNames is empty — the gateway's scoped-404 signal (twin: the one-grant scenario below)", () => {
    const row = scenario("zero-grants");
    const filter = assertVerdicts(row, row.verdicts);
    expect(filter.roleNames).toEqual(row.roleNames);
  });

  it("§7 step 2 · one grant on the service · roleNames is non-empty even when no tool matches", () => {
    const row = scenario("one-grant-no-match");
    const filter = assertVerdicts(row, row.verdicts);
    expect(filter.roleNames).toEqual(row.roleNames);
  });

  // mixed-modes carries two titles: the allow-wins tools here, the approval-only
  // and no-match tools in the next case — both drawn from the same scenario row.
  it("§7 step 2 · allow-mode and approval-mode roles both matching a tool · allow wins", () => {
    const row = scenario("mixed-modes");
    const filter = assertVerdicts(
      row,
      row.verdicts.filter((v) => v.tool === "get_news" || v.tool === "set_config"),
    );
    expect(filter.roleNames).toEqual(row.roleNames);
  });

  it("§7 step 2 · approval-only match → approval; no match → deny", () => {
    const row = scenario("mixed-modes");
    assertVerdicts(
      row,
      row.verdicts.filter((v) => v.tool === "search_docs" || v.tool === "delete_everything"),
    );
  });

  it("§7 step 2 · union across roles · a tool matched by either granted role is reachable", () => {
    const row = scenario("union-across-roles");
    const filter = assertVerdicts(row, row.verdicts);
    expect(filter.roleNames).toEqual(row.roleNames);
  });

  it("§7 step 2 · a declaration holding an uncompilable pattern · its role matches nothing, the sibling role still resolves", () => {
    const row = scenario("uncompilable-declared");
    const filter = assertVerdicts(row, row.verdicts);
    expect(filter.roleNames).toEqual(row.roleNames);
  });
}

describe("§7 step 2 · buildToolFilter — the scenario table", () => {
  runFilterScenarioTable(filterScenarios);
});

describe("§7 step 2 · buildToolFilter — laws", () => {
  it("§7 step 2 · law · allow beats approval under every permutation of the grant entries (rules out order-dependent precedence)", () => {
    for (const row of filterScenarios) {
      for (const perm of permutations(row.grants)) {
        const filter = buildToolFilter(perm, row.declared);
        for (const v of row.verdicts) {
          expect(
            filter.check(v.tool),
            `${row.name} permuted [${perm.map((g) => `${g.role}:${g.mode}`).join(", ")}] · ${v.tool} → ${v.mode}`,
          ).toBe(v.mode);
        }
      }
    }
  });

  it("§7 step 2 · law · filterList keeps exactly the tools check() does not deny — the two answers can never disagree", () => {
    for (const row of filterScenarios) {
      const filter = buildToolFilter(row.grants, row.declared);
      const tools = row.verdicts.map((v) => ({ name: v.tool }));
      const kept = filter.filterList(tools);
      const expected = tools.filter((t) => filter.check(t.name) !== "deny");
      expect(kept, row.name).toEqual(expected);
    }
  });

  it("§7 step 2 · law · filterList preserves input order and element identity — it filters, it never rebuilds", () => {
    const row = filterScenarios.find((r) => r.name === "union-across-roles")!;
    const filter = buildToolFilter(row.grants, row.declared);
    const a = { name: "get_news", tag: "a" };
    const b = { name: "delete_everything", tag: "b" };
    const c = { name: "set_config", tag: "c" };
    const kept = filter.filterList([a, b, c]);
    expect(kept).toEqual([a, c]);
    expect(kept[0]).toBe(a);
    expect(kept[1]).toBe(c);
  });

  it("§7 step 2 · law · roleNames is the granted names verbatim · `all` stays literal, undeclared names stay present", () => {
    for (const row of filterScenarios) {
      const filter = buildToolFilter(row.grants, row.declared);
      expect(filter.roleNames, row.name).toEqual(row.roleNames);
    }
  });

  it("§7 step 2 · law · check() is total · any string answers with a mode, never throws", () => {
    const probes = ["", "get_news", "weird !! chars", "a".repeat(300), "get_(.*", "\n\t", "all"];
    for (const row of filterScenarios) {
      const filter = buildToolFilter(row.grants, row.declared);
      for (const tool of probes) {
        let result: AccessMode | undefined;
        expect(() => {
          result = filter.check(tool);
        }).not.toThrow();
        expect(["allow", "approval", "deny"]).toContain(result);
      }
    }
  });

  it("§7 step 2 · law · buildToolFilter is pure · neither the entries array nor the declaration is mutated", () => {
    for (const row of filterScenarios) {
      const entriesBefore = JSON.parse(JSON.stringify(row.grants));
      const declaredBefore = JSON.parse(JSON.stringify(row.declared));
      buildToolFilter(row.grants, row.declared);
      expect(row.grants, row.name).toEqual(entriesBefore);
      expect(row.declared, row.name).toEqual(declaredBefore);
    }
  });
});
