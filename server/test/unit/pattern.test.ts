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

import { describe, it } from "vitest";
import type { RoleDeclaration } from "../../src/registry";

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
export const patternMatchRows: readonly PatternMatchRow[] = [];

/**
 * The pattern-table runner: one case per (row, tool) pair, titled with the row's
 * §7-step-2 reference and `note`, so a failure names the spec sentence to re-read
 * (§8). It also enforces the table's own honesty invariant before running anything —
 * a row with no `matches` and no `allowTwin` fails the suite as a malformed oracle,
 * not as a code regression.
 */
export function runPatternMatchTable(rows: readonly PatternMatchRow[]): void {
  // deps: vitest describe/it/expect · registry.matchesPattern
  throw new Error("unimplemented");
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
export const roleValidationRows: readonly RoleValidationRow[] = [];

/**
 * The declaration-gate runner: one case per row, `boundary` rows synthesizing their
 * declaration from the limits.ts constant their `dimension` names — ROLE_NAME_MAX_LENGTH,
 * ROLE_PATTERN_MAX_LENGTH, ROLE_PATTERNS_MAX — so the numbers live in exactly one place
 * and this file names none of them. Asserts only that violations are present or absent,
 * never their prose — error text is incidental (§7); WHICH rule fired is carried by the
 * row, not by string matching.
 */
export function runRoleValidationTable(rows: readonly RoleValidationRow[]): void {
  // deps: vitest describe/it/expect · registry.validateRoles · limits.ROLE_NAME_MAX_LENGTH/ROLE_PATTERN_MAX_LENGTH/ROLE_PATTERNS_MAX
  throw new Error("unimplemented");
}

describe("§7 step 2 · matchesPattern — the pattern language (table)", () => {
  it.todo("§9 rule 2 · the table itself · every row with no matches names its allow-twin");
  it.todo("§7 step 2 · foo|bar matches foo and bar and never foox — the anchor wraps the alternation");
  it.todo("§7 step 2 · literal get.news matches get.news and never getXnews — the dot is not a metacharacter");
  it.todo("§7 step 2 · get_* and get_.* accept and reject exactly the same tools");
  it.todo("§7 step 2 · a bare * matches every tool name — the `all` role's pattern");
  it.todo("§7 step 2 · .* is not double-expanded — a * already preceded by . stays one wildcard");
  it.todo("§7 step 2 · compilation carries no flags · get_.* does not match GET_NEWS");
  it.todo("§7 step 2 · a pattern's match is exact-length · search_ does not match search_docs");
  it.todo("§7 step 2 · an uncompilable pattern matches nothing and never throws (allow-twin: the same pattern, fixed)");
});

describe("§7 step 2 · matchesPattern — laws", () => {
  it.todo("§7 step 2 · law · matchesPattern is total · every table pattern against every table tool returns a boolean, never throws");
  it.todo("§7 step 2 · law · matchesPattern is pure · repeated calls with the same arguments agree (no compiled-regex lastIndex leak)");
});

describe("§6 hub/register · validateRoles — the declaration gate (table)", () => {
  it.todo("§6 · a well-formed declaration yields no violations — the allow anchor every refusal row is read against");
  it.todo("§6 · {} is valid — \"no roles declared\" is a declaration, not an omission");
  it.todo("§6 · a role name outside [a-z0-9_-] is a violation; its in-charset twin is not");
  it.todo("§6 · a role name at ROLE_NAME_MAX_LENGTH validates, one character over is a violation");
  it.todo("§6 · the role name `all` is reserved and can never be declared (twin: `all_tools` is an ordinary name)");
  it.todo("§6 · a pattern that cannot compile is a violation (twin: the same pattern with the syntax error fixed)");
  it.todo("§6 · a pattern at ROLE_PATTERN_MAX_LENGTH validates, one character over is a violation");
  it.todo("§6 · a role at ROLE_PATTERNS_MAX patterns validates, one pattern over is a violation");
  it.todo("§6 · every boundary row is synthesized from the limits.ts constant it names — no cap number is spelled in this file");
});

describe("§6 + §7 step 2 · the two exports agree", () => {
  it.todo("§6+§7 · law · every pattern validateRoles accepts is usable by matchesPattern without throwing");
  it.todo("§6 · law · validateRoles is pure · the declaration handed in is not mutated");
});
