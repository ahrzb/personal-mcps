/**
 * §20.3's pattern language and §7's door, in the browser.
 *
 * A PORT of `server/src/registry.ts`'s `matchesPattern` / `buildToolFilter` /
 * `parseGrantEntry` and `server/src/catalog-view.ts`'s `reachabilityFor`, for
 * `web/src/lib/types.ts`'s reason: the client is outside the Worker's dependency closure,
 * so nothing crosses that line. The rules are therefore rewritten here, and the copy must
 * be EXACT — every number the grant editor prints (a row's implied mode, `matches N`, the
 * reach line, the details card's "Matches today") is read off these answers, and a client
 * that matched patterns differently from the door would tell an owner their agent reaches
 * something it does not. The two must move together; registry's `matchesPattern` comment is
 * the home of the grammar.
 *
 * Pure: no query, no context, no clock.
 */

import { APPROVAL_SUFFIX, BUILTIN_ROLE } from "@/lib/paths";
import type { FamilyPatterns, RoleDeclaration, RoleFamily, AppRow } from "@/lib/types";

/** §20.3's three keyspaces, in the order the listing draws them. */
export const ROLE_FAMILIES: readonly RoleFamily[] = ["tools", "prompts", "resources"];

/** The entry prefix per family — singular, because an entry names one item, not a keyspace. */
const ITEM_PREFIX_OF: Record<RoleFamily, string> = { tools: "tool", prompts: "prompt", resources: "resource" };

/** …read backwards. A prefix outside it is not a family at all (see `parseGrantEntry`). */
const ITEM_FAMILY_OF: Record<string, RoleFamily | undefined> = {
  tool: "tools",
  prompt: "prompts",
  resource: "resources",
};

/**
 * What a stored grant entry names (§8): a declared role, or an inline ITEM
 * `<family>/<pattern>` carrying its own pattern and needing no declaration. The two can
 * never collide — a role name is `[a-z0-9_-]+` and so contains no `/`.
 */
export type GrantEntryKind =
  | { kind: "role"; role: string }
  | { kind: "item"; family: RoleFamily; pattern: string };

/**
 * The entry grammar, read. Total and never throws: an entry whose prefix is not one of the
 * three family words parses as a role NAMED `foo/x`, which resolves to nothing — the same
 * answer the door gives it. The pattern is everything after the FIRST `/`, so
 * `resource/news://feed/*` keeps its whole URI pattern.
 */
export function parseGrantEntry(entry: string): GrantEntryKind {
  const slash = entry.indexOf("/");
  const family = slash < 0 ? undefined : ITEM_FAMILY_OF[entry.slice(0, slash)];
  return family === undefined
    ? { kind: "role", role: entry }
    : { kind: "item", family, pattern: entry.slice(slash + 1) };
}

/** The entry grammar, written: the inverse of `parseGrantEntry`'s item arm. */
export function itemEntry(family: RoleFamily, pattern: string): string {
  return `${ITEM_PREFIX_OF[family]}/${pattern}`;
}

/** One stored entry, split into the two things a row asks of it: what it names, and which
 *  side of the set it sits on. The suffix decides the mode, never the first colon — a
 *  resource URI carries colons of its own. */
export type ParsedEntry = GrantEntryKind & {
  /** The entry WITHOUT its mode suffix — the string every control is keyed on. */
  entry: string;
  mode: "allow" | "approval";
};

export function grantEntryOf(spelled: string): ParsedEntry {
  const approval = spelled.endsWith(APPROVAL_SUFFIX);
  const entry = approval ? spelled.slice(0, -APPROVAL_SUFFIX.length) : spelled;
  return { ...parseGrantEntry(entry), entry, mode: approval ? "approval" : "allow" };
}

/** The stored spelling of a parsed entry — the inverse of `grantEntryOf`. */
export function spelledOf(entry: { entry: string; mode: "allow" | "approval" }): string {
  return entry.mode === "approval" ? `${entry.entry}${APPROVAL_SUFFIX}` : entry.entry;
}

