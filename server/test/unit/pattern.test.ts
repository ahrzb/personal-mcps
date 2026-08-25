// pattern.test.ts — the role-pattern language and its declaration gate, as two tables.
//
// PINS §7 step 2's pattern semantics: compilation as `^(?:p)$` with NO flags (so a
// top-level `|` stays anchored — `foo|bar` matches `foo`/`bar` and never `foox`, the
// naive `'^'+p+'$'` mutation dies here, strategy §9 rule 3); the literal fast path for
// patterns made only of tool-name characters (`get.news` matches the tool `get.news`
// and never `getXnews`); `*` as a `.*` alias so glob `get_*` and regex `get_.*` denote
// the same tool set; and totality — an uncompilable pattern matches nothing and never
// throws, because compilation failures are reported by validateRoles, not by a match.
// PINS §6 `hub/register`'s declaration validation as the one gate both a tunneled
// registration and proxied YAML config pass through: the role-name charset, `all` as
// the reserved built-in (§2 — the resolver's, never declarable), and the caps.
//
// PROJECT: `unit` — plain Node, parallel, milliseconds. Both functions' deps line is
// `none`: no D1, no Durable Object, no workerd binding, nothing to isolate, so the
// Workers pool would buy nothing. No ordering or isolation constraints exist here —
// every case is one pure call and rows share no state.
//
// NOT HERE: how patterns compose across roles into a verdict (unit/filter.test.ts —
// buildToolFilter is where `all`, unions and allow-beats-approval live), and what a
// rejected declaration does on the wire — the JSON-RPC error reply and close 4004
// (tunnel/protocol.test.ts). This file only asks whether a pattern matches and whether
// a declaration is well-formed.
//
// FINDING, surfaced by writing this file and RESOLVED 2026-08-25 (strategy §1 — amending
// the spec is a normal OUTPUT of test authoring): the three caps §6 names — pattern
// length, patterns per role, role-name length — had no named home, so this file's runner
// took them as a `RoleCaps` parameter. They are limits.ts exports now, beside the timings
// and the audit body cap: ROLE_PATTERN_MAX_LENGTH, ROLE_PATTERNS_MAX,
// ROLE_NAME_MAX_LENGTH. The parameter is gone — the runner reads the names itself.
// Boundary rows still say "at-cap" / "over-cap" (§7's durable-vs-incidental rule forbids
// a row that names `128`) and now name WHICH constant they sit against, so a cap moving
// is a one-line edit in limits.ts with zero row churn.

// deps: none (no harness — pure seams) · registry.matchesPattern · registry.validateRoles · limits.ROLE_PATTERN_MAX_LENGTH/ROLE_PATTERNS_MAX/ROLE_NAME_MAX_LENGTH · no platform APIs

import { describe, it, expect } from "vitest";
import { matchesPattern, validateRoles, type RoleDeclaration } from "../../src/registry";
import { ROLE_NAME_MAX_LENGTH, ROLE_PATTERN_MAX_LENGTH, ROLE_PATTERNS_MAX } from "../../src/limits";

/**
 * One row of the pattern table: a pattern together with BOTH sides of its verdict.
 * The pairing is structural on purpose — §9 rule 2 says a refusal is only meaningful
 * beside its allow-twin, and a table of one-tool-per-row lets a deny-only oracle
 * (satisfied by a `matchesPattern` that always returns false) hide. Here the twin sits
 * in the same row: `matches` names the tools the pattern MUST match, `rejects` the
 * regressions it must not.
 *
 * `branch` records which arm of §7 step 2's grammar the row exercises, so a missing
 * arm is visible by reading the column rather than by reasoning about each pattern.
 */
