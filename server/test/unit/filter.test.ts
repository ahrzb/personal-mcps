// filter.test.ts — grants plus a declaration resolve into a verdict: buildToolFilter.
//
// PINS §7 step 2's resolution rules, the half that decides what a caller may call once
// the pattern language (unit/pattern.test.ts) has decided what a pattern means:
// the built-in `all` contributes `.*` WITHOUT touching the declaration and is reserved
// yet grantable (§2); a granted role no longer present in the declaration still counts
// as a grant — it appears in `roleNames`, matches nothing, and so yields an empty
// tools/list and -32001 rather than a 404; an agent holding no grants at all
// resolves to an EMPTY `roleNames`, which is the gateway's scoped-404 signal and the
// one distinction that keeps a zero-grant agent from enumerating the namespace;
// allow beats approval per tool, whatever order the grant entries arrive in; and
// filterList drops only `deny` — approval-gated tools list like any other, because an
// agent must see a tool to call it.
//
// PROJECT: `unit` — plain Node, parallel, milliseconds. buildToolFilter's deps line is
// `matchesPattern`: a sibling pure function, which the strategy forbids faking (§9,
// "never faked, anywhere") and which needs no faking — it has no I/O. No D1, no DO, no
// binding, nothing to isolate, no ordering constraint between rows.
//
// ALSO PINS §20.3's family dimension (§18 decision 9 as revised) on the same two seams:
// a role holds a pattern list PER FAMILY (tools, prompts, resources), a bare list IS the
// tools list — so every declaration in the field keeps its exact current meaning and
// grants nothing in any other family — the built-in `all` spans every family present and
// future, and the caps and the compile check apply to each family list independently: the
// same two limits.ts constants applied three times, so no new number enters the system.
// buildToolFilter's verdict therefore takes a family alongside the subject, and
// validateRoles reads the per-family shape and refuses an unknown key.
//
// NOT HERE: that the DECLARATION is re-read per request (worker/registry.test.ts —
// resolveAccess against real D1), that `roleNames` reaches an app as `hub/roles`
// with `all` still literal (tunnel/pipeline-tunnel.test.ts), WHICH key of a listed item
// each family is matched against — `uri` for resources, `uriTemplate` for templates,
// `name` for the rest (worker/order.table.test.ts, §20.2) — and the codes the gateway
// turns these verdicts into, in order (worker/order.table.test.ts). This file pins the
// verdict, never its wire consequence.

// deps: none (no harness — pure seam) · registry.buildToolFilter · registry.validateRoles · registry.matchesPattern (real sibling, never faked) · limits.ROLE_PATTERNS_MAX/ROLE_PATTERN_MAX_LENGTH · no platform APIs