/* ------------------------------ the grammar ------------------------------ */

/** The literal-grammar fast path for tool and prompt names: that charset only. */
const LITERAL_PATTERN = /^[A-Za-z0-9._-]+$/;

/** §20.3's metacharacter set, exactly: `* + ? ( ) [ ] { } | ^ $ \` — `.` is deliberately
 *  not in it, because a URI is full of dots that mean themselves. */
const RESOURCE_METACHARACTERS = /[*+?()[\]{}|^$\\]/;

/**
 * Which arm a pattern takes, and the ONE rule that differs per family. Tool and prompt
 * names live in a closed charset, so the fast path is that charset; a URI does not, so a
 * resource pattern is literal unless it carries a metacharacter — otherwise `.` would match
 * anything and `file:///notes.txt` would cover `file:///notesXtxt`.
 *
 * Exported because the EDITOR asks it too, under its own reading: a literal pattern is one
 * that names exactly one item, which is what sorts an inline entry into its family's rows
 * rather than into `Patterns` and what decides whether typed filter text is offered as a
 * pattern at all. The server spells that reading twice (registry's private
 * `isLiteralPattern` and model's `isOneItem`); here it is one function, so the two readings
 * cannot drift.
 */
export function isLiteralPattern(pattern: string, family: RoleFamily): boolean {
  return family === "resources" ? !RESOURCE_METACHARACTERS.test(pattern) : LITERAL_PATTERN.test(pattern);
}

/** `*` not already escaped or preceded by `.` reads as `.*`, so glob-style `get_*` and
 *  regex-style `get_.*` mean the same thing in every family. */
function aliasStars(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    const prev = pattern[i - 1];
    out += ch === "*" && prev !== "." && prev !== "\\" ? ".*" : ch;
  }
  return out;
}

/** Anchored, flagless, and never throwing: a pattern that fails to compile matches nothing,
 *  which is the door's own answer for one (the WRITE path is where a bad pattern is
 *  refused). */
function compilePattern(pattern: string): RegExp | null {
  try {
    return new RegExp(`^(?:${aliasStars(pattern)})$`);
  } catch {
    return null;
  }
}

/**
 * The one pattern-language decision point: does `pattern` match `subject` read in `family`?
 * The family selects the literal fast path and nothing else — anchoring, the `*` alias and
 * totality are the same in all three.
 */
export function matchesPattern(pattern: string, subject: string, family: RoleFamily): boolean {
  if (isLiteralPattern(pattern, family)) return pattern === subject;
  const re = compilePattern(pattern);
  return re ? re.test(subject) : false;
}

/* -------------------------------- the door -------------------------------- */

/** §20.3's normalization: a bare list IS the tools list. */
function normalizeRole(declared: string[] | FamilyPatterns | undefined): FamilyPatterns {
  if (declared === undefined) return {};
  return Array.isArray(declared) ? { tools: declared } : declared;
}

/**
 * §1's merge for one app row, as the DOOR resolves it: the owner's roles, then the app's
 * declaration on top, per role. Every page-side matcher asks this and none asks `roles`
 * alone — a live owner role that reached the door but rendered as `undeclared · dormant` is
 * the bug that rule exists to prevent.
 *
 * A proxied row's `roles` is already the owner's (§1), so it carries no `ownerRoles` and the
 * spread is a no-op there.
 */
export function effectiveRolesOf(row: Pick<AppRow, "roles" | "ownerRoles">): RoleDeclaration {
  return { ...(row.ownerRoles ?? {}), ...row.roles };
}

/** One agent that reaches a subject, as §13's "Reachable by …" line renders it. */
export type Reach = {
  /** The agent's slug, or — inside one pair's editor, where every "agent" is an entry — the
   *  entry string that matched. `reachabilityFor`'s caller decides which it keys by. */
  agent: string;
  /** The door's verdict: never `deny`, those are dropped. */
  mode: "allow" | "approval";
  /** The granted entries that matched on their own, each named as it is stored — `all`
   *  naming itself and never expanded, an inline item naming itself too, which is what lets
   *  a row say "via reader" or "direct". */
  roles: string[];
};