export type PatternMatchRow = {
  /** The pattern exactly as a role declaration spells it — never pre-normalized. */
  pattern: string;
  /** The grammar arm under test: literal fast path, compiled `^(?:p)$`, `*`-alias, or a pattern that cannot compile. */
  branch: "literal" | "anchored-regex" | "glob-alias" | "uncompilable";
  /** Unprefixed tool names this pattern must match — the allow-twins. */
  matches: string[];
  /** Unprefixed tool names it must not match — the regressions. */
  rejects: string[];
  /**
   * Required when, and only when, `matches` is empty — the `uncompilable` arm, whose
   * whole content is a refusal. Names the pattern of the row that matches through the
   * same grammar arm once the syntax error is fixed, so no row is deny-only in
   * isolation.
   */
  allowTwin?: string;
  /** The title tail: the spec sentence this row pins, e.g. "top-level | stays anchored". */
  note: string;
};

/**
 * Rows are OWNER-AUTHORED in a separate commit before implementation (strategy §9
 * rule 1) — agents never fill them. The oracle for the pattern language is exactly
 * this list; an agent that could add rows could weaken it while making it pass.
 */
export const patternMatchRows: readonly PatternMatchRow[] = [
  // §7 step 2: "compile as `^(?:<pattern>)$` with no flags (naive `'^'+p+'$'` breaks on
  // top-level `|` — `^foo|bar$` matches `foox` via its `^foo` branch)".
  {
    pattern: "foo|bar",
    branch: "anchored-regex",
    matches: ["foo", "bar"],
    rejects: ["foox"],
    note: "foo|bar matches foo and bar and never foox — the anchor wraps the alternation",
  },
  // §7 step 2: "A pattern consisting only of tool-name characters (`^[A-Za-z0-9._-]+$`) is
  // compared as a literal string, never compiled — so an exact-looking role entry `get.news`
  // matches only the tool `get.news`, not `getXnews`."
  {
    pattern: "get.news",
    branch: "literal",
    matches: ["get.news"],
    rejects: ["getXnews"],
    note: "literal get.news matches get.news and never getXnews — the dot is not a metacharacter",
  },
  // §2 / §18 item 9: "`*` is accepted as an alias for `.*`" — so these two rows carry
  // IDENTICAL matches/rejects on purpose: the equivalence case reads them against each other,
  // and the second independently pins §7 step 2's "with no flags".
  {
    pattern: "get_*",
    branch: "glob-alias",
    matches: ["get_news"],
    rejects: ["getnews", "GET_NEWS"],
    note: "get_* and get_.* accept and reject exactly the same tools",
  },
  {
    pattern: "get_.*",
    branch: "anchored-regex",
    matches: ["get_news"],
    rejects: ["getnews", "GET_NEWS"],
    note: "compilation carries no flags · get_.* does not match GET_NEWS",
  },
  // §2: the built-in `all` "matching all tools, present and future"; §7 step 2 resolves it by
  // contributing `.*`, which `*` aliases.
  {
    pattern: "*",
    branch: "glob-alias",
    matches: ["get_news", "get.news", "GET_NEWS"],
    rejects: [],
    note: "a bare * matches every tool name — the `all` role's pattern",
  },
  // §7 step 2's alias is "an un-escaped `*` NOT already preceded by `.`" (registry.matchesPattern's
  // own sentence). The zero-length tail `search_` is the witness: a second expansion would read
  // `search_..*`, which needs at least one character after the underscore and would refuse it.
  {
    pattern: "search_.*",
    branch: "anchored-regex",
    matches: ["search_docs", "search_"],
    rejects: ["search"],
    note: ".* is not double-expanded — a * already preceded by . stays one wildcard",
  },
  // §7 step 2: the compiled form is `^(?:p)$` — a match is exact-length on both arms, so the
  // literal path is string equality, never a prefix test.
  {
    pattern: "search_",
    branch: "literal",
    matches: ["search_"],
    rejects: ["search_docs"],
    note: "a pattern's match is exact-length · search_ does not match search_docs",
  },
  // §7 step 2 / §6: "a pattern that fails to compile matches nothing (validateRoles is where
  // compilation failures are reported)". Rejecting its own spelling is the second half: a
  // catch-and-fall-back-to-literal implementation would match the tool `get_(.*`.
  // allowTwin is the `get_.*` row above — literally this pattern with the stray `(` removed.
  {
    pattern: "get_(.*",
    branch: "uncompilable",
    matches: [],
    rejects: ["get_news", "get_(.*"],
    allowTwin: "get_.*",
    note: "an uncompilable pattern matches nothing and never throws (allow-twin: the same pattern, fixed)",
  },
];