import { describe, it, expect } from "vitest";
import {
  buildToolFilter,
  validateRoles,
  type AccessMode,
  type GrantEntry,
  type RoleDeclaration,
  type RoleFamily,
} from "../../src/registry";
import { ROLE_PATTERN_MAX_LENGTH, ROLE_PATTERNS_MAX } from "../../src/limits";

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
  /** The app's declaration as of this resolve; `{}` is a legitimate value. */
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
  // set — it still counts as a grant (the agent gets an empty `tools/list` and `-32001`, not a
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
  // §7 step 2: "On the scoped endpoint an agent gets 404 both for a nonexistent slug
  // and for an app it holds no grants on — indistinguishable, so zero-grant agents can't
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
    note: "one grant on the app · roleNames is non-empty even when no tool matches",
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
  // §2: "An agent may call exactly the tools matched by the UNION of its granted roles
  // per app."
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
      expect(filter.check(v.tool, "tools"), `§7 step 2 · ${row.name} · ${v.tool} → ${v.mode}`).toBe(v.mode);
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

  it("§7 step 2 · one grant on the app · roleNames is non-empty even when no tool matches", () => {
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

/**
 * One §20.3 scenario: the same (grants, declaration) pair as above, with the verdict set
 * now spanning three keyspaces. A verdict names its `family` because that is the argument
 * the filter gained — the SUBJECT alone no longer determines the answer, and a scenario
 * that only ever asked about tools could not tell a per-family filter from the old one.
 *
 * Every scenario carries the subjects it denies beside the ones it allows, in the same
 * row, for the reason the file's first table gives (§9 rule 2).
 */
export type FamilyFilterScenario = {
  /** Stable scenario key, used in the test title and by `allowTwin` references. */
  name: string;
  grants: GrantEntry[];
  /** The declaration in whichever of §20.3's two spellings the scenario is about. */
  declared: RoleDeclaration;
  roleNames: string[];
  /** The per-(subject, family) oracle. Subjects are unprefixed and unrewritten (§20.2). */
  verdicts: { subject: string; family: RoleFamily; mode: AccessMode }[];
  /** Required when every verdict is `deny`; names the scenario reaching the same subjects through a grant that resolves. */
  allowTwin?: string;
  note: string;
};

/** OWNER-AUTHORED, separate commit, before implementation (strategy §9 rule 1). */
export const familyFilterScenarios: readonly FamilyFilterScenario[] = [
  // §20.3: "A bare list is normalized to `{ tools: [...] }` — so every app in the
  // field, every YAML file, and every `serve({roles})` call keeps its exact current
  // meaning, and a role that grants tools grants *nothing* in another family." The two
  // `get_news` deny verdicts are the second half of that sentence, and they are the half a
  // family-blind filter (one that ignores its new argument) fails.
  //
  // The declaration MIXES the two spellings, which the same paragraph blesses ("The two
  // spellings may be mixed across roles in one declaration. Normalization happens once, in
  // the hub"), and both roles are granted so both halves are load-bearing. Normalizing per
  // DECLARATION rather than per role — sniffing `Array.isArray(Object.values(decl)[0])`
  // once, which is what a `Record<string, string[]> | Record<string, PerFamily>` type
  // pushes an implementer toward — reads `briefer` under the bare spelling and loses its
  // prompt: the `digest_daily` allow below is where that goes red.
  {
    name: "bare-list-is-tools",
    grants: [
      { role: "reader", mode: "allow" },
      { role: "briefer", mode: "allow" },
    ],
    declared: { reader: ["get_news"], briefer: { prompts: ["digest_daily"] } },
    roleNames: ["reader", "briefer"],
    verdicts: [
      { subject: "get_news", family: "tools", mode: "allow" },
      { subject: "get_news", family: "prompts", mode: "deny" },
      { subject: "get_news", family: "resources", mode: "deny" },
      { subject: "digest_daily", family: "prompts", mode: "allow" },
      { subject: "digest_daily", family: "tools", mode: "deny" },
    ],
    note: "a bare list is the tools list · it grants nothing in any other family · and the two spellings mix in one declaration",
  },
  // The mirror image: a role declaring ONLY prompts grants no tool, whatever it is
  // called. Same string, three families, one allow — so the family selects the pattern
  // list rather than merely decorating the call.
  {
    name: "prompts-only",
    grants: [{ role: "briefer", mode: "allow" }],
    declared: { briefer: { prompts: ["digest_daily"] } },
    roleNames: ["briefer"],
    verdicts: [
      { subject: "digest_daily", family: "prompts", mode: "allow" },
      { subject: "digest_daily", family: "tools", mode: "deny" },
      { subject: "digest_daily", family: "resources", mode: "deny" },
    ],
    note: "a prompts-only role matches no tool and no resource of the same name",
  },
  // §20.3: "The built-in `all` role spans every family, present and future: it
  // contributes `.*` in each without appearing in any declaration." Every subject here is
  // declared by no role at all, which is what "the declaration is never consulted" means
  // operationally — the same technique the §7 owner-all scenario uses, one family wider.
  {
    name: "all-spans-families",
    grants: [{ role: "all", mode: "allow" }],
    declared: { reader: { tools: ["get_news"] } },
    roleNames: ["all"],
    verdicts: [
      { subject: "delete_everything", family: "tools", mode: "allow" },
      { subject: "digest_weekly", family: "prompts", mode: "allow" },
      { subject: "news://feed/tech", family: "resources", mode: "allow" },
    ],
    note: "`all` contributes .* in every family and is declared nowhere",
  },
  // §20.3: "Owners keep `[\"all\"]`." This is the grant resolveAccess synthesizes for a
  // user principal, against the empty declaration it resolves them with — distinct from
  // the scenario above, whose declaration is non-empty and simply never mentions `all`.
  {
    name: "owner-synthesized-all",
    grants: [{ role: "all", mode: "allow" }],
    declared: {},
    roleNames: ["all"],
    verdicts: [
      { subject: "delete_everything", family: "tools", mode: "allow" },
      { subject: "digest_weekly", family: "prompts", mode: "allow" },
      { subject: "news://feed/tech", family: "resources", mode: "allow" },
    ],
    note: "the owner's synthesized [\"all\"] grant resolves to every family",
  },
  // §7 step 2, now three times over: "A granted role no longer present in `roles_json`
  // resolves to the empty pattern set — it still counts as a grant." All-deny, so it
  // names the scenario that reaches the same subject through a grant that resolves.
  {
    name: "granted-undeclared-families",
    grants: [{ role: "reader", mode: "allow" }],
    declared: {
      briefer: { tools: ["get_news"], prompts: ["digest_daily"], resources: ["news://feed/*"] },
    },
    roleNames: ["reader"],
    verdicts: [
      { subject: "get_news", family: "tools", mode: "deny" },
      { subject: "digest_daily", family: "prompts", mode: "deny" },
      { subject: "news://feed/tech", family: "resources", mode: "deny" },
    ],
    allowTwin: "prompts-only",
    note: "a granted role absent from the declaration contributes nothing in any family, and is still a grant",
  },
  // §2's "allow wins; approval is the weaker form of allow", asked once per family. The
  // approval-mode role is listed FIRST so a first-match-wins implementation goes red, and
  // `digest_weekly` — matched by the approval role only — is the discriminator that keeps
  // the row from being satisfied by a filter that answers `allow` to everything.
  {
    name: "family-allow-beats-approval",
    grants: [
      { role: "reader", mode: "approval" },
      { role: "editor", mode: "allow" },
    ],
    declared: {
      reader: {
        tools: ["get_news"],
        prompts: ["digest_daily", "digest_weekly"],
        resources: ["news://feed/*"],
      },
      editor: { tools: ["get_news"], prompts: ["digest_daily"], resources: ["news://feed/*"] },
    },
    roleNames: ["reader", "editor"],
    verdicts: [
      { subject: "get_news", family: "tools", mode: "allow" },
      { subject: "digest_daily", family: "prompts", mode: "allow" },
      { subject: "news://feed/tech", family: "resources", mode: "allow" },
      { subject: "digest_weekly", family: "prompts", mode: "approval" },
    ],
    note: "allow beats approval inside each family · an approval-only match still resolves to approval",
  },
];

/**
 * The declaration with its structural order reversed — role keys first, then the family
 * keys inside each role. Object key order is the one thing a per-family reader can
 * accidentally depend on, and §20.3's precedence rule is a property of the grants and the
 * patterns, never of the order either was written in.
 */
function reverseDeclarationOrder(decl: RoleDeclaration): RoleDeclaration {
  const reversed: RoleDeclaration = {};
  for (const [role, declared] of Object.entries(decl).reverse()) {
    reversed[role] = Array.isArray(declared)
      ? declared
      : (Object.fromEntries(Object.entries(declared).reverse()) as typeof declared);
  }
  return reversed;
}

/**
 * The §20.3 scenario runner: same shape as the §7 one above — the scenario carries the
 * data, the `it()` carries the locked oracle title verbatim, so a failure names the spec
 * sentence to re-read (§8) rather than a row index.
 */
export function runFamilyFilterScenarioTable(rows: readonly FamilyFilterScenario[]): void {
  // deps: vitest it/expect · registry.buildToolFilter
  const scenario = (name: string): FamilyFilterScenario => {
    const found = rows.find((r) => r.name === name);
    if (!found) throw new Error(`missing scenario "${name}"`);
    return found;
  };

  const assertVerdicts = (row: FamilyFilterScenario, verdicts: FamilyFilterScenario["verdicts"]) => {
    const filter = buildToolFilter(row.grants, row.declared);
    for (const v of verdicts) {
      expect(filter.check(v.subject, v.family), `§20.3 · ${row.name} · ${v.family} · ${v.subject} → ${v.mode}`).toBe(
        v.mode,
      );
    }
    return filter;
  };

  it("§20.3 · a bare pattern list normalizes to {tools: [...]} — the role grants those tools and nothing in any other family", () => {
    const row = scenario("bare-list-is-tools");
    const filter = assertVerdicts(row, row.verdicts);
    expect(filter.roleNames).toEqual(row.roleNames);
  });

  it("§20.3 · a per-family role grants each family independently — a prompts-only role matches no tool of the same name", () => {
    const row = scenario("prompts-only");
    const filter = assertVerdicts(row, row.verdicts);
    expect(filter.roleNames).toEqual(row.roleNames);
  });

  it('§20.3 · the built-in "all" role matches every family without appearing in any declaration', () => {
    const row = scenario("all-spans-families");
    expect(Object.keys(row.declared), "the scenario's declaration must not declare `all`").not.toContain("all");
    const filter = assertVerdicts(row, row.verdicts);
    expect(filter.roleNames).toEqual(row.roleNames);
  });

  it(`§20.3 · an owner's synthesized ["all"] grant resolves to every family`, () => {
    const row = scenario("owner-synthesized-all");
    const filter = assertVerdicts(row, row.verdicts);
    expect(filter.roleNames).toEqual(row.roleNames);
  });

  it("§20.3 · a granted role absent from the declaration contributes no patterns in any family and still appears in roleNames", () => {
    const row = scenario("granted-undeclared-families");
    const filter = assertVerdicts(row, row.verdicts);
    // Non-empty roleNames is the whole difference between "-32001, a normal state" and
    // the gateway's scoped 404 (§7 step 2) — it is why this all-deny row is not a 404.
    expect(filter.roleNames).toEqual(row.roleNames);
  });

  it("§20.3 · allow beats approval per family, in either declaration order", () => {
    const row = scenario("family-allow-beats-approval");
    // "Either order" is asserted in both readings the title admits: the order the grant
    // entries arrive in, and the order the roles and families are written in.
    for (const grants of permutations(row.grants)) {
      for (const declared of [row.declared, reverseDeclarationOrder(row.declared)]) {
        const filter = buildToolFilter(grants, declared);
        for (const v of row.verdicts) {
          expect(
            filter.check(v.subject, v.family),
            `${row.name} · grants [${grants.map((g) => `${g.role}:${g.mode}`).join(", ")}] · declared [${Object.keys(declared).join(", ")}] · ${v.family} · ${v.subject} → ${v.mode}`,
          ).toBe(v.mode);
        }
      }
    }
  });
}

describe("§7 step 2 · buildToolFilter — the scenario table", () => {
  runFilterScenarioTable(filterScenarios);
});

describe("§20.3 · buildToolFilter — one language, three keyspaces (table)", () => {
  runFamilyFilterScenarioTable(familyFilterScenarios);
});

describe("§20.3 · validateRoles — the per-family declaration gate", () => {
  it("§20.3 · validateRoles rejects an unknown family key", () => {
    // The cast is the point: `toolz` cannot be spelled in the TYPE, and a `hub/register`
    // frame can spell anything — validateRoles is the gate between the two.
    const unknownFamily = { reader: { tools: ["get_news"], toolz: ["get_news"] } } as unknown as RoleDeclaration;
    expect(validateRoles(unknownFamily).length, "an unknown family key is a violation").toBeGreaterThan(0);

    // The twin, one dimension off: the same declaration with only known family keys is
    // clean — so the refusal is the unknown KEY, not the per-family spelling itself.
    expect(
      validateRoles({
        reader: { tools: ["get_news"], prompts: ["digest_daily"], resources: ["news://feed/*"] },
      }),
    ).toEqual([]);

    // §20.3: "The two spellings may be mixed across roles in one declaration. Normalization
    // happens once, in the hub (`registry.validateRoles` and the filter builder)" — so the
    // gate reads a mixed declaration per ROLE, not per declaration.
    expect(
      validateRoles({ reader: ["get_news"], briefer: { prompts: ["digest_daily"] } }),
      "the two spellings mix across roles in one declaration",
    ).toEqual([]);

    // The same sentence's first clause — "role names and the reserved `all` are unchanged"
    // — under the NEW spelling, which is the arm where "unchanged" has to be proved rather
    // than assumed. A gate that branches on the spelling and runs the name rules on the
    // bare arm only would let a declared `all` through, and `all` collides with the
    // resolver's built-in, which buildToolFilter short-circuits before ever reading the
    // declaration. The bare-list twins for both rules live in pattern.test.ts.
    expect(
      validateRoles({ all: { tools: ["get_news"] } }).length,
      "`all` is reserved in the per-family spelling too",
    ).toBeGreaterThan(0);
    expect(
      validateRoles({ Reader: { prompts: ["digest_daily"] } }).length,
      "the role-name charset applies in the per-family spelling too",
    ).toBeGreaterThan(0);
  });

  it("§20.3 · ROLE_PATTERNS_MAX applies per family list — 64 tool patterns plus 64 prompt patterns is legal, 65 in one family is not", () => {
    // §20.3: "the same two `limits.ts` constants, applied three times, so no new magic
    // number enters the system" — this file spells neither cap, it reads both by name.
    const atCap = Array.from({ length: ROLE_PATTERNS_MAX }, (_, i) => `p${i}`);
    const overCap = [...atCap, "one_more"];

    expect(
      validateRoles({ reader: { tools: atCap, prompts: atCap } }),
      "the cap is per family list, so two at-cap lists in one role are legal",
    ).toEqual([]);

    const overCapPerFamily: { family: RoleFamily; decl: RoleDeclaration }[] = [
      { family: "tools", decl: { reader: { tools: overCap } } },
      { family: "prompts", decl: { reader: { prompts: overCap } } },
      { family: "resources", decl: { reader: { resources: overCap } } },
    ];
    for (const row of overCapPerFamily) {
      expect(
        validateRoles(row.decl).length,
        `one pattern over ROLE_PATTERNS_MAX in the ${row.family} family is a violation`,
      ).toBeGreaterThan(0);
    }
  });

  it("§20.3 · ROLE_PATTERN_MAX_LENGTH applies to a resource pattern like any other", () => {
    // A URI-shaped pattern synthesized from the constant, never from a spelled length —
    // the guard keeps the fixture honest if the cap ever moves below the scheme itself.
    const scheme = "news://";
    expect(ROLE_PATTERN_MAX_LENGTH).toBeGreaterThan(scheme.length);
    const atCap = scheme + "a".repeat(ROLE_PATTERN_MAX_LENGTH - scheme.length);

    expect(validateRoles({ reader: { resources: [atCap] } }), "a resource pattern at the cap validates").toEqual([]);
    expect(
      validateRoles({ reader: { resources: [`${atCap}a`] } }).length,
      "one character over ROLE_PATTERN_MAX_LENGTH is a violation in the resources family too",
    ).toBeGreaterThan(0);
  });

  it("§20.3 · a non-compiling pattern in any family is a violation, reported by name", () => {
    // The stray "(" is a metacharacter in EVERY family's grammar — outside the tool-name
    // charset for tools and prompts, inside §20.3's metacharacter set for resources — so
    // the same broken pattern reaches compilation on all three paths. Each row's twin is
    // that pattern with the syntax error fixed, in that family's own idiom.
    const broken = "get_(.*";
    const perFamily: { family: RoleFamily; decl: RoleDeclaration; twin: RoleDeclaration }[] = [
      { family: "tools", decl: { reader: { tools: [broken] } }, twin: { reader: { tools: ["get_.*"] } } },
      { family: "prompts", decl: { reader: { prompts: [broken] } }, twin: { reader: { prompts: ["digest_.*"] } } },
      {
        family: "resources",
        decl: { reader: { resources: [broken] } },
        twin: { reader: { resources: ["news://feed/*"] } },
      },
    ];

    for (const row of perFamily) {
      const violations = validateRoles(row.decl);
      expect(violations.length, `${row.family} · "${broken}" does not compile`).toBeGreaterThan(0);
      expect(
        violations.some((violation) => violation.includes(broken)),
        `${row.family} · the violation must name the offending pattern, not just report a count`,
      ).toBe(true);
      expect(validateRoles(row.twin), `${row.family} · twin · the same pattern, fixed`).toEqual([]);
    }
  });
});

describe("§7 step 2 · buildToolFilter — laws", () => {
  it("§7 step 2 · law · allow beats approval under every permutation of the grant entries (rules out order-dependent precedence)", () => {
    for (const row of filterScenarios) {
      for (const perm of permutations(row.grants)) {
        const filter = buildToolFilter(perm, row.declared);
        for (const v of row.verdicts) {
          expect(
            filter.check(v.tool, "tools"),
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
      const kept = filter.filterList(tools, "tools");
      const expected = tools.filter((t) => filter.check(t.name, "tools") !== "deny");
      expect(kept, row.name).toEqual(expected);
    }
  });

  it("§7 step 2 · law · filterList preserves input order and element identity — it filters, it never rebuilds", () => {
    const row = filterScenarios.find((r) => r.name === "union-across-roles")!;
    const filter = buildToolFilter(row.grants, row.declared);
    const a = { name: "get_news", tag: "a" };
    const b = { name: "delete_everything", tag: "b" };
    const c = { name: "set_config", tag: "c" };
    const kept = filter.filterList([a, b, c], "tools");
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
          result = filter.check(tool, "tools");
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