/** One app's grants, parsed and built into doors once. */
export type Reachability = {
  reach(subject: string, family: RoleFamily): Reach[];
};

/** One door: the union of a holder's entries, checked per (subject, family). */
type Door = { check(subject: string, family: RoleFamily): "allow" | "approval" | "deny" };

/**
 * The pure heart of access resolution, per holder: grant entries exactly as stored plus the
 * app's declaration. A granted `all` contributes `.*` in every family without touching the
 * declaration; a granted role absent from it contributes no patterns; a role's families are
 * independent, so a prompts-only role matches no tool of the same name; and per (subject,
 * family) any allow-mode match beats every approval-mode match, in any order.
 */
function doorOf(entries: ParsedEntry[], declared: RoleDeclaration): Door {
  const byFamily: Record<string, FamilyPatterns> = {};
  for (const [role, patterns] of Object.entries(declared)) byFamily[role] = normalizeRole(patterns);

  function matches(entry: ParsedEntry, subject: string, family: RoleFamily): boolean {
    if (entry.kind === "role") {
      // §20.3: `all` spans every family, present and future.
      if (entry.role === BUILTIN_ROLE) return true;
      const patterns = byFamily[entry.role]?.[family];
      return patterns === undefined ? false : patterns.some((pattern) => matchesPattern(pattern, subject, family));
    }
    // An inline item IS its own one-pattern role, confined to its own family — so `tool/x`
    // can never answer for the prompt `x`.
    return entry.family === family && matchesPattern(entry.pattern, subject, family);
  }

  return {
    check(subject, family) {
      let approved = false;
      for (const entry of entries) {
        if (!matches(entry, subject, family)) continue;
        if (entry.mode === "allow") return "allow";
        approved = true;
      }
      return approved ? "approval" : "deny";
    },
  };
}

/**
 * The door's build-then-check split, kept split. `declared` is the app's effective
 * declaration; `grants` maps a HOLDER — an agent slug on the reachability line, one entry
 * on the grant editor's own rows — to the stored entries it holds.
 *
 * Built once per app rather than per row, because the editor asks `reach` for every subject
 * of every family and building inside that loop would re-normalize the declaration for each
 * one.
 */
export function reachabilityFor(declared: RoleDeclaration, grants: Record<string, string[]>): Reachability {
  const doors = Object.entries(grants).map(([holder, spelled]) => {
    const entries = spelled.map(grantEntryOf);
    return {
      holder,
      door: doorOf(entries, declared),
      // Each entry asked again on its own, as a lone allow, so "via <entry>" can never name
      // one that did not match.
      alone: entries.map((entry) => ({ entry: entry.entry, door: doorOf([{ ...entry, mode: "allow" }], declared) })),
    };
  });
  return {
    reach(subject, family) {
      const reached: Reach[] = [];
      for (const built of doors) {
        const mode = built.door.check(subject, family);
        if (mode === "deny") continue;
        const matched = built.alone.filter((each) => each.door.check(subject, family) !== "deny");
        reached.push({ agent: built.holder, mode, roles: [...new Set(matched.map((each) => each.entry))] });
      }
      return reached;
    },
  };
}

/**
 * §7's configured argument paths for one tool — `registry.redactPathsIn` ported, because the
 * details card prints them and the map's keys are PATTERNS, not tool names.
 */
export function redactPathsIn(config: Record<string, string[]>, tool: string): string[] {
  const paths = new Set<string>();
  for (const [key, declared] of Object.entries(config)) {
    if (!matchesPattern(key, tool, "tools")) continue;
    for (const path of declared) paths.add(path);
  }
  return [...paths];
}