/**
 * The pattern-table runner: one case per (row, tool) pair, titled with the row's
 * §7-step-2 reference and `note`, so a failure names the spec sentence to re-read
 * (§8). It also enforces the table's own honesty invariant before running anything —
 * a row with no `matches` and no `allowTwin` fails the suite as a malformed oracle,
 * not as a code regression.
 */
export function runPatternMatchTable(rows: readonly PatternMatchRow[]): void {
  // deps: vitest describe/it/expect · registry.matchesPattern
  it("§9 rule 2 · the table itself · every row with no matches names its allow-twin", () => {
    for (const row of rows) {
      if (row.matches.length === 0) {
        expect(row.allowTwin, `row "${row.pattern}" has no matches and must name an allowTwin`).toBeTruthy();
        expect(rows.some((r) => r.pattern === row.allowTwin)).toBe(true);
      }
    }
  });

  for (const row of rows) {
    it(`§7 step 2 · ${row.note}`, () => {
      for (const tool of row.matches) {
        expect(matchesPattern(row.pattern, tool)).toBe(true);
      }
      for (const tool of row.rejects) {
        expect(matchesPattern(row.pattern, tool)).toBe(false);
      }
    });
  }
}

/** The validation rules §6 pins, one name per rule so a row says which one it is about. */
export type ValidationRule =
  | "role-name-charset"
  | "role-name-length"
  | "all-reserved"
  | "pattern-compiles"
  | "pattern-length"
  | "patterns-per-role";

/**
 * One row of the declaration gate. Two shapes, because two kinds of rule exist:
 *
 * - `declaration` — the rule is about a value a row can spell out in full (a role name,
 *   a pattern that will not compile), so the row carries the declaration verbatim.
 * - `boundary` — the rule is a cap, and §7 forbids pinning the number: the row states
 *   only WHERE the input sits relative to the cap, and the runner synthesizes the
 *   declaration from the limits.ts constant its `dimension` names — role-name-length →
 *   ROLE_NAME_MAX_LENGTH, pattern-length → ROLE_PATTERN_MAX_LENGTH, patterns-per-role →
 *   ROLE_PATTERNS_MAX. "30 s → 45 s" churn, in cap form.
 *
 * Every refusal row belongs beside a `valid: true` twin differing in one dimension —
 * the in-charset name next to the out-of-charset one, the at-cap length next to the
 * over-cap one (§9 rule 2).
 */
export type RoleValidationRow =
  | {
      kind: "declaration";
      /** Handed to validateRoles unchanged; `{}` is a legitimate row (no roles declared). */
      decl: RoleDeclaration;
      /** true ⇒ no violations; false ⇒ at least one, naming this rule. */
      valid: boolean;
      rule: ValidationRule;
      note: string;
    }
  | {
      kind: "boundary";
      /** Names the limits.ts cap this row sits against; the runner reads that constant. */
      dimension: "role-name-length" | "pattern-length" | "patterns-per-role";
      at: "at-cap" | "over-cap";
      valid: boolean;
      note: string;
    };

/** OWNER-AUTHORED, separate commit, before implementation (strategy §9 rule 1). */
export const roleValidationRows: readonly RoleValidationRow[] = [
  // §6: the anchor. `reader` is in charset, every pattern compiles, nothing is at a cap — so it
  // doubles as the one-dimension twin for the charset row and the pattern-compiles row below
  // (§9 rule 2), each of which differs from it in exactly one place.
  // The bare `*` is load-bearing: §18 item 9 blesses it as the alias for `.*` and the pattern
  // table gives it meaning, but `new RegExp("^(?:*)$")` THROWS ("Nothing to repeat"), so a gate
  // that compiles the RAW pattern rejects a declaration matchesPattern accepts — the two exports
  // disagreeing in the direction the cross-export law below does not run. `get_*` cannot catch
  // it (`^(?:get_*)$` compiles as "get" plus underscores); only a leading `*` can.
  {
    kind: "declaration",
    decl: { reader: ["get_news", "search_.*", "*"] },
    valid: true,
    rule: "pattern-compiles",
    note: "a well-formed declaration yields no violations — the allow anchor every refusal row is read against",
  },
  // §6: "A `roles` value of `{}` means 'no roles declared' — the service is then reachable only
  // by admin tokens or accounts granted the built-in `all` role." Vacuous on every rule; `rule`
  // names the charset one because zero names is where it bottoms out.
  {
    kind: "declaration",
    decl: {},
    valid: true,
    rule: "role-name-charset",
    note: '{} is valid — "no roles declared" is a declaration, not an omission',
  },
  // §6: "role names must match `[a-z0-9_-]{1,64}`" — one dimension off the anchor above.
  {
    kind: "declaration",
    decl: { Reader: ["get_news", "search_.*"] },
    valid: false,
    rule: "role-name-charset",
    note: "a role name outside [a-z0-9_-] is a violation; its in-charset twin is the anchor row above",
  },
  // §6's `{1,64}` upper bound, as limits.ROLE_NAME_MAX_LENGTH — the runner synthesizes the name.
  {
    kind: "boundary",
    dimension: "role-name-length",
    at: "at-cap",
    valid: true,
    note: "a role name at ROLE_NAME_MAX_LENGTH validates",
  },
  {
    kind: "boundary",
    dimension: "role-name-length",
    at: "over-cap",
    valid: false,
    note: "a role name one character over ROLE_NAME_MAX_LENGTH is a violation",
  },
  // §6: "`all` is rejected — it's the resolver's built-in, §2"; §18 item 10: "it fits the
  // role-name charset, so the rejection is explicit". The twin proves the refusal is the
  // reservation and not a charset artifact.
  {
    kind: "declaration",
    decl: { all: ["get_news"] },
    valid: false,
    rule: "all-reserved",
    note: "the role name `all` is reserved and can never be declared",
  },
  {
    kind: "declaration",
    decl: { all_tools: ["get_news"] },
    valid: true,
    rule: "all-reserved",
    note: "twin: `all_tools` is an ordinary name — only `all` itself is reserved",
  },
  // §6: "every pattern must compile as a regex". One dimension off the anchor: the stray `(`.
  {
    kind: "declaration",
    decl: { reader: ["get_news", "search_(.*"] },
    valid: false,
    rule: "pattern-compiles",
    note: "a pattern that cannot compile is a violation (twin: the anchor row's search_.*, the same pattern fixed)",
  },
  // §6: "pattern length (≤128 chars) and per-role pattern count (≤64) are capped" — as
  // limits.ROLE_PATTERN_MAX_LENGTH and limits.ROLE_PATTERNS_MAX. No row spells either number.
  {
    kind: "boundary",
    dimension: "pattern-length",
    at: "at-cap",
    valid: true,
    note: "a pattern at ROLE_PATTERN_MAX_LENGTH validates",
  },
  {
    kind: "boundary",
    dimension: "pattern-length",
    at: "over-cap",
    valid: false,
    note: "a pattern one character over ROLE_PATTERN_MAX_LENGTH is a violation",
  },
  {
    kind: "boundary",
    dimension: "patterns-per-role",
    at: "at-cap",
    valid: true,
    note: "a role at ROLE_PATTERNS_MAX patterns validates",
  },
  {
    kind: "boundary",
    dimension: "patterns-per-role",
    at: "over-cap",
    valid: false,
    note: "one pattern over ROLE_PATTERNS_MAX is a violation",
  },
];

/**
 * The declaration-gate runner: one case per row, `boundary` rows synthesizing their
 * declaration from the limits.ts constant their `dimension` names — ROLE_NAME_MAX_LENGTH,
 * ROLE_PATTERN_MAX_LENGTH, ROLE_PATTERNS_MAX — so the numbers live in exactly one place
 * and this file names none of them. Asserts only that violations are present or absent,
 * never their prose — error text is incidental (§7); WHICH rule fired is carried by the
 * row, not by string matching.
 */
/**
 * Synthesizes a boundary row's declaration from the limits.ts constant its
 * `dimension` names — the runner reads the cap by name, this file spells no
 * cap number. `over` is 0 at-cap, 1 one-character/one-pattern over.
 */
function boundaryDeclaration(
  dimension: Extract<RoleValidationRow, { kind: "boundary" }>["dimension"],
  at: "at-cap" | "over-cap",
): RoleDeclaration {
  const over = at === "over-cap" ? 1 : 0;
  switch (dimension) {
    case "role-name-length":
      return { [`${"a".repeat(ROLE_NAME_MAX_LENGTH + over)}`]: ["get_news"] };
    case "pattern-length":
      return { reader: [`${"a".repeat(ROLE_PATTERN_MAX_LENGTH + over)}`] };
    case "patterns-per-role":
      return { reader: Array.from({ length: ROLE_PATTERNS_MAX + over }, (_, i) => `p${i}`) };
  }
}

function declarationOf(row: RoleValidationRow): RoleDeclaration {
  return row.kind === "declaration" ? row.decl : boundaryDeclaration(row.dimension, row.at);
}

function assertViolations(decl: RoleDeclaration, valid: boolean): void {
  const violations = validateRoles(decl);
  if (valid) {
    expect(violations).toEqual([]);
  } else {
    expect(violations.length).toBeGreaterThan(0);
  }
}

export function runRoleValidationTable(rows: readonly RoleValidationRow[]): void {
  // deps: vitest describe/it/expect · registry.validateRoles · limits.ROLE_NAME_MAX_LENGTH/ROLE_PATTERN_MAX_LENGTH/ROLE_PATTERNS_MAX
  const declRows = rows.filter((r): r is Extract<RoleValidationRow, { kind: "declaration" }> => r.kind === "declaration");
  const boundaryRows = rows.filter((r): r is Extract<RoleValidationRow, { kind: "boundary" }> => r.kind === "boundary");

  const findDecl = (rule: ValidationRule, valid: boolean) =>
    declRows.find((r) => r.rule === rule && r.valid === valid)!;
  const findBoundary = (
    dimension: Extract<RoleValidationRow, { kind: "boundary" }>["dimension"],
    at: "at-cap" | "over-cap",
  ) => boundaryRows.find((r) => r.dimension === dimension && r.at === at)!;

  const anchor = findDecl("pattern-compiles", true);
  const emptyDecl = declRows.find((r) => r.rule === "role-name-charset" && r.valid && Object.keys(r.decl).length === 0)!;
  const charsetInvalid = findDecl("role-name-charset", false);
  const roleNameAtCap = findBoundary("role-name-length", "at-cap");
  const roleNameOverCap = findBoundary("role-name-length", "over-cap");
  const allInvalid = findDecl("all-reserved", false);
  const allToolsValid = findDecl("all-reserved", true);
  const patternInvalid = findDecl("pattern-compiles", false);
  const patternLenAtCap = findBoundary("pattern-length", "at-cap");
  const patternLenOverCap = findBoundary("pattern-length", "over-cap");
  const patternsPerRoleAtCap = findBoundary("patterns-per-role", "at-cap");
  const patternsPerRoleOverCap = findBoundary("patterns-per-role", "over-cap");

  it("§6 · a well-formed declaration yields no violations — the allow anchor every refusal row is read against", () => {
    assertViolations(anchor.decl, true);
  });

  it('§6 · {} is valid — "no roles declared" is a declaration, not an omission', () => {
    assertViolations(emptyDecl.decl, true);
  });

  it("§6 · a role name outside [a-z0-9_-] is a violation; its in-charset twin is not", () => {
    assertViolations(charsetInvalid.decl, false);
    assertViolations(anchor.decl, true);
  });

  it("§6 · a role name at ROLE_NAME_MAX_LENGTH validates, one character over is a violation", () => {
    assertViolations(declarationOf(roleNameAtCap), true);
    assertViolations(declarationOf(roleNameOverCap), false);
  });

  it("§6 · the role name `all` is reserved and can never be declared (twin: `all_tools` is an ordinary name)", () => {
    assertViolations(allInvalid.decl, false);
    assertViolations(allToolsValid.decl, true);
  });

  it("§6 · a pattern that cannot compile is a violation (twin: the same pattern with the syntax error fixed)", () => {
    assertViolations(patternInvalid.decl, false);
    assertViolations(anchor.decl, true);
  });

  it("§6 · a pattern at ROLE_PATTERN_MAX_LENGTH validates, one character over is a violation", () => {
    assertViolations(declarationOf(patternLenAtCap), true);
    assertViolations(declarationOf(patternLenOverCap), false);
  });

  it("§6 · a role at ROLE_PATTERNS_MAX patterns validates, one pattern over is a violation", () => {
    assertViolations(declarationOf(patternsPerRoleAtCap), true);
    assertViolations(declarationOf(patternsPerRoleOverCap), false);
  });

  it("§6 · every boundary row is synthesized from the limits.ts constant it names — no cap number is spelled in this file", () => {
    for (const row of boundaryRows) {
      const decl = boundaryDeclaration(row.dimension, row.at);
      const over = row.at === "over-cap" ? 1 : 0;
      if (row.dimension === "role-name-length") {
        expect(Object.keys(decl)[0].length).toBe(ROLE_NAME_MAX_LENGTH + over);
      } else if (row.dimension === "pattern-length") {
        expect(decl.reader[0].length).toBe(ROLE_PATTERN_MAX_LENGTH + over);
      } else {
        expect(decl.reader.length).toBe(ROLE_PATTERNS_MAX + over);
      }
    }
  });
}

describe("§7 step 2 · matchesPattern — the pattern language (table)", () => {
  runPatternMatchTable(patternMatchRows);
});

describe("§7 step 2 · matchesPattern — laws", () => {
  const allTools = new Set<string>();
  for (const row of patternMatchRows) {
    for (const tool of row.matches) allTools.add(tool);
    for (const tool of row.rejects) allTools.add(tool);
  }

  it("§7 step 2 · law · matchesPattern is total · every table pattern against every table tool returns a boolean, never throws", () => {
    for (const row of patternMatchRows) {
      for (const tool of allTools) {
        let result: boolean | undefined;
        expect(() => {
          result = matchesPattern(row.pattern, tool);
        }).not.toThrow();
        expect(typeof result).toBe("boolean");
      }
    }
  });

  it("§7 step 2 · law · matchesPattern is pure · repeated calls with the same arguments agree (no compiled-regex lastIndex leak)", () => {
    for (const row of patternMatchRows) {
      for (const tool of allTools) {
        const first = matchesPattern(row.pattern, tool);
        for (let i = 0; i < 5; i++) {
          expect(matchesPattern(row.pattern, tool)).toBe(first);
        }
      }
    }
  });
});

describe("§6 hub/register · validateRoles — the declaration gate (table)", () => {
  runRoleValidationTable(roleValidationRows);
});

describe("§6 + §7 step 2 · the two exports agree", () => {
  it("§6+§7 · law · every pattern validateRoles accepts is usable by matchesPattern without throwing", () => {
    for (const row of roleValidationRows) {
      const decl = declarationOf(row);
      if (validateRoles(decl).length !== 0) continue;
      for (const patterns of Object.values(decl)) {
        for (const pattern of patterns) {
          expect(() => matchesPattern(pattern, "probe_tool")).not.toThrow();
        }
      }
    }
  });

  it("§6 · law · validateRoles is pure · the declaration handed in is not mutated", () => {
    for (const row of roleValidationRows) {
      const decl = declarationOf(row);
      const before = JSON.parse(JSON.stringify(decl));
      validateRoles(decl);
      expect(decl).toEqual(before);
    }
  });
});
