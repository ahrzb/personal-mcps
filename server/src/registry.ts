// registry.ts — the hub's domain model: apps, agents, and grants,
// plus the ENTIRE role-pattern language in one place.
//
// OWNS: the D1 rows for `app`, `agent`, and `grant_` (row-level
// primitives only — cascade choreography across tokens, DO sever/wipe, and audit
// belongs to admin), the role-pattern semantics (anchored ^(?:p)$ compilation,
// the PER-FAMILY literal-grammar fast path, `*` as a `.*` alias, the built-in
// `all` role resolved at request time and never stored, union-of-roles with
// allow-beats-approval), role-declaration validation shared by hub/register and
// proxied config, the §20.3 normalization of a declaration into its per-family
// form and back into the canonical read shape, textual drift detection on
// re-declaration, the proxied `capabilities` config (§20.2), the reserved virtual
// slugs `pmcp` and `hub` — and the redaction path grammar: writeOnlyPaths/applyRedaction are
// the system's ONE definition of how sensitive paths are found and applied, in
// BOTH directions (§7): tunnel walks cached input and output schemas with the
// former; approvals and the gateway's audit-body path mask with the latter.
// §23.3's owner execution settings and §23.6's durable TypeScript name
// reservations live here too — one row per owner, and the name ledger whose
// unique indexes arbitrate every alias write.
//
// HIDES: the roles_json / owner_roles_json / redact_json / redact_results_json /
// log_bodies / capabilities_json column formats (the tunnel DO hands wire-shaped
// declarations to upsertDeclaredRoles and never touches the columns), that
// roles_json and owner_roles_json store the NORMALIZED per-family object while every
// read renders §20.3's canonical form, that the two are one map at read time
// (effectiveRoles — the app's declaration replaces the owner's definition of a name),
// how patterns compile and match, and how grant rows
// plus a declaration resolve into a ToolFilter. This module never writes audit
// rows, never maps errors to
// JSON-RPC, and never reads or decrypts upstream credential envelopes — its one
// touch is CLEARING the envelope column when updateApp flips the auth mode,
// a row invariant (mode and envelope kind can never disagree), not a read.

import type {
  AliasDiagnostic,
  AliasFamily,
  AliasLaneInput,
  AliasPlan,
  AliasReservation,
  AliasServiceMembers,
  AliasSource,
  TypescriptAliases,
} from "./hub-types";
import { HUB_SLUG, aliasViolations, planAliasReservations } from "./hub-types";
import type { Principal } from "./identity";
import {
  HUB_DEFAULT_TIMEOUT_MS,
  HUB_HARD_MAX_TIMEOUT_MS,
  HUB_INITIAL_MAX_TIMEOUT_MS,
  HUB_MIN_TIMEOUT_MS,
  ROLE_NAME_MAX_LENGTH,
  ROLE_PATTERN_MAX_LENGTH,
  ROLE_PATTERNS_MAX,
} from "./limits";

/** The request-scoped Cloudflare D1 binding (`D1Database` from `@cloudflare/workers-types`). */
type D1Database = unknown;

/**
 * The two app shapes, in the wire vocabulary pinned by §5's CHECK constraint:
 * `tunnel` dials in over the reverse WebSocket and declares roles at registration;
 * `proxy` is an upstream MCP endpoint the hub forwards to, with owner-defined roles.
 * Immutable after create — conversion would orphan app tokens and DO state, so it is
 * recreate-only.
 */
export type AppKind = "tunnel" | "proxy";

/**
 * The cross-module view of an app row — exactly what the request pipeline
 * needs to route, gate, and address. Richer reads go through AppDetail.
 */
export type App = {
  id: string;        // opaque row id — the DO addressing key; never derived from user/slug, never reused
  ownerId: string;
  slug: string;
  kind: AppKind;
  archived: boolean;
  logBodies: boolean; // §15 — whether tools/call audit rows carry this app's bodies
};

/**
 * A per-tool access verdict. `deny` is only ever a resolver answer — grant rows
 * store `allow` or `approval`, never `deny` (an ungranted tool is simply
 * unmatched).
 */
export type AccessMode = "allow" | "approval" | "deny";

/**
 * §20.3's three keyspaces: one pattern language, read against tool names,
 * prompt names, and resource URIs. The family selects the pattern list AND the
 * literal fast path — nothing else about matching differs.
 */
export const ROLE_FAMILIES = ["tools", "prompts", "resources"] as const;
export type RoleFamily = (typeof ROLE_FAMILIES)[number];

/**
 * What a LISTING is filtered as. Resource templates are matched by their raw
 * `uriTemplate` against the RESOURCE patterns (§20.2) — the one place where the
 * pattern list and the item's key are not named by the same word, which is why
 * this type exists beside RoleFamily instead of being folded into it.
 */
export type ListKind = RoleFamily | "resourceTemplates";

/** A role's patterns per family; every key optional (§20.3's wire shape). */
export type FamilyPatterns = Partial<Record<RoleFamily, string[]>>;

/**
 * A caller's resolved access to one app, produced by resolveAccess and
 * consumed by the gateway. Pure and snapshot-in-time: it holds the union of the
 * principal's granted roles resolved against the declaration as of the resolve
 * call, and does no I/O of its own.
 *
 * Semantics the gateway leans on: check() takes the UNPREFIXED subject — a tool
 * or prompt NAME, a resource URI, a raw uriTemplate — plus the family it is read
 * in, and answers `allow` when any allow-mode role matches (allow beats
 * approval), `approval` when only approval-mode roles match, `deny` otherwise.
 * filterList() drops only `deny` items — approval-gated tools list like any
 * other, since the agent must see them to call them — and reads the KEY its
 * `kind` names: `name` for tools and prompts, `uri` for resources,
 * `uriTemplate` for templates (§20.2: filtering a URI keyspace by a display
 * string is the bug that rule exists to prevent). Both default to `tools`, the
 * only family that existed before §20.3 and the only one a caller may leave
 * unsaid. An empty roleNames on an agent principal means the agent
 * holds no grants at all on this app (the gateway's scoped-404 signal) —
 * distinct from granted-but-undeclared roles, which appear in roleNames but
 * match nothing (empty tools/list and -32001, a normal state). Owners always
 * carry ["all"].
 */
export type ToolFilter = {
  check(subject: string, family?: RoleFamily): AccessMode;
  filterList<T extends ListedItem>(items: T[], kind?: ListKind): T[];
  roleNames: string[];   // granted role names, for hub/roles forwarding
};

/** Any listed item, seen as just the three keys a family may be matched on. */
type ListedItem = Partial<Record<"name" | "uri" | "uriTemplate", string>>;

/**
 * A role declaration in wire shape — role name to patterns, in either of §20.3's
 * two spellings: a bare list (which MEANS `{tools: [...]}`, forever, so every
 * declaration in the field keeps its exact meaning) or the per-family object.
 * `{}` means "no roles declared": the app is reachable only by owners and
 * `all`-granted agents.
 */
export type RoleDeclaration = Record<string, string[] | FamilyPatterns>;

/**
 * What upsertDeclaredRoles found when comparing old and new declarations.
 * A (role, family) pair appears here only when the role holds at least one live
 * grant AND its new pattern set in that family is not a subset of the old one
 * (compared as exact strings — never regex-language containment); `patterns`
 * lists the added or changed strings. One entry per (role, FAMILY), because
 * §20.3 makes an unchanged tools set no longer enough to call a role unchanged:
 * a role that gains `resources: ["file:///*"]` has just handed every grantee a
 * keyspace. `family` is ABSENT on a tools widening, by the convention the roles
 * wire itself uses — a declaration that names no family is the tools one — so a
 * row that names a family is a row about a NEW keyspace, and every
 * `connect.roles_widened` written before §20.3 still reads as exactly what it
 * was. Comparison runs on the NORMALIZED declarations, so restating a bare list
 * as `{tools: [...]}` is not drift. Empty `widened` means none. The caller turns
 * a non-empty report into the `connect.roles_widened` audit row — this module
 * never audits.
 */
export type DriftReport = {
  widened: { role: string; family?: RoleFamily; patterns: string[] }[];
};

/** The grant modes an owner can actually store — `deny` is never a grant. */
export type GrantMode = "allow" | "approval";

/** One granted role on one app, exactly as stored: name plus mode. */
export type GrantEntry = { role: string; mode: GrantMode };

/**
 * An agent's grants on one app, the shape `agent_list` returns inline.
 */
export type AppGrants = {
  appId: string;
  appSlug: string;
  entries: GrantEntry[];
};

/**
 * The full owner-facing read of an app row. Timestamps are epoch milliseconds.
 * The upstream credential envelope is deliberately absent: credentials never surface
 * through any registry read.
 */
export type AppDetail = App & {
  name: string;
  description: string;
  upstreamUrl: string | null;              // proxied only, null on tunneled
  upstreamAuthMode: "headers" | "oauth" | null;  // proxied only; configuration, not credentials
  forwardIdentity: boolean;                // proxied only; X-Pmcp-* headers upstream
  declaredRoles: RoleDeclaration;          // §20.3's canonical form, never the stored one
  /**
   * The roles the OWNER defined on a tunneled app (§20.3, 2026-09-17) — the same canonical
   * read shape `declaredRoles` carries, and `{}` on a proxied app, whose roles are already
   * all the owner's and live in `declaredRoles`. Never the map a gate reads on its own:
   * `effectiveRoles` is what the door, the undeclared check and every reachability caller
   * ask, because a name the app declares replaces the owner's definition of it.
   */
  ownerRoles: RoleDeclaration;
  /**
   * §20.2's owner-declared capability list — proxied only, and what that app's
   * SCOPED handshake advertises. `null` is "undeclared", which means `tools` only: the
   * answer every proxied app in the field already gives.
   */
  capabilities: AppCapability[] | null;
  /**
   * §23.6's owner configuration lane for this app's hub-local TypeScript names —
   * `{ service?, tools? }`, `{}` when the owner configured none. CONFIGURATION, never the
   * resolved map: the durable reservations live in their own table and their read shape is
   * `typescriptReservations`, so a front can show "what the owner asked for" and "what the
   * hub committed" as the two separate facts §8 requires. Omission on update leaves this
   * untouched; setting `{}` is a legal explicit value that clears nothing either (there is
   * no release path for a committed name).
   */
  typescriptAliases: TypescriptAliases;
  redact: Record<string, string[]>;        // tool-or-pattern → argument paths (config-declared, §7)
  redactResults: Record<string, string[]>; // same shape, applied to result structuredContent (§7)
  createdAt: number;
  lastConnectedAt: number | null;          // tunneled only, null until first registration
};

/**
 * §20.2's capability vocabulary: what a proxied app's owner may declare its
 * upstream serves. A superset of the role families — `completions` is a method a
 * app answers, never a keyspace grants are written against — which is why
 * this list is its own and not ROLE_FAMILIES.
 */
export const APP_CAPABILITIES = ["tools", "prompts", "resources", "completions"] as const;
export type AppCapability = (typeof APP_CAPABILITIES)[number];

/**
 * Input to createApp. Proxied drafts must carry upstreamUrl and a valid
 * roles declaration; tunneled drafts must not (their roles arrive at
 * registration). `kind` is here and only here — no patch can ever change it.
 */
export type AppDraft = {
  ownerId: string;
  slug: string;
  name: string;
  description?: string;
  kind: AppKind;
  upstreamUrl?: string;
  upstreamAuthMode?: "headers" | "oauth";
  forwardIdentity?: boolean;
  roles?: RoleDeclaration;
  /** §20.3, TUNNELED only — the owner's own roles, `roles`' mirror image by kind. */
  ownerRoles?: RoleDeclaration;
  /** §20.2, proxied only; absent means `tools` only. Validated at the admin boundary. */
  capabilities?: string[];
  /**
   * §23.6's owner alias lane, either kind — `{ service?, tools? }`. Validated here against
   * the identifier grammar and, where the app's identity is already durable, against the
   * owner's reservation namespace; the owner lane REFUSES a collision whole. Absent means
   * "configure nothing", `{}` stores an explicit empty configuration (the two are the same
   * read value: there is nothing an absent key preserves that a create could have set).
   */
  typescriptAliases?: TypescriptAliases;
  redact?: Record<string, string[]>;
  redactResults?: Record<string, string[]>;
  /** absent defaults by kind: tunnel true, proxy false (§15) */
  logBodies?: boolean;
};

/**
 * Input to updateApp. `kind` and `archived` are absent by construction:
 * kind is immutable, and archive/unarchive are their own primitives.
 */
export type AppPatch = Partial<{
  name: string;
  description: string;
  upstreamUrl: string;
  upstreamAuthMode: "headers" | "oauth";
  forwardIdentity: boolean;
  roles: RoleDeclaration;
  /** §20.3, TUNNELED only — refused on a proxied row, whose roles are already the owner's. */
  ownerRoles: RoleDeclaration;
  capabilities: string[];
  /**
   * §23.6's owner alias lane, either kind. Omission preserves established configuration;
   * a supplied value replaces the stored map whole (§23.6's "deliberate alias change is a
   * clean cutover"). A collision with another identity's reservation is refused
   * atomically, in the same batch as the row write.
   */
  typescriptAliases: TypescriptAliases;
  redact: Record<string, string[]>;
  redactResults: Record<string, string[]>;
  logBodies: boolean;
}>;

/** An agent row. Timestamps are epoch milliseconds. */
export type Agent = {
  id: string;
  ownerId: string;
  slug: string;
  name: string;
  description: string;
  createdAt: number;
};

/** Input to createAgent. */
export type AgentDraft = {
  ownerId: string;
  slug: string;
  name: string;
  description?: string;
};

/**
 * Input to updateAgent. `slug` is absent by construction — an agent has no rename op,
 * because a slug rename is a distinct decision (identity, not display) that §22.4 never
 * asked for; only the display fields createAgent also takes are patchable.
 */
export type AgentPatch = Partial<{
  name: string;
  description: string;
}>;

/**
 * The reserved slug of the built-in admin app. No `app` row ever exists
 * for it: createApp rejects it, getApp returns null for it, and every
 * admin op that takes a slug rejects it with one uniform error. Because the
 * builtin has no row id, agents can never accumulate grants on it —
 * the reservation is what makes "agents can't hold pmcp grants" structural
 * rather than checked.
 */
export const PMCP_SLUG = "pmcp";

/**
 * §23.1's second reserved virtual slug, `hub` — the TypeScript execution surface. Same
 * posture as `pmcp` and enforced through the same paths: no `app` row ever exists for it,
 * every app-creation path and every slug-taking op refuses it, and reads answer null.
 * DEFINED in hub-types (the pure module's reserved-name validator must know it without
 * importing this one) and re-exported here so the hub's two virtual slugs have one import
 * site, `registry`, for every consumer.
 *
 * A REAL app row with this slug is a deployment blocker, not something the hub shadows or
 * renames (§23.1): the release preflight queries remote D1 for one and blocks the cutover
 * with owner and app identifiers, because canonical identity is an owner decision.
 */
export { HUB_SLUG } from "./hub-types";

/**
 * The one pattern-language decision point: does `pattern` match `subject` when
 * read in `family`? The family selects the LITERAL FAST PATH and nothing else —
 * anchoring, the `*` alias and totality are the same in all three (§20.3).
 * A literal pattern is compared as a string, never compiled, so `get.news`
 * matches only the tool `get.news` and `file:///notes.txt` only that URI.
 * Anything else compiles as ^(?:pattern)$ with no flags, so top-level `|` stays
 * anchored (`foo|bar` never matches `foox`). An un-escaped `*` not already
 * preceded by `.` reads as `.*`, so glob-style `get_*` and regex-style `get_.*`
 * mean the same thing in every family. Never throws: a pattern that fails to
 * compile matches nothing — which is why every WRITE path reports compilation
 * failures instead (validateRoles for a declaration, assertRedactKeys for a
 * redaction map): a pattern that reaches storage uncompilable would silently
 * match no tool.
 */
export function matchesPattern(pattern: string, subject: string, family: RoleFamily): boolean {
  // deps: none
  if (isLiteralPattern(pattern, family)) return pattern === subject;
  const re = compilePattern(pattern);
  return re ? re.test(subject) : false;
}

/**
 * Which arm the pattern takes, and the ONE rule that differs per family (§18
 * decision 9 as revised). Tool and prompt names live in a closed charset, so the
 * fast path is that charset. A URI does not: `:` and `/` would drop every
 * resource pattern into compilation, where `.` matches anything and
 * `file:///notes.txt` would cover `file:///notesXtxt` — so a resource pattern is
 * literal unless it carries a regex metacharacter.
 *
 * The test reads the PATTERN, never the subject, which is what makes a resource
 * TEMPLATE an ordinary string to match against: `{` and `}` in `news://feed/{id}`
 * are just characters of the subject, while a template-SHAPED pattern carries
 * them and therefore compiles — and still matches exactly its own template,
 * an unquantified brace sequence being a literal in the flagless grammar §7 pins.
 */
function isLiteralPattern(pattern: string, family: RoleFamily): boolean {
  return family === "resources" ? !RESOURCE_METACHARACTERS.test(pattern) : LITERAL_PATTERN.test(pattern);
}

/** The literal-grammar fast path for tool and prompt names: that charset only. */
const LITERAL_PATTERN = /^[A-Za-z0-9._-]+$/;

/** §20.3's metacharacter set, exactly: `* + ? ( ) [ ] { } | ^ $ \` — `.` is deliberately not in it. */
const RESOURCE_METACHARACTERS = /[*+?()[\]{}|^$\\]/;

/** `*` not already escaped or preceded by `.` reads as `.*` (§2/§18 item 9). */
function aliasStars(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    const prev = pattern[i - 1];
    out += ch === "*" && prev !== "." && prev !== "\\" ? ".*" : ch;
  }
  return out;
}

/** Shared by matchesPattern and validateRoles so the two can never disagree on compilability. */
function compilePattern(pattern: string): RegExp | null {
  try {
    return new RegExp(`^(?:${aliasStars(pattern)})$`);
  } catch {
    return null;
  }
}

/**
 * Validates a role declaration against the rules shared by hub/register and
 * proxied config: role names match [a-z0-9_-] within limits.ROLE_NAME_MAX_LENGTH,
 * `all` is reserved (built in, never declarable), a per-family object carries
 * only §20.3's family keys, every pattern compiles under the pattern language,
 * and the size caps hold (limits.ROLE_PATTERN_MAX_LENGTH per pattern,
 * limits.ROLE_PATTERNS_MAX per FAMILY LIST — the same two named constants
 * applied three times, so no new number enters the system). Both spellings are
 * judged by the same rules, per role rather than per declaration, so one
 * declaration may mix them. Returns
 * human-readable violations, empty when valid ({} is valid — no roles
 * declared). Pure; callers decide whether violations become a JSON-RPC reply
 * (the tunnel DO) or an admin configuration error.
 */
export function validateRoles(decl: RoleDeclaration): string[] {
  // deps: none
  const violations: string[] = [];
  for (const [name, declared] of Object.entries(decl)) {
    if (name === "all") {
      violations.push(`role name "all" is reserved`);
      continue;
    }
    if (!ROLE_NAME_CHARSET.test(name) || name.length > ROLE_NAME_MAX_LENGTH) {
      violations.push(`role name "${name}" must match [a-z0-9_-]{1,${ROLE_NAME_MAX_LENGTH}}`);
    }
    // The wire can spell anything, so every family key and every value is judged here
    // rather than trusted from the type (which a `hub/register` frame never satisfies) —
    // starting with the role's own value, since `Object.entries(null)` throws and this
    // gate answers a violation list, never an exception.
    if (!Array.isArray(declared) && !isJsonObject(declared)) {
      violations.push(`role "${name}" must declare a pattern list or a per-family object`);
      continue;
    }
    for (const [family, patterns] of Object.entries(normalizeRole(declared))) {
      if (!(ROLE_FAMILIES as readonly string[]).includes(family)) {
        violations.push(`role "${name}" declares an unknown family "${family}"`);
        continue;
      }
      if (!Array.isArray(patterns)) {
        violations.push(`family "${family}" in role "${name}" is not a pattern list`);
        continue;
      }
      if (patterns.length > ROLE_PATTERNS_MAX) {
        violations.push(`role "${name}" declares more than ${ROLE_PATTERNS_MAX} ${family} patterns`);
      }
      for (const pattern of patterns) {
        if (pattern.length > ROLE_PATTERN_MAX_LENGTH) {
          violations.push(`pattern "${pattern}" in role "${name}" exceeds ${ROLE_PATTERN_MAX_LENGTH} characters`);
        }
        if (compilePattern(pattern) === null) {
          violations.push(`pattern "${pattern}" in role "${name}" does not compile`);
        }
      }
    }
  }
  return violations;
}

/**
 * §20.3's normalization, spelled ONCE for validation, storage, matching and drift
 * alike: a bare list IS the tools list. Never mutates — the bare arm builds a new
 * object and the object arm is handed straight back, so every caller may read the
 * result but none may write it — and an object passes through as it stands,
 * unknown keys included, because judging those is validateRoles' job and hiding
 * them here would make an invalid declaration look clean.
 */
function normalizeRole(declared: string[] | FamilyPatterns): FamilyPatterns {
  return Array.isArray(declared) ? { tools: declared } : declared;
}

/** The whole declaration in normalized form — what `roles_json` stores (§20.3). */
function normalizeRoles(decl: RoleDeclaration): Record<string, FamilyPatterns> {
  return Object.fromEntries(Object.entries(decl).map(([role, declared]) => [role, normalizeRole(declared)]));
}

/**
 * §20.3's canonical read shape: a bare list when the role grants tools and nothing
 * else, the per-family object otherwise. It is a function of meaning rather than
 * storage history, so owner-facing reads have one stable representation.
 */
function canonicalRoles(stored: RoleDeclaration): RoleDeclaration {
  return Object.fromEntries(
    Object.entries(stored).map(([role, declared]) => {
      const families = normalizeRole(declared);
      const toolsOnly = ROLE_FAMILIES.every((family) => family === "tools" || (families[family] ?? []).length === 0);
      return [role, toolsOnly ? (families.tools ?? []) : families];
    }),
  );
}

/** The roles the door resolves against: the owner's, then the app's declaration on top —
 *  a name the app declares replaces the owner's definition of it (§20.3, 2026-09-17). */
export function effectiveRoles(detail: Pick<AppDetail, "declaredRoles" | "ownerRoles">): RoleDeclaration {
  // deps: none
  //
  // Replacement is per ROLE, which is what the spread gives and what the Roles pane's
  // `app · replaced yours` badge says: the app owns the NAME, so a tools-only declaration
  // of a name the owner defined across three families grants nothing in the other two.
  // Merging per family instead would let an owner widen a role the app owns, which is the
  // one thing the collision rule exists to forbid.
  return { ...detail.ownerRoles, ...detail.declaredRoles };
}

/** The role-name grammar validateRoles reports against. */
const ROLE_NAME_CHARSET = /^[a-z0-9_-]+$/;

/**
 * One grant entry, parsed. A grant set is a list of entries, and an entry is either a
 * ROLE NAME — the app's own vocabulary, resolved through its declaration — or an INLINE
 * ITEM, `<family>/<pattern>`, which carries its own pattern and needs no declaration at
 * all. The two kinds can never collide: a role name is `[a-z0-9_-]+` and so contains no
 * `/`. The mode (allow, or the `:approval` suffix) is NOT part of this — it is stripped
 * by whoever reads the wire spelling, because a resource URI carries colons of its own.
 */
export type GrantEntryKind = { kind: "role"; role: string } | { kind: "item"; family: RoleFamily; pattern: string };

/**
 * The entry grammar, read. Total and never throws, because it sits on a READ path too:
 * an entry whose prefix is not one of the three family words (`foo/x`) parses as a role
 * NAMED `foo/x`, which resolves to nothing and which the write path's role-name charset
 * check then refuses — so a typo'd family is a refusal at `setGrants`, never a silent
 * item. The pattern is everything after the FIRST `/`, so `resource/news://feed/*` keeps
 * its whole URI pattern.
 */
export function parseGrantEntry(entry: string): GrantEntryKind {
  // deps: none
  const slash = entry.indexOf("/");
  const family = slash < 0 ? undefined : ITEM_FAMILY_OF[entry.slice(0, slash)];
  return family === undefined
    ? { kind: "role", role: entry }
    : { kind: "item", family, pattern: entry.slice(slash + 1) };
}

/** The entry grammar, written: the inverse of `parseGrantEntry`'s item arm. */
export function itemEntry(family: RoleFamily, pattern: string): string {
  // deps: none
  return `${ITEM_PREFIX_OF[family]}/${pattern}`;
}

/** The entry prefix per family — singular, because an entry names one item, not a keyspace. */
const ITEM_PREFIX_OF = { tools: "tool", prompts: "prompt", resources: "resource" } as const satisfies Record<
  RoleFamily,
  string
>;

/** …read backwards. A prefix outside it is not a family at all (see `parseGrantEntry`). */
const ITEM_FAMILY_OF: Record<string, RoleFamily | undefined> = Object.fromEntries(
  Object.entries(ITEM_PREFIX_OF).map(([family, prefix]) => [prefix, family as RoleFamily]),
);

/**
 * The pure heart of access resolution: grant entries (exactly as stored, or the
 * synthesized owner grant [{role: "all", mode: "allow"}]) plus the app's
 * declaration → a ToolFilter. A granted `all` contributes `.*` in EVERY family
 * without touching the declaration; a granted role absent from it contributes no
 * patterns but still appears in roleNames; a role's families are independent, so
 * a prompts-only role matches no tool of the same name; per (subject, family),
 * any allow-mode match beats every approval-mode match. An entry that is an INLINE
 * ITEM (`tool/<pattern>`, see parseGrantEntry) contributes that one pattern in that
 * one family and consults no declaration. Exported as the testable
 * seam for the union and precedence rules — resolveAccess is D1 reads plus this.
 */
export function buildToolFilter(entries: GrantEntry[], declared: RoleDeclaration): ToolFilter {
  // deps: matchesPattern · parseGrantEntry
  const roleNames = entries.map((e) => e.role);
  // Normalized once, per role: a declaration may mix the two spellings, so sniffing the
  // shape of the declaration as a whole would read one role right and the next one empty.
  const byFamily = normalizeRoles(declared);

  function roleMatches(role: string, subject: string, family: RoleFamily): boolean {
    if (role === "all") return true; // §20.3: `all` spans every family, present and future
    // An inline item IS its own one-pattern role, confined to its own family — so
    // `tool/x` can never answer for the prompt `x`, exactly as a tools-only declared
    // role cannot. Everything downstream (allow beats approval, the union, totality)
    // is the same loop, because the only thing that differs is where the pattern came from.
    const entry = parseGrantEntry(role);
    if (entry.kind === "item") {
      return entry.family === family && matchesPattern(entry.pattern, subject, family);
    }
    const patterns = byFamily[role]?.[family];
    return patterns ? patterns.some((p) => matchesPattern(p, subject, family)) : false;
  }

  function check(subject: string, family: RoleFamily = "tools"): AccessMode {
    let approved = false;
    for (const entry of entries) {
      if (!roleMatches(entry.role, subject, family)) continue;
      if (entry.mode === "allow") return "allow"; // allow beats approval, any order
      approved = true;
    }
    return approved ? "approval" : "deny";
  }

  return {
    check,
    filterList: (items, kind = "tools") => {
      const subjectKey = LIST_SUBJECT_KEY[kind];
      const family = LIST_FAMILY[kind];
      return items.filter((item) => {
        const subject = item[subjectKey];
        // An item missing its own key names nothing the caller could have been granted,
        // so it lists as nothing — the deny side, never a fall-back to another key.
        return typeof subject === "string" && check(subject, family) !== "deny";
      });
    },
    roleNames,
  };
}

/** §20.2: which key a listed item is matched ON, per family — never `.name` for a URI. */
const LIST_SUBJECT_KEY = {
  tools: "name",
  prompts: "name",
  resources: "uri",
  resourceTemplates: "uriTemplate",
} as const satisfies Record<ListKind, keyof ListedItem>;

/** …and which pattern list judges it: a template is judged by the RESOURCE patterns. */
const LIST_FAMILY = {
  tools: "tools",
  prompts: "prompts",
  resources: "resources",
  resourceTemplates: "resources",
} as const satisfies Record<ListKind, RoleFamily>;

/**
 * The two tables above, as the accessors every OTHER module asks them through — this
 * module's header claims the keyspace and the pattern grammar, so a second copy of either
 * rule anywhere else is a copy with no owner. tunnel.ts reads both: which key an entry must
 * carry to be worth caching (a row that names nothing no grant could cover would sit
 * permanently unlistable in front of every reader), and which catalogs one declared
 * capability owns — the `resources` declaration speaking for resource templates IS this
 * table's `resourceTemplates → resources` row, read forwards instead of restated backwards.
 */
export function subjectKeyOf(kind: ListKind): "name" | "uri" | "uriTemplate" {
  return LIST_SUBJECT_KEY[kind];
}
export function patternFamilyOf(kind: ListKind): RoleFamily {
  return LIST_FAMILY[kind];
}

/**
 * The schema-declared half of §7's redaction union, as pure data: walks a JSON
 * Schema — an inputSchema or an outputSchema alike, the walk is
 * direction-blind — for properties marked `writeOnly: true` and
 * returns their dot-paths relative to the walked schema's root
 * (`params.arguments` for inputs, `structuredContent` for outputs; e.g.
 * "credentials.token") — the same path grammar applyRedaction consumes and
 * config `redact` / `redact_results` entries are written in. "At any depth"
 * includes indirection (§7): same-document `#/…` refs are resolved by JSON
 * Pointer, marks are unioned across allOf/anyOf/oneOf branches (a field secret
 * in ANY branch masks — over-masking is safe), an array whose ELEMENTS carry the
 * mark is masked at the array's own path (the grammar has no index segment), and
 * secret-free cycles are cut.
 * Callers guarantee the schema passed validateSchemaIndirection — the walk
 * never guesses at indirection that validator refuses. A malformed or absent
 * schema still yields [], never an error.
 */
export function writeOnlyPaths(schema: unknown): string[] {
  // deps: none
  return isJsonObject(schema) ? walk(schema).paths : [];
}

/** A JSON object — the only shape either half of §7's redaction pair descends into. */
type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Same-document pointers only; everything else is validateSchemaIndirection's business. */
function isLocalRef(ref: string): boolean {
  return ref === "#" || ref.startsWith("#/");
}

/**
 * RFC 6901: `~1` unescapes BEFORE `~0`, or the token `a~01b` reads as the key `a/b`
 * instead of the `a~1b` it names — the one place the two orders disagree.
 */
function pointerTarget(root: JsonObject, ref: string): unknown {
  let node: unknown = root;
  for (const token of ref === "#" ? [] : ref.slice(2).split("/")) {
    if (!isJsonObject(node)) return undefined;
    node = node[token.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return node;
}

/** §7: a mark in ANY branch masks — over-masking is safe, so composition unions. */
const BRANCH_KEYWORDS = ["allOf", "anyOf", "oneOf"] as const;

/**
 * §7's keyword decision, spelled ONCE: the subschemas reachable from `node` without
 * consuming a path segment — the same-document `$ref` target, the allOf/anyOf/oneOf
 * branches, and `items` in both its single and tuple forms (an array collapses into its
 * parent's path, because the mask applies to every element and the grammar has no index
 * segment). Every question below is asked through this set — is this marked, what are
 * its children, does this cycle carry a secret — so growing the set is one edit rather
 * than three that can silently disagree.
 */
function samePathSubschemas(node: JsonObject, root: JsonObject): JsonObject[] {
  const reachable: JsonObject[] = [];
  const ref = node.$ref;
  if (typeof ref === "string" && isLocalRef(ref)) {
    const target = pointerTarget(root, ref);
    if (isJsonObject(target)) reachable.push(target);
  }
  for (const keyword of BRANCH_KEYWORDS) {
    const branches = node[keyword];
    if (Array.isArray(branches)) reachable.push(...branches.filter(isJsonObject));
  }
  const items = node.items;
  if (Array.isArray(items)) reachable.push(...items.filter(isJsonObject));
  else if (isJsonObject(items)) reachable.push(items);
  return reachable;
}

/**
 * Is THIS subschema itself marked? A mark on any same-path subschema is a mark on the
 * node — a marked `$defs` target marks the property pointing at it, and an array of
 * marked elements is masked whole — but never on `properties`: a marked child is the
 * child's path, not its parent's.
 */
function marked(node: JsonObject, root: JsonObject, seen: Set<JsonObject>): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  if (node.writeOnly === true) return true;
  return samePathSubschemas(node, root).some((sub) => marked(sub, root, seen));
}

/**
 * The subschemas one dot-segment deeper, each with the segment it adds: the `properties`
 * of the node AND of every same-path subschema, so a composed or `$ref`-ed shape's
 * fields are the node's fields. A name can repeat across branches (two `anyOf` arms each
 * declaring `token`); both entries are kept, and the union takes whichever one marks.
 */
function pathChildren(
  node: JsonObject,
  root: JsonObject,
  seen: Set<JsonObject>,
): [string, JsonObject][] {
  if (seen.has(node)) return [];
  seen.add(node);
  const children: [string, JsonObject][] = [];
  const properties = node.properties;
  if (isJsonObject(properties)) {
    for (const [key, sub] of Object.entries(properties)) {
      if (isJsonObject(sub)) children.push([key, sub]);
    }
  }
  for (const sub of samePathSubschemas(node, root)) children.push(...pathChildren(sub, root, seen));
  return children;
}

/**
 * Does anything reachable from this subschema carry a mark? Read from the same two edge
 * sets the walk itself uses, so it answers exactly "the walk would emit a path here" —
 * a `writeOnly` sitting in a DATA value (a `default`, an `enum` entry) is not a mark.
 * This is the secret-free test a detected cycle is judged by: secret-free means CUT,
 * secret-carrying means refused (its path set is infinite).
 */
function carriesMark(node: JsonObject, root: JsonObject, seen: Set<JsonObject>): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  if (marked(node, root, new Set())) return true;
  return pathChildren(node, root, new Set()).some(([, sub]) => carriesMark(sub, root, seen));
}

/** What one walk answers — both halves, so neither caller passes the other's accumulator. */
type WalkResult = { paths: string[]; cycles: string[] };

/**
 * The one descent both halves of the refuse-line contract read: the dot-paths under a
 * schema, plus the single violation only a walk can see (a cycle carrying a secret).
 * Each caller names the half it wants.
 */
function walk(schema: JsonObject): WalkResult {
  return relativeWalk(schema, schema, new Set(), new Map());
}

/**
 * Paths RELATIVE to `node`; the caller prefixes them at the property boundary. Relative
 * is what makes an answer prefix-independent and so memoizable per node, which bounds
 * the walk by its own ANSWER: one visit per subschema plus one string per path returned.
 * Building absolute paths instead re-walks a `$defs` once per referring path and costs
 * 2^(sharing depth) even when the answer is EMPTY — on schemas the registered app
 * supplies and the hub walks at every catalog warm. A schema whose answer is genuinely
 * exponential (n shared levels above a mark really do name 2^n distinct dot-paths) still
 * costs that much; no memo can shrink an answer.
 *
 * `open` is the subschemas being expanded on the CURRENT descent, so only a back-edge is
 * a cycle. A cut edge is always mark-free — a marked one is refused instead — and a
 * mark-free subtree yields no paths, so a memoized answer stays correct in every later
 * context.
 */
function relativeWalk(
  node: JsonObject,
  root: JsonObject,
  open: Set<JsonObject>,
  memo: Map<JsonObject, WalkResult>,
): WalkResult {
  const cached = memo.get(node);
  if (cached) return cached;

  const paths: string[] = [];
  const cycles: string[] = [];
  for (const [key, sub] of pathChildren(node, root, new Set())) {
    // A marked property is masked whole, so its own subtree needs no paths of its own.
    if (marked(sub, root, new Set())) {
      paths.push(key);
      continue;
    }
    if (open.has(sub)) {
      const at = typeof sub.$ref === "string" ? `: ${sub.$ref}` : "";
      if (carriesMark(sub, root, new Set())) {
        cycles.push(`recursive $ref cycle carrying a writeOnly field${at}`);
      }
      continue;
    }
    open.add(sub);
    const inner = relativeWalk(sub, root, open, memo);
    open.delete(sub);
    for (const path of inner.paths) paths.push(`${key}.${path}`);
    cycles.push(...inner.cycles);
  }

  const result = { paths: [...new Set(paths)], cycles: [...new Set(cycles)] };
  memo.set(node, result);
  return result;
}

/**
 * The static half of the refuse-line: constructs whose mere PRESENCE anywhere in the
 * document makes resolution a guess, reachable or not — an `$anchor` sitting in an
 * unreferenced `$defs` is still a target the walk cannot address.
 */
function scanIndirection(node: unknown, violations: string[], seen: Set<object>): void {
  if (Array.isArray(node)) {
    for (const entry of node) scanIndirection(entry, violations, seen);
    return;
  }
  if (!isJsonObject(node) || seen.has(node)) return;
  seen.add(node);
  if ("$id" in node) violations.push(`$id is not resolved: ${String(node.$id)}`);
  if ("$anchor" in node) violations.push(`$anchor is not resolved: ${String(node.$anchor)}`);
  if ("$dynamicRef" in node) {
    violations.push(`$dynamicRef is not resolved: ${String(node.$dynamicRef)}`);
  }
  if (typeof node.$ref === "string" && !isLocalRef(node.$ref)) {
    violations.push(`external or non-local $ref is not resolved: ${node.$ref}`);
  }
  for (const value of Object.values(node)) scanIndirection(value, violations, seen);
}

/**
 * The refuse-line for schema indirection the walk cannot soundly resolve (§7):
 * external or non-`#/` refs, `$id`/`$anchor`/`$dynamicRef` resolution games, and
 * a recursive cycle carrying `writeOnly` inside it (its path set is infinite —
 * no finite dot-path list can express the mask). Returns human-readable
 * violations naming the construct, empty when the schema is walkable — same
 * shape and same registration-time role as validateRoles. This is what keeps
 * unsupported indirection LOUD: an unresolved ref could conceal a mark, so a
 * tool that trips this line gets no derivable redaction map at all — the
 * backend answers sensitivePaths null and the existing -32001 / no-body
 * machinery takes over (§7, §15). Never a silent [].
 */
export function validateSchemaIndirection(schema: unknown): string[] {
  // deps: none
  if (!isJsonObject(schema)) return [];
  const violations: string[] = [];
  scanIndirection(schema, violations, new Set());
  violations.push(...walk(schema).cycles);
  return violations;
}

/**
 * The one spelling of a masked value — what applyRedaction writes and every
 * surface shows. Exported so tests and renderers reference the name, never
 * re-type the literal (the constants discipline, §16).
 */
export const REDACTED = "‹redacted›";

/**
 * The path union one config map declares for one tool: every path under every matching
 * key, deduped (§7). The PURE half of `redactPathsFor` — exported because a caller that
 * already holds the map (a page rendering `app_get`'s row over a whole catalog) must not
 * pay one `app` read per tool to be told what it is already holding.
 */
export function redactPathsIn(config: Record<string, string[]>, tool: string): string[] {
  // deps: matchesPattern
  const paths = new Set<string>();
  for (const [key, declared] of Object.entries(config)) {
    // §20.3: the redaction maps stay family-blind — one key space, matched under the
    // tool-name grammar, which is also the grammar a prompt name lives in.
    if (matchesPattern(key, tool, "tools")) for (const path of declared) paths.add(path);
  }
  return [...paths];
}

/**
 * The one masking transformation: a copy of `args` with the value at every
 * matching dot-path replaced by REDACTED — the input is never mutated, so
 * callers hold redacted data as a new value rather than trusting a flag. A path
 * meeting an array applies to every element; a path absent from `args` is
 * ignored. Direction-blind: the same function masks `params.arguments` and
 * result `structuredContent`, each with its own path union (§7). Every body the
 * hub ever persists or displays — approval args, the audit body columns —
 * flows through here first, hashing included (§7: args_hash is post-redaction).
 */
export function applyRedaction(
  args: Record<string, unknown>,
  paths: string[],
): Record<string, unknown> {
  // deps: none
  const copy = structuredClone(args);
  for (const path of paths) maskPath(copy, path.split("."));
  return copy;
}

/**
 * Navigates only what is already there: an absent segment ends the walk, so no key is
 * ever invented, and a segment whose value is already the sentinel is a string rather
 * than a container — which is what makes an overlapping union (`credentials.token`
 * beside `credentials`) order-independent.
 */
function maskPath(node: unknown, segments: string[]): void {
  // A path meeting an array applies to every element.
  if (Array.isArray(node)) {
    for (const element of node) maskPath(element, segments);
    return;
  }
  if (!isJsonObject(node)) return;
  const [head, ...rest] = segments;
  if (!Object.prototype.hasOwnProperty.call(node, head)) return;
  if (rest.length === 0) node[head] = REDACTED;
  else maskPath(node[head], rest);
}

// ── §23.3 owner execution settings ────────────────────────────────────────────────────
//
// One row per owner, and ABSENCE is the pinned default pair — the value the admission
// path, the provider singleton and the ops all read through this module, so "no row"
// and "explicitly the defaults" can never answer differently.

/**
 * §23.3's settings read shape — the exact object `hub_settings_get`/`hub_settings_update`
 * return and the provider singleton stores. Milliseconds; `defaultTimeoutMs` is what an
 * `execute` without `timeout_ms` gets, `maxTimeoutMs` the largest `timeout_ms` the owner
 * may request (and the owner's ceiling is itself capped by the compiled hard maximum).
 */
export type HubExecutionSettings = {
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
};

/**
 * The pair an absent `hub_execution_setting` row MEANS (§23.3: "No row means the pinned
 * defaults `30_000/30_000`"). Built from the same limits constants the range check and
 * the admission path read, so "the default" has one definition.
 */
export const DEFAULT_HUB_EXECUTION_SETTINGS: HubExecutionSettings = {
  defaultTimeoutMs: HUB_DEFAULT_TIMEOUT_MS,
  maxTimeoutMs: HUB_INITIAL_MAX_TIMEOUT_MS,
};

/**
 * §23.3's range rule as ONE list, applied by the op (before its write, so a refusal never
 * reaches D1) and by the registry (before its upsert, so a raw caller cannot store what
 * the CHECK would refuse). Field names are the OP's `default_timeout_ms` /
 * `max_timeout_ms` spellings, so `hub_settings_update`'s refusal needs no translation;
 * the three checks are exactly the table's three CHECKs, spelled over the read shape.
 */
export function executionSettingViolations(settings: {
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
}): Violation[] {
  // deps: limits constants (the numbers the schema and the CHECK also carry)
  const found: Violation[] = [];
  const { defaultTimeoutMs, maxTimeoutMs } = settings;
  if (defaultTimeoutMs < HUB_MIN_TIMEOUT_MS) {
    found.push({
      field: "default_timeout_ms",
      reason: `"default_timeout_ms" must be at least ${HUB_MIN_TIMEOUT_MS}`,
    });
  }
  if (maxTimeoutMs > HUB_HARD_MAX_TIMEOUT_MS) {
    found.push({
      field: "max_timeout_ms",
      reason: `"max_timeout_ms" must be at most ${HUB_HARD_MAX_TIMEOUT_MS}`,
    });
  }
  if (defaultTimeoutMs > maxTimeoutMs) {
    found.push({
      field: "default_timeout_ms",
      reason: `"default_timeout_ms" must not exceed "max_timeout_ms"`,
    });
  }
  return found;
}

/**
 * The domain model over the shared D1 control plane. Construct one per request
 * (D1 bindings are request-scoped); the tunnel DO constructs its own around the
 * same binding for upsertDeclaredRoles and upsertDeclaredTypescriptAliases. Methods are
 * row-level primitives: they keep the row invariants (slug uniqueness, kind
 * immutability, mode/envelope agreement, names reserved before they are published)
 * but never orchestrate across modules — token deletion, DO sever/wipe, and audit rows
 * are the caller's choreography.
 */
export class Registry {
  private readonly db: D1Like;

  constructor(db: D1Database) {
    // deps: none
    this.db = db as D1Like;
  }

  /** The one `app` read every method below shares — by opaque id, reservation-blind. */
  private async row(appId: string): Promise<AppRow | null> {
    return this.db.prepare(`SELECT * FROM app WHERE id = ?`).bind(appId).first<AppRow>();
  }

  /**
   * Looks up one app row by (owner, slug), archived or not — the archived
   * check is a later pipeline stage, not a lookup filter. Returns null for a
   * missing slug and for either reserved virtual slug (`pmcp`, `hub`) alike: both are
   * virtual, and admin materializes the builtin. Never throws for absence.
   */
  /**
   * The same row by its opaque id — the read the /connect upgrade makes, which knows only
   * the id resolveAppToken hands back, and the one the tunnel DO re-checks with when
   * a registration write fails. Registry's vocabulary, not the column format: `archived`
   * is a boolean and `kind` an AppKind, so the `archived_at` timestamp stays owned
   * here. Null when the row is gone; neither virtual slug has one.
   */
  async appById(appId: string): Promise<AppDetail | null> {
    // deps: D1 `app`
    const row = await this.row(appId);
    return row ? toDetail(row) : null;
  }

  async getApp(ownerId: string, slug: string): Promise<AppDetail | null> {
    // deps: D1 `app`
    if (slug === PMCP_SLUG || slug === HUB_SLUG) return null;
    const row = await this.db
      .prepare(`SELECT * FROM app WHERE owner_id = ? AND slug = ?`)
      .bind(ownerId, slug)
      .first<AppRow>();
    return row ? toDetail(row) : null;
  }

  /**
   * The apps a principal can see, archived rows included: for an owner (or an admin
   * token acting on its behalf, §22.1 — though it never actually reaches here: the
   * builtin `pmcp` app has no row and admission refuses it everywhere else), every row
   * in their namespace; for an agent, exactly the rows it holds at least one grant on —
   * so a zero-grant agent sees nothing and can enumerate nothing. Never contains the
   * virtual `pmcp` builtin. Aggregation skips archived rows itself; they are returned
   * here because the -32002 answer and the /apps page both need them.
   */
  async listAppsFor(principal: Principal): Promise<AppDetail[]> {
    // deps: D1 `app` · D1 `grant_`
    // A zero-grant agent's subselect is empty, so "sees nothing" needs no special case.
    const [sql, key] =
      principal.kind !== "agent"
        ? [`SELECT * FROM app WHERE owner_id = ?`, principal.userId]
        : [
            `SELECT * FROM app
             WHERE id IN (SELECT app_id FROM grant_ WHERE agent_id = ?)`,
            principal.agentId,
          ];
    const { results } = await this.db.prepare(`${sql} ORDER BY slug`).bind(key).all<AppRow>();
    return results.map(toDetail);
  }

  /**
   * Creates an app row with a fresh opaque id (never derived from
   * user/slug, never reused — deleting and recreating a slug can never rebind
   * a stale DO). Rejects a malformed slug ([a-z0-9-] only — no underscore; §7's
   * prefix split relies on it), the reserved virtual slugs (`pmcp`, `hub`), a duplicate
   * (owner, slug), and kind/field mismatches: a proxied draft needs upstreamUrl and a
   * declaration that passes validateRoles, and a tunneled draft carries none of
   * the PROXY_ONLY fields — the same set, and the same check, updateApp
   * refuses to patch. Either kind's `redact` / `redact_results` keys must compile
   * as patterns (assertRedactKeys): storing one that cannot is fail-open masking.
   * An absent `logBodies` resolves here, by kind (tunnel true, proxy false,
   * §15) — the stored column is always concrete, never "default".
   *
   * §23.6: the app's canonical service identity is allocated here, and any owner
   * `typescript_aliases` are validated for syntax and arbitrated against the owner's
   * committed names — a collision refuses the whole create (nothing is stored), while a
   * generated candidate another app already holds omits this app's namespace with a
   * diagnostic. The row and its reservations commit in ONE D1 batch.
   *
   * Every one of those rejections is found before any of them is thrown: the refusal
   * carries the WHOLE list (violationsOf), so an owner fixing a draft learns all of it at
   * once rather than one field per round trip (§8).
   */
  async createApp(draft: AppDraft): Promise<AppDetail> {
    // deps: violationsOf · D1 `app` · crypto
    const violations = await this.violationsOf(draft);
    if (violations.length > 0) throw RegistryRefusal.of(violations);
    const proxied = draft.kind === "proxy";
    const roles = draft.roles ?? {};

    const row: AppRow = {
      // Opaque and fresh: never derived from user/slug, so a recreated slug can never be
      // rebound to the deleted app's DO.
      id: crypto.randomUUID(),
      owner_id: draft.ownerId,
      slug: draft.slug,
      name: draft.name,
      description: draft.description ?? "",
      kind: draft.kind,
      upstream_url: draft.upstreamUrl ?? null,
      upstream_auth_mode: draft.upstreamAuthMode ?? null,
      forward_identity: draft.forwardIdentity ? 1 : 0,
      upstream_auth_json: null,
      // §20.3: the column holds the normalized per-family object; every READ renders the
      // canonical form back, so no surface ever sees this shape.
      roles_json: JSON.stringify(normalizeRoles(roles)),
      owner_roles_json: JSON.stringify(normalizeRoles(draft.ownerRoles ?? {})),
      capabilities_json: draft.capabilities === undefined ? null : JSON.stringify(draft.capabilities),
      // §23.6's config lane, stored exactly as written — omission is `{}`, and the only
      // reader that distinguishes "never configured" from "configured empty" is the
      // durable reservation table, not this column.
      typescript_aliases_json: JSON.stringify(draft.typescriptAliases ?? {}),
      redact_json: JSON.stringify(draft.redact ?? {}),
      redact_results_json: JSON.stringify(draft.redactResults ?? {}),
      // §15: resolved HERE, by kind, so the stored column is always concrete.
      log_bodies: (draft.logBodies ?? !proxied) ? 1 : 0,
      created_at: Date.now(),
      last_connected_at: null,
      archived_at: null,
    };
    await this.commitAliasLane({
      ownerId: draft.ownerId,
      appIds: [row.id],
      // §23.6: the app's canonical service identity is its slug, and its service name is
      // allocated EAGERLY at creation (owner config first, then the generated candidate) so
      // a name is reserved before anything can publish it. `tools: null` — no family has
      // been fetched at create, so nothing here may retire a catalog-discovered member.
      services: [{ appId: row.id, service: draft.slug, tools: null }],
      aliases: [{ appId: row.id, configured: draft.typescriptAliases ?? null, hints: null }],
      lane: "owner",
      lead: [
        this.db
          .prepare(
            `INSERT INTO app (id, owner_id, slug, name, description, kind, upstream_url,
               upstream_auth_mode, forward_identity, roles_json, owner_roles_json, capabilities_json,
               typescript_aliases_json, redact_json, redact_results_json, log_bodies, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            row.id,
            row.owner_id,
            row.slug,
            row.name,
            row.description,
            row.kind,
            row.upstream_url,
            row.upstream_auth_mode,
            row.forward_identity,
            row.roles_json,
            row.owner_roles_json,
            row.capabilities_json,
            row.typescript_aliases_json,
            row.redact_json,
            row.redact_results_json,
            row.log_bodies,
            row.created_at,
          ),
      ],
    });
    return toDetail(row);
  }

  /**
   * Everything wrong with a draft, all of it — the checks createApp would have thrown at,
   * collected in the order it makes them (§8: a refusal reports every violation at once).
   * `createApp` calls this itself, so a caller that asks first and creates second is
   * validated twice rather than once-and-hopefully: the second pass is what makes a racing
   * duplicate a refusal instead of a stored row.
   *
   * The proxied-endpoint violation names `endpoint` and not `upstreamUrl`: the caller
   * typed the op's field name and gets it back (§8). What an https:// URL *is* is not
   * asked here — the endpoint rule lives at the ops, because this module is a storage
   * layer and its seeds store what they like (decision 30).
   */
  async violationsOf(draft: AppDraft): Promise<Violation[]> {
    // deps: assertSlug · patchViolations · D1 `app` (the exists read)
    const found = collect([
      () => assertSlug(draft.slug),
      () => {
        if (draft.slug === PMCP_SLUG) {
          throw new RegistryRefusal("slug", `"${PMCP_SLUG}" is reserved for the builtin`);
        }
        if (draft.slug === HUB_SLUG) {
          throw new RegistryRefusal("slug", `"${HUB_SLUG}" is reserved for the TypeScript execution surface`);
        }
      },
      () => {
        if (draft.kind === "proxy" && !draft.upstreamUrl) {
          throw new RegistryRefusal("endpoint", "is required for a proxied app");
        }
      },
    ]);
    found.push(...patchViolations(draft.kind, draft));
    if (await this.getApp(draft.ownerId, draft.slug)) {
      found.push({ field: "slug", reason: `"slug" already exists in this namespace` });
    }
    return found;
  }

  /**
   * Patches one app row. Kind is unpatchable by construction. The
   * PROXY_ONLY fields are writable for proxied rows only — the same set
   * createApp refuses on a tunneled draft, through the same check (tunneled
   * declarations arrive via upsertDeclaredRoles) — and get the same validation
   * as create; redact/redactResults paths and logBodies are writable for
   * either kind — the redaction keys through create's compile check too, so a
   * patch can no more store an uncompilable mask than a draft can. Flipping
   * upstreamAuthMode clears the stored credential envelope in the same write —
   * the mode column and the envelope kind can never disagree; the audit row
   * for that wipe is the caller's. Throws on an unknown id.
   *
   * §23.6: a supplied `typescriptAliases` replaces the owner configuration whole — an
   * ABSENT key leaves the stored map and every committed name alone — and the row write
   * commits in ONE D1 batch with the reservation writes it implies, with any collision
   * against another identity's reservation refusing the whole patch.
   */
  async updateApp(appId: string, patch: AppPatch): Promise<AppDetail> {
    // deps: patchViolations · D1 `app`
    const row = await this.row(appId);
    if (!row) throw new Error(`no app with id "${appId}"`);
    const violations = patchViolations(row.kind, patch);
    if (violations.length > 0) throw RegistryRefusal.of(violations);

    const columns: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => {
      columns.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.name !== undefined) set("name", patch.name);
    if (patch.description !== undefined) set("description", patch.description);
    if (patch.upstreamUrl !== undefined) set("upstream_url", patch.upstreamUrl);
    if (patch.forwardIdentity !== undefined) set("forward_identity", patch.forwardIdentity ? 1 : 0);
    if (patch.roles !== undefined) set("roles_json", JSON.stringify(normalizeRoles(patch.roles)));
    if (patch.ownerRoles !== undefined) set("owner_roles_json", JSON.stringify(normalizeRoles(patch.ownerRoles)));
    if (patch.capabilities !== undefined) set("capabilities_json", JSON.stringify(patch.capabilities));
    if (patch.typescriptAliases !== undefined)
      set("typescript_aliases_json", JSON.stringify(patch.typescriptAliases));
    if (patch.redact !== undefined) set("redact_json", JSON.stringify(patch.redact));
    if (patch.redactResults !== undefined) set("redact_results_json", JSON.stringify(patch.redactResults));
    if (patch.logBodies !== undefined) set("log_bodies", patch.logBodies ? 1 : 0);
    if (patch.upstreamAuthMode !== undefined) {
      set("upstream_auth_mode", patch.upstreamAuthMode);
      // The row invariant: mode and envelope kind can never disagree, so a FLIP wipes the
      // envelope in the SAME write. Re-declaring the mode it already has is not a flip —
      // an idempotent `apply` must not disconnect the app it is re-applying.
      if (patch.upstreamAuthMode !== row.upstream_auth_mode) set("upstream_auth_json", null);
    }
    const update =
      columns.length === 0
        ? []
        : [this.db.prepare(`UPDATE app SET ${columns.join(", ")} WHERE id = ?`).bind(...values, appId)];
    if (patch.typescriptAliases !== undefined) {
      // §23.6: the row write and the reservation writes commit TOGETHER — config stored
      // without its names (or the reverse) would publish a mapping the configuration does
      // not describe, and the owner lane refuses the whole batch on any collision.
      await this.commitAliasLane({
        ownerId: row.owner_id,
        appIds: [appId],
        services: [{ appId, service: row.slug, tools: null }],
        aliases: [{ appId, configured: patch.typescriptAliases, hints: null }],
        lane: "owner",
        lead: update,
      });
    } else if (update.length > 0) {
      await update[0].run();
    }
    const updated = await this.row(appId);
    if (!updated) throw new Error(`app "${appId}" vanished mid-update`);
    return toDetail(updated);
  }

  /**
   * Deletes the app row; grant and approval rows go with it via FK cascade, and §23.6's
   * reservations for the app flip to TOMBSTONES in the same batch — a name is never
   * released, so an app later reusing the slug (necessarily a NEW id) can never claim code
   * written against this one. Token deletion and DO sever/wipe are admin's cascade, ordered
   * D1-first — this method knows nothing of them. Deleting an already-absent id is a no-op.
   */
  async deleteApp(appId: string): Promise<void> {
    // deps: D1 `app` · D1 `typescript_name_reservation`
    await this.db.batch(this.deleteAppStatements(appId));
  }

  /**
   * The same delete as STATEMENTS — the tombstone first, then the row — so admin's cascade
   * can put them and the token delete into one `batch` (which is what §15 means by "one
   * atomic D1 batch", and the only way to have it: D1 offers no interactive transaction).
   * Nothing else differs; a caller with only this row to remove uses deleteApp.
   */
  deleteAppStatements(appId: string): D1Stmt[] {
    // deps: tombstoneTypescriptAliasesStatement · D1 `app`
    return [
      this.tombstoneTypescriptAliasesStatement(appId),
      this.db.prepare(`DELETE FROM app WHERE id = ?`).bind(appId),
    ];
  }

  /**
   * Marks the row archived (reversible parking; roles, grants, and tokens all
   * survive). Row flag only — severing a live socket is admin's choreography.
   * Archiving an archived row is a no-op; throws on an unknown id.
   */
  async archiveApp(appId: string): Promise<void> {
    // deps: D1 `app`
    await this.setArchived(appId, Date.now());
  }

  /** Both flags in one write, so idempotence and the unknown-id throw are stated once. */
  private async setArchived(appId: string, at: number | null): Promise<void> {
    const row = await this.row(appId);
    if (!row) throw new Error(`no app with id "${appId}"`);
    if ((row.archived_at !== null) === (at !== null)) return;
    await this.db.prepare(`UPDATE app SET archived_at = ? WHERE id = ?`).bind(at, appId).run();
  }

  /**
   * Clears the archived flag; the app is consumer-visible again on the
   * next request (reconnecting bots heal on their own — the hub does nothing
   * active). Unarchiving an unarchived row is a no-op; throws on an unknown id.
   */
  async unarchiveApp(appId: string): Promise<void> {
    // deps: D1 `app`
    await this.setArchived(appId, null);
  }

  /** Looks up one agent row by (owner, slug); null when absent. */
  async getAgent(ownerId: string, slug: string): Promise<Agent | null> {
    // deps: D1 `agent`
    const row = await this.db
      .prepare(`SELECT * FROM agent WHERE owner_id = ? AND slug = ?`)
      .bind(ownerId, slug)
      .first<AgentRow>();
    return row ? toAgent(row) : null;
  }

  /** Every agent row in the namespace; grants ride grantsFor. */
  async listAgents(ownerId: string): Promise<Agent[]> {
    // deps: D1 `agent`
    const { results } = await this.db
      .prepare(`SELECT * FROM agent WHERE owner_id = ? ORDER BY slug`)
      .bind(ownerId)
      .all<AgentRow>();
    return results.map(toAgent);
  }

  /**
   * Creates an agent row with a fresh opaque id. Rejects a malformed
   * slug and a duplicate (owner, slug). Tokens are a separate, imperative
   * surface — an agent is born credential-less.
   */
  async createAgent(draft: AgentDraft): Promise<Agent> {
    // deps: D1 `agent` · crypto
    assertSlug(draft.slug);
    if (await this.getAgent(draft.ownerId, draft.slug)) {
      throw new RegistryRefusal("slug", "already exists in this namespace");
    }
    const agent: Agent = {
      id: crypto.randomUUID(),
      ownerId: draft.ownerId,
      slug: draft.slug,
      name: draft.name,
      description: draft.description ?? "",
      createdAt: Date.now(),
    };
    await this.db
      .prepare(
        `INSERT INTO agent (id, owner_id, slug, name, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        agent.id,
        agent.ownerId,
        agent.slug,
        agent.name,
        agent.description,
        agent.createdAt,
      )
      .run();
    return agent;
  }

  /**
   * Patches an agent's display fields — createAgent's twin, minus `slug`. §22.4's whole
   * reason: without this, a display-name typo forces `RequiresReplace` in the provider,
   * and replace-of-agent is `agent_delete` then `agent_create` — the same cascade that
   * revokes every live token on the agent for a cosmetic edit. An empty patch is a legal
   * no-op, updateApp's own "no columns, no write, unchanged row" branch, so an idempotent
   * apply that resends unchanged fields never has to special-case them out first.
   */
  async updateAgent(agentId: string, patch: AgentPatch): Promise<Agent> {
    // deps: D1 `agent`
    const columns: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => {
      columns.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.name !== undefined) set("name", patch.name);
    if (patch.description !== undefined) set("description", patch.description);
    if (columns.length > 0) {
      await this.db
        .prepare(`UPDATE agent SET ${columns.join(", ")} WHERE id = ?`)
        .bind(...values, agentId)
        .run();
    }
    const row = await this.db.prepare(`SELECT * FROM agent WHERE id = ?`).bind(agentId).first<AgentRow>();
    if (!row) throw new Error(`agent "${agentId}" vanished mid-update`);
    return toAgent(row);
  }

  /**
   * Deletes the row; grant rows cascade via FK. Token deletion is admin's
   * cascade. Deleting an already-absent id is a no-op.
   */
  async deleteAgent(agentId: string): Promise<void> {
    // deps: D1 `agent`
    await this.deleteAgentStatement(agentId).run();
  }

  /** The agent delete as a statement — deleteAppStatement's twin, same reason. */
  deleteAgentStatement(agentId: string): D1Stmt {
    // deps: D1 `agent`
    return this.db.prepare(`DELETE FROM agent WHERE id = ?`).bind(agentId);
  }

  /**
   * Replaces the FULL grant set for (agent, app) atomically — an empty
   * entries list revokes everything on that pair. Rejects the same role in
   * both modes and, for proxied apps, roles absent from the declaration;
   * `all` is always grantable and never declared. Returns warnings instead of
   * failing for tunneled roles not yet declared (the file may legitimately be
   * ahead of the first connection). An inline item entry (parseGrantEntry) skips both:
   * it declares itself, and is refused only when its pattern is empty or uncompilable.
   * The `pmcp` builtin is unreachable here by
   * construction — it has no app id.
   */
  async setGrants(agentId: string, appId: string, entries: GrantEntry[]): Promise<string[]> {
    // deps: validateRoles · parseGrantEntry · compilePattern · D1 `grant_` · D1 `app`
    const row = await this.row(appId);
    if (!row) throw new Error(`no app with id "${appId}"`);
    // The EFFECTIVE map, not the app's declaration: an owner role IS declared for this
    // check (§20.3, 2026-09-17), so the tunneled warning and the proxied error fire only
    // for a name in neither map.
    const declared = effectiveRoles(toDetail(row));
    const warnings: string[] = [];
    const seen = new Set<string>();

    // Everything that can refuse runs BEFORE the write: a rejected set stores nothing.
    for (const entry of entries) {
      if (seen.has(entry.role)) {
        throw new RegistryRefusal(
          "roles",
          `names "${entry.role}" twice — one grant row per (agent, app, role)`,
        );
      }
      seen.add(entry.role);
      if (entry.role === "all") continue; // the built-in: always grantable, never declared
      // An inline item carries its own pattern, so it needs no declaration and is never
      // "undeclared" — the tunneled warning and the proxied error below are role-only.
      // What it owes instead is a pattern the language can read: an empty one, or one
      // compilePattern refuses, would sit in storage matching nothing forever.
      const parsed = parseGrantEntry(entry.role);
      if (parsed.kind === "item") {
        if (parsed.pattern === "" || compilePattern(parsed.pattern) === null) {
          throw new RegistryRefusal("roles", `entry "${entry.role}" is not a valid pattern`);
        }
        continue;
      }
      assertRoles({ [entry.role]: [] });
      if (Object.prototype.hasOwnProperty.call(declared, entry.role)) continue;
      if (row.kind === "proxy") {
        // A proxied declaration is complete by construction, so this is an owner error.
        throw new RegistryRefusal("roles", `names "${entry.role}", which this app does not declare`);
      }
      // A tunneled declaration arrives at registration — the file may be ahead of it.
      warnings.push(`role "${entry.role}" is not declared by app "${row.slug}" yet`);
    }

    // The full set, replaced atomically: an empty entries list is a legal revoke-everything.
    await this.db.batch([
      this.db
        .prepare(`DELETE FROM grant_ WHERE agent_id = ? AND app_id = ?`)
        .bind(agentId, appId),
      ...entries.map((entry) =>
        this.db
          .prepare(`INSERT INTO grant_ (agent_id, app_id, role, mode) VALUES (?, ?, ?, ?)`)
          .bind(agentId, appId, entry.role, entry.mode),
      ),
    ]);
    return warnings;
  }

  /**
   * Every grant the agent holds, grouped per app for `agent_list`'s inline grants.
   * Apps with no grants simply don't appear.
   */
  async grantsFor(agentId: string): Promise<AppGrants[]> {
    // deps: D1 `grant_` · D1 `app`
    const { results } = await this.db
      .prepare(
        `SELECT g.app_id, s.slug, g.role, g.mode
         FROM grant_ g JOIN app s ON s.id = g.app_id
         WHERE g.agent_id = ?
         ORDER BY s.slug, g.role`,
      )
      .bind(agentId)
      .all<{ app_id: string; slug: string; role: string; mode: GrantMode }>();

    const perApp = new Map<string, AppGrants>();
    for (const row of results) {
      let grants = perApp.get(row.app_id);
      if (!grants) {
        grants = { appId: row.app_id, appSlug: row.slug, entries: [] };
        perApp.set(row.app_id, grants);
      }
      grants.entries.push({ role: row.role, mode: row.mode });
    }
    return [...perApp.values()];
  }

  /**
   * Resolves what a principal may call on one app, at request time — the
   * declaration is re-read on every call, so a role widened at reconnect takes
   * effect immediately. Owners get the everything-filter (roleNames ["all"]);
   * agents get their stored grants resolved through buildToolFilter.
   * Works unchanged for the virtual `pmcp` app: owners see everything,
   * agents resolve to zero grants — no special case. Never throws for
   * "no access"; absence of grants is a normal ToolFilter (see roleNames).
   *
   * An `admin` principal (§22.1) gets the same everything-filter a `user` does — its OWN
   * restriction (every op but `approval_decide`/`admin_token_issue`) is a `pmcp`-only,
   * op-NAME-level policy (admin.adminOpsFor), never a grant, and the only app it can ever
   * reach here is the builtin, whose declaration is empty regardless.
   */
  async resolveAccess(principal: Principal, app: App): Promise<ToolFilter> {
    // deps: buildToolFilter · D1 `grant_` · D1 `app`
    //
    // Spelled as a switch because the shape it replaces — `kind !== "agent"` → grant every
    // tool — fails OPEN: a fourth `Principal` kind would receive an unfiltered
    // everything-filter on every app, which is the single widest privilege in the hub. The
    // annotated return type with no `default` arm makes adding a kind a type error instead.
    switch (principal.kind) {
      case "user":
      case "admin":
        return buildToolFilter([{ role: "all", mode: "allow" }], {});
      case "agent":
        break;
    }
    // Re-read, never trust the passed row: a role widened at reconnect must bite on the very
    // next call. The virtual `pmcp` app has no row, which reads as "declares nothing".
    const row = await this.row(app.id);
    // Both maps, merged the one way §20.3 pins: the owner's, then the app's declaration on
    // top. Re-read per call like the declaration itself, so an owner role saved on the
    // Roles pane bites on the very next call and a reconnect's redeclaration shadows it
    // just as immediately.
    const declared = row ? effectiveRoles(toDetail(row)) : {};
    const { results } = await this.db
      .prepare(
        `SELECT role, mode FROM grant_
         WHERE agent_id = ? AND app_id = ? ORDER BY role`,
      )
      .bind(principal.agentId, app.id)
      .all<GrantEntry>();
    return buildToolFilter(results, declared);
  }

  /**
   * The CONFIG-declared sensitive paths for one tool in one direction: the
   * union of paths under every matching key of the direction's config map —
   * `redact` for "args", `redact_results` for "results" (§7; keys are tool
   * names or patterns in the same pattern language). Empty when nothing is
   * declared. Schema-declared writeOnly paths are the tunnel backend's
   * business; the gateway unions the two per direction before anything is
   * stored or shown.
   */
  async redactPathsFor(
    app: App,
    tool: string,
    direction: "args" | "results",
  ): Promise<string[]> {
    // deps: redactPathsIn · D1 `app`
    const row = await this.row(app.id);
    if (!row) return []; // the virtual `pmcp` builtin declares no redaction config
    return redactPathsIn(JSON.parse(direction === "args" ? row.redact_json : row.redact_results_json), tool);
  }

  /**
   * The tunnel registration write: stores an app's self-declared roles —
   * NORMALIZED, per §20.3, so the column holds one shape whichever spelling
   * registered — and reports drift. The DO hands the wire-shaped declaration
   * straight here; the stored column format never enters tunnel code. Throws on
   * an invalid
   * declaration (never partially writes; callers wanting the violation list
   * for their error reply run validateRoles first), on a proxied app, and
   * on a row that no longer exists (the caller's close-4003 signal). Also
   * stamps the row's last-connected timestamp — successful registration is the
   * only moment a tunnel comes online. Drift is textual only (see DriftReport);
   * auditing a non-empty report is the caller's job.
   */
  async upsertDeclaredRoles(appId: string, roles: RoleDeclaration): Promise<DriftReport> {
    // deps: validateRoles · D1 `app` · D1 `grant_`
    const row = await this.row(appId);
    if (!row) throw new Error(`app "${appId}" no longer exists`); // caller's close-4003
    if (row.kind !== "tunnel") throw new Error(`proxied app "${row.slug}" declares roles in config`);
    assertRoles(roles); // before any write: an invalid declaration never lands partially

    const previous: RoleDeclaration = JSON.parse(row.roles_json);
    const { results } = await this.db
      .prepare(`SELECT DISTINCT role FROM grant_ WHERE app_id = ?`)
      .bind(appId)
      .all<{ role: string }>();
    const granted = new Set(results.map((g) => g.role));

    // Textual only (§6), and per FAMILY (§20.3): a family absent from either side is the
    // empty set, and a role nobody holds is silent. Never regex-language containment — a
    // rewritten string IS drift. Both sides are normalized first, so restating a bare list
    // as `{tools: [...]}` draws no row.
    const widened: DriftReport["widened"] = [];
    const normalized = normalizeRoles(roles);
    for (const [role, families] of Object.entries(normalized)) {
      if (!granted.has(role)) continue;
      for (const family of ROLE_FAMILIES) {
        const before = new Set(normalizeRole(previous[role] ?? [])[family] ?? []);
        const added = [...new Set((families[family] ?? []).filter((p) => !before.has(p)))];
        // The tools entry stays exactly the shape §6 has always reported (see DriftReport):
        // no family key, because no family named IS the tools family.
        if (added.length > 0) widened.push({ role, ...(family === "tools" ? {} : { family }), patterns: added });
      }
    }

    await this.db
      .prepare(`UPDATE app SET roles_json = ?, last_connected_at = ? WHERE id = ?`)
      .bind(JSON.stringify(normalized), Date.now(), appId)
      .run();
    return { widened };
  }

  // ─ §23.3 · owner execution settings ───────────────────────────────────────────────

  /**
   * §23.3's settings read. An absent row answers the pinned default pair; the value is
   * owner-scoped, never bearer-scoped, so every credential of one owner reads one pair and
   * a new credential never sees a different answer.
   */
  async hubExecutionSettings(ownerId: string): Promise<HubExecutionSettings> {
    // deps: D1 `hub_execution_setting`
    const row = await this.db
      .prepare(`SELECT default_timeout_ms, max_timeout_ms FROM hub_execution_setting WHERE owner_id = ?`)
      .bind(ownerId)
      .first<{ default_timeout_ms: number; max_timeout_ms: number }>();
    if (row === null) return { ...DEFAULT_HUB_EXECUTION_SETTINGS };
    return { defaultTimeoutMs: row.default_timeout_ms, maxTimeoutMs: row.max_timeout_ms };
  }

  /**
   * §23.3's pair write: ONE upsert of both columns, so no reader can observe a
   * half-updated pair. The range rule is re-checked here even though the op checked it —
   * a raw caller must not store what the table's CHECK would refuse, and a CHECK
   * violation on a live write would be a defect rather than a refusal. Already-admitted
   * executions keep the deadline they snapshotted (§23.3): this governs new admissions.
   */
  async updateHubExecutionSettings(
    ownerId: string,
    settings: HubExecutionSettings,
  ): Promise<HubExecutionSettings> {
    // deps: executionSettingViolations · D1 `hub_execution_setting`
    const violations = executionSettingViolations(settings);
    if (violations.length > 0) throw RegistryRefusal.of(violations);
    await this.db
      .prepare(
        `INSERT INTO hub_execution_setting (owner_id, default_timeout_ms, max_timeout_ms)
         VALUES (?, ?, ?)
         ON CONFLICT (owner_id) DO UPDATE SET
           default_timeout_ms = excluded.default_timeout_ms,
           max_timeout_ms = excluded.max_timeout_ms`,
      )
      .bind(ownerId, settings.defaultTimeoutMs, settings.maxTimeoutMs)
      .run();
    return { defaultTimeoutMs: settings.defaultTimeoutMs, maxTimeoutMs: settings.maxTimeoutMs };
  }

  // ─ §23.6 · durable TypeScript names ───────────────────────────────────────────────

  /**
   * §23.6's SDK lane — the aliases a tunnel declares at `hub/register`. A hint never takes
   * a healthy tunnel offline: the syntax is refused up front (`RegistryRefusal`, the
   * caller's registration refusal), while an ESTABLISHED or contested name is omitted with
   * a bounded diagnostic and every surviving hint is committed before this returns. Throws
   * on a proxied row (aliases arrive at registration; a proxied app's owner configures
   * them) and on a row that no longer exists (the caller's close-4003 signal), exactly like
   * `upsertDeclaredRoles`.
   *
   * `diagnostics` names only this app's own members, so it is safe to carry verbatim in the
   * connect audit decision the caller writes beside registration.
   */
  async upsertDeclaredTypescriptAliases(
    appId: string,
    aliases: TypescriptAliases,
  ): Promise<{ diagnostics: readonly AliasDiagnostic[] }> {
    // deps: planAliasReservations · D1 `app` · D1 `typescript_name_reservation`
    const row = await this.row(appId);
    if (!row) throw new Error(`app "${appId}" no longer exists`); // caller's close-4003
    if (row.kind !== "tunnel") throw new Error(`proxied app "${row.slug}" configures aliases through its owner`);
    assertTypescriptAliases(aliases);
    const configured = JSON.parse(row.typescript_aliases_json) as TypescriptAliases;
    const plan = await this.commitAliasLane({
      ownerId: row.owner_id,
      appIds: [appId],
      aliases: [{ appId, configured, hints: aliases }],
      services: [{ appId, service: row.slug, tools: null }],
      lane: "sdk",
    });
    return { diagnostics: plan.diagnostics };
  }

  /**
   * §23.5/§23.6's discovery write, behind the catalog collector: durable names for the
   * canonical families it just fetched, committed BEFORE the snapshot that uses them is
   * published (§23.6's "persisted before publication"). `tools: null` is a failed family
   * fetch and disables disappearance retirement for that app — an empty list and an
   * unreachable family are not the same fact — while a fetched list retires the members it
   * no longer contains. The SDK lane never refuses: a lost race, a vanished app or an
   * omitted member is a diagnostic, and one app's omission never erases another's healthy
   * names. All apps must belong to one owner (the collector works per namespace).
   */
  async allocateTypescriptNames(services: readonly AliasServiceMembers[]): Promise<AliasPlan> {
    // deps: planAliasReservations · D1 `app` · D1 `typescript_name_reservation`
    if (services.length === 0) {
      return { services: [], activate: [], retire: [], diagnostics: [], conflicts: [], refusals: [] };
    }
    const rows = await Promise.all(services.map((service) => this.row(service.appId)));
    rows.forEach((row, index) => {
      if (row === null) throw new Error(`no app with id "${services[index].appId}"`);
      if (row.slug !== services[index].service) {
        throw new Error(`app "${services[index].appId}" is "${row.slug}", not "${services[index].service}"`);
      }
    });
    const ownerIds = new Set(rows.map((row) => row!.owner_id));
    if (ownerIds.size !== 1) throw new Error("allocateTypescriptNames spans more than one owner");
    const ownerId = [...ownerIds][0];
    return this.commitAliasLane({
      ownerId,
      appIds: services.map((service) => service.appId),
      aliases: services.map((service, index) => ({
        appId: service.appId,
        configured: JSON.parse(rows[index]!.typescript_aliases_json) as TypescriptAliases,
        hints: null,
      })),
      services,
      lane: "sdk",
    });
  }

  /**
   * §8/§13's owner view of ONE app's committed names, by app id: its durable rows
   * (tombstones included, deterministic order) plus the planner's bounded diagnostics for
   * its canonical identities. A READ — it writes nothing, so a name that is merely
   * unallocated (an app older than this feature) reports as an empty map with no
   * diagnostic until the next snapshot or configuration write commits one. Throws on an
   * unknown id; the virtual builtin has no row and no reservations.
   */
  async typescriptReservationsFor(
    appId: string,
  ): Promise<{ reservations: readonly AliasReservation[]; diagnostics: readonly AliasDiagnostic[] }> {
    // deps: planAliasReservations · D1 `app` · D1 `typescript_name_reservation`
    const row = await this.row(appId);
    if (!row) throw new Error(`no app with id "${appId}"`);
    const rows = await this.aliasRows(row.owner_id, [appId]);
    const plan = planAliasReservations({
      services: [{ appId, service: row.slug, tools: null }],
      existing: rows,
      aliases: [{ appId, configured: JSON.parse(row.typescript_aliases_json) as TypescriptAliases, hints: null }],
      lane: "sdk",
    });
    return { reservations: rows.filter((candidate) => candidate.appId === appId), diagnostics: plan.diagnostics };
  }

  /**
   * §23.6's tombstone write for one deleted app: every reservation it holds flips to
   * inactive rather than disappearing, so the name stays reserved against a later,
   * different canonical identity. A statement rather than a write so admin's app_delete
   * commits it in the SAME D1 batch as the row deletion and the token removal (§15).
   */
  tombstoneTypescriptAliasesStatement(appId: string, now = Date.now()): D1Stmt {
    // deps: D1 `typescript_name_reservation`
    return this.db
      .prepare(`UPDATE typescript_name_reservation SET active = 0, superseded_at = ? WHERE app_id = ? AND active = 1`)
      .bind(now, appId);
  }

  /**
   * Every reservation row in an owner's service domain plus the apps' tool domains —
   * exactly the `existing` set `planAliasReservations` requires, read fresh on every pass
   * so a retry after a lost race plans against what actually committed.
   */
  private async aliasRows(ownerId: string, appIds: readonly string[]): Promise<AliasReservation[]> {
    const ids = [...new Set(appIds)];
    const toolScope = ids.length === 0 ? "" : ` OR app_id IN (${ids.map(() => "?").join(", ")})`;
    const { results } = await this.db
      .prepare(
        `SELECT app_id, family, canonical_name, typescript_name, source, active
         FROM typescript_name_reservation
         WHERE owner_id = ? AND (family = 'service'${toolScope})
         ORDER BY app_id, family, canonical_name, typescript_name`,
      )
      .bind(ownerId, ...ids)
      .all<AliasReservationRow>();
    return results.map((row) => ({
      appId: row.app_id,
      family: row.family,
      canonicalName: row.canonical_name,
      typescriptName: row.typescript_name,
      source: row.source,
      active: row.active !== 0,
    }));
  }

  /**
   * One planning pass over committed rows, in the lane's own semantics: the owner lane
   * REFUSES (throwing away the whole write — the caller must apply nothing), the SDK lane
   * diagnoses and keeps what it can. `existing` is re-read here, never cached across a
   * caller's retry.
   */
  private async planAliasLane(request: {
    ownerId: string;
    appIds: readonly string[];
    services: readonly AliasServiceMembers[];
    aliases: readonly AliasLaneInput[];
    lane: "owner" | "sdk";
  }): Promise<AliasPlan> {
    // deps: planAliasReservations
    const existing = await this.aliasRows(request.ownerId, request.appIds);
    const plan = planAliasReservations({
      services: request.services,
      existing,
      aliases: request.aliases,
      lane: request.lane,
    });
    if (plan.refusals.length > 0) {
      throw RegistryRefusal.of(plan.refusals.map((reason) => ({ field: "typescript_aliases", reason })));
    }
    return plan;
  }

  /**
   * One lane's write: plan, then apply every row in ONE batch, and on a refusal from the
   * partial unique index re-read and re-plan ONCE — the loser of a concurrent claim
   * converges on the committed rows instead of publishing a stale mapping (§23.6's "a
   * conflicting writer re-reads committed reservations"). A re-plan that would write the
   * same rows is not a retry, so the original error is rethrown: it was not a race.
   */
  private async commitAliasLane(request: {
    ownerId: string;
    appIds: readonly string[];
    services: readonly AliasServiceMembers[];
    aliases: readonly AliasLaneInput[];
    lane: "owner" | "sdk";
    lead?: readonly D1Stmt[];
  }): Promise<AliasPlan> {
    const plan = () => this.planAliasLane(request);
    const first = await plan();
    try {
      await this.applyAliasPlan(request.ownerId, first, request.lead ?? []);
      return first;
    } catch (err) {
      const retried = await plan();
      // The planner's row order is deterministic for a given input, so equal serialized
      // plans mean the retry would write exactly what just failed: the error was NOT the
      // unique-index arbitration, and rethrowing keeps the real cause.
      if (JSON.stringify([retried.activate, retried.retire]) === JSON.stringify([first.activate, first.retire])) {
        throw err;
      }
      await this.applyAliasPlan(request.ownerId, retried, request.lead ?? []);
      return retried;
    }
  }

  /** The plan's rows as statements, in one batch with whatever the caller leads with. */
  private async applyAliasPlan(ownerId: string, plan: AliasPlan, lead: readonly D1Stmt[]): Promise<void> {
    const statements: D1Stmt[] = [...lead];
    for (const row of plan.activate) {
      // The PK is (owner, app, family, canonical, typescript) — so a reactivation of this
      // identity's own tombstone is an update of the SAME row, and a name holds across
      // active and tombstoned rows by the partial unique index (§23.6).
      statements.push(
        this.db
          .prepare(
            `INSERT INTO typescript_name_reservation
               (owner_id, app_id, family, canonical_name, typescript_name, source, active, superseded_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, NULL)
             ON CONFLICT (owner_id, app_id, family, canonical_name, typescript_name)
               DO UPDATE SET source = excluded.source, active = 1, superseded_at = NULL`,
          )
          .bind(ownerId, row.appId, row.family, row.canonicalName, row.typescriptName, row.source),
      );
    }
    for (const row of plan.retire) {
      statements.push(
        this.db
          .prepare(
            `UPDATE typescript_name_reservation SET active = 0, superseded_at = ?
             WHERE owner_id = ? AND app_id = ? AND family = ? AND canonical_name = ? AND typescript_name = ?`,
          )
          .bind(Date.now(), ownerId, row.appId, row.family, row.canonicalName, row.typescriptName),
      );
    }
    if (statements.length === 0) return;
    await this.db.batch(statements);
  }
}

/** The `typescript_name_reservation` row as §5 declares it — the column format this
 *  module alone reads; `active` is the 0/1 column, translated at this one boundary. */
type AliasReservationRow = {
  app_id: string;
  family: AliasFamily;
  canonical_name: string;
  typescript_name: string;
  source: AliasSource;
  active: number;
};

/** The `app` row as §5 declares it — the column format this module alone reads. */
type AppRow = {
  id: string;
  owner_id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: AppKind;
  upstream_url: string | null;
  upstream_auth_mode: "headers" | "oauth" | null;
  forward_identity: number;
  upstream_auth_json: string | null;
  roles_json: string;
  owner_roles_json: string;               // §20.3's owner map, tunnel kind only; '{}' on a proxy
  capabilities_json: string | null;       // proxy kind only; NULL = undeclared = tools only (§20.2)
  typescript_aliases_json: string;        // §23.6's owner alias configuration; '{}' when none
  redact_json: string;
  redact_results_json: string;
  log_bodies: number;
  created_at: number;
  last_connected_at: number | null;
  archived_at: number | null;
};

/** The `agent` row, same discipline. */
type AgentRow = {
  id: string;
  owner_id: string;
  slug: string;
  name: string;
  description: string | null;
  created_at: number;
};

/** The one row→domain translation: archived is a timestamp column, the booleans are 0/1. */
function toDetail(row: AppRow): AppDetail {
  return {
    id: row.id,
    ownerId: row.owner_id,
    slug: row.slug,
    kind: row.kind,
    archived: row.archived_at !== null,
    logBodies: row.log_bodies !== 0,
    name: row.name,
    description: row.description ?? "",
    upstreamUrl: row.upstream_url,
    upstreamAuthMode: row.upstream_auth_mode,
    forwardIdentity: row.forward_identity !== 0,
    declaredRoles: canonicalRoles(JSON.parse(row.roles_json)),
    ownerRoles: canonicalRoles(JSON.parse(row.owner_roles_json)),
    capabilities: row.capabilities_json === null ? null : JSON.parse(row.capabilities_json),
    typescriptAliases: JSON.parse(row.typescript_aliases_json),
    redact: JSON.parse(row.redact_json),
    redactResults: JSON.parse(row.redact_results_json),
    createdAt: row.created_at,
    lastConnectedAt: row.last_connected_at,
  };
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    ownerId: row.owner_id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? "",
    createdAt: row.created_at,
  };
}

/**
 * §2's slug grammar, deliberately narrower than the role-name one: no underscore, because
 * §7 splits an aggregated tool name at the FIRST `_`, and no dot or uppercase, because a
 * slug is a URL path segment. Exported so a front that ADVERTISES the constraint (admin's
 * rendered JSON Schema `pattern`) and the code that enforces it read one definition.
 */
export const SLUG_CHARSET = /^[a-z0-9-]+$/;

function assertSlug(slug: string): void {
  if (!SLUG_CHARSET.test(slug)) throw new RegistryRefusal("slug", "must match [a-z0-9-]");
}

/** validateRoles' violations, as the throw every write path owes its caller. `field` is the
 *  OP's spelling, because both role maps are validated by this one function and an owner's
 *  `owner_roles` mistake must not be reported against `roles` (§8's "name the field"). */
function assertRoles(decl: RoleDeclaration, field: "roles" | "owner_roles" = "roles"): void {
  const violations = validateRoles(decl);
  if (violations.length > 0) throw new RegistryRefusal(field, violations.join("; "));
}

/**
 * §20.3's kind rule for the OWNER map, the mirror image of assertKindFields': `owner_roles`
 * is a TUNNELED app's field, because a proxied app's roles are already all the owner's and
 * live in `roles`. Spelled as its own check rather than a fourth entry in PROXY_ONLY —
 * that list is "proxied only", and this is the one field with the opposite polarity.
 *
 * The violation is authored whole rather than left to RegistryRefusal's `"<field>" <reason>`
 * default: the sentence itself quotes `"roles"`, and a second pair of quotes around the
 * subject would read as two fields being named.
 */
function assertOwnerRoles(kind: AppKind, ownerRoles: RoleDeclaration | undefined): void {
  if (ownerRoles === undefined) return;
  if (kind === "proxy") {
    const reason = `owner_roles is for tunneled apps — a proxied app's roles are "roles"`;
    throw new RegistryRefusal("owner_roles", reason, [{ field: "owner_roles", reason }]);
  }
  assertRoles(ownerRoles, "owner_roles");
}

/**
 * §20.2's capability list, as the throw both write paths owe their caller: an owner
 * declaring `resource` or `sampling` has made a typo, and storing it would advertise a
 * capability no handshake knows how to spell. Absent is legal and means `tools` only —
 * the answer every proxied app already gives, which is why this check never demands
 * the key. It gates the HANDSHAKE alone: routing stays grant-filtered whatever is
 * declared, so a wrong-but-valid declaration misleads feature detection and widens
 * nothing.
 */
function assertCapabilities(capabilities: string[] | undefined): void {
  if (capabilities === undefined) return;
  // Check list-ness at the runtime boundary: a bare string would otherwise be stored per
  // character despite the TypeScript type.
  if (!Array.isArray(capabilities)) throw new RegistryRefusal("capabilities", "must be a list");
  const unknown = capabilities.filter((entry) => !(APP_CAPABILITIES as readonly string[]).includes(entry));
  if (unknown.length > 0) {
    throw new RegistryRefusal(
      "capabilities",
      `names ${unknown.map((entry) => `"${entry}"`).join(", ")} — one of ${APP_CAPABILITIES.join(", ")}`,
    );
  }
}

/**
 * §23.6's alias SYNTAX half, as the throw both write paths owe their caller — the
 * identifier grammar, the keyword/prototype/Promise exclusions and the fixed members
 * (`hub`/`pmcp` roots, a service's `resources`) all live in hub-types' pure validator, so
 * the wire shape the SDK sends, the admin field the owner types and this check read one
 * grammar. Collisions are NOT this check's business: they need the reservation table, and
 * they are decided by the planner inside the write (refused for the owner lane, diagnosed
 * for the SDK lane). Field spelling is the OP's `typescript_aliases`.
 */
function assertTypescriptAliases(aliases: TypescriptAliases | undefined): void {
  if (aliases === undefined) return;
  const violations = aliasViolations(aliases);
  if (violations.length > 0) {
    throw RegistryRefusal.of(violations.map((reason) => ({ field: "typescript_aliases", reason })));
  }
}

/**
 * The redaction maps' half of the same rule, as the throw both write paths owe their
 * caller: a `redact` / `redact_results` key is a tool name or a pattern in the ONE
 * pattern language (§7), so a key that does not compile matches no tool at all. Stored
 * quietly it is fail-open — the argument it was written to mask lands in full in the
 * approval `args_json` and the audit body columns (§15) — so it is refused as loudly as
 * a role pattern, through the same compile helper and the same refusal type.
 */
function assertRedactKeys(field: "redact" | "redactResults", map: Record<string, string[]> | undefined): void {
  const broken = Object.keys(map ?? {}).filter((key) => compilePattern(key) === null);
  if (broken.length > 0) {
    throw new RegistryRefusal(
      field,
      `has a key that does not compile as a pattern: ${broken.map((key) => `"${key}"`).join(", ")}`,
    );
  }
}

/**
 * The fields only a PROXIED app may carry, named ONCE: the upstream endpoint and its
 * declared auth mode, the identity-forwarding flag, the role declaration a tunneled
 * app instead sends at registration, and §20.2's capability list — which a tunnel
 * likewise never declares in config, because the hub learns its capability set at
 * registration and an owner-written one could only ever contradict it. Both write paths
 * ask the question through assertKindFields below, so create and patch can never answer
 * it differently — and the next proxy-only field is one edit here rather than two lists
 * that silently disagree.
 */
const PROXY_ONLY = ["upstreamUrl", "upstreamAuthMode", "forwardIdentity", "roles", "capabilities"] as const;

/** A draft or patch, seen as just the proxy-only fields — all that this check reads. */
type ProxyOnlyFields = Partial<Record<(typeof PROXY_ONLY)[number], unknown>>;

/**
 * The kind/field rule of §5, as the throw both createApp and updateApp owe their
 * caller: a tunneled row carries none of PROXY_ONLY, in either direction. The message
 * names every offending field at once, so a caller fixes one draft rather than one field
 * per round trip.
 */
function assertKindFields(kind: AppKind, fields: ProxyOnlyFields): void {
  if (kind === "proxy") return;
  const offending = PROXY_ONLY.filter((field) => fields[field] !== undefined);
  if (offending.length === 0) return;
  throw new RegistryRefusal(
    "kind",
    `a tunneled app has no ${offending.join(", ")}: ` +
      `upstream fields are proxied-only, and a tunnel declares its roles at registration`,
  );
}

/**
 * An owner's CONFIGURATION mistake, as distinct from a bug — a duplicate slug, an
 * undeclared role, a field the kind does not carry. It is a type rather than prose
 * because the caller that renders it (admin's ops table) has to tell the two apart: a
 * refusal becomes `invalid params` and reaches the owner, while anything else is a defect
 * and reaches the wire as -32603 with no cause at all (§15). `field` names WHICH input
 * was refused; `reason` is authored here and never contains a credential — this module
 * receives none (upstream headers and token material live behind other seams entirely).
 * Every other throw out of this module is an invariant violation and stays a plain Error.
 */
export class RegistryRefusal extends Error {
  readonly violations: readonly Violation[];
  constructor(
    readonly field: string,
    readonly reason: string,
    /** Several at once — `of` below is how a caller builds one; the default is the single
     *  case, whose `message` is therefore byte-identical to what it always was. */
    violations: readonly Violation[] = [{ field, reason: `"${field}" ${reason}` }],
  ) {
    super(violations.map((violation) => violation.reason).join("; "));
    this.violations = violations;
  }

  /** One refusal carrying EVERY violation a write path found (§8), rather than the first.
   *  `field`/`reason` name the first of them, so the pair still reads as it always did. */
  static of(violations: readonly Violation[]): RegistryRefusal {
    return new RegistryRefusal(violations[0].field, violations[0].reason, violations);
  }
}

/**
 * One thing wrong with a draft or a patch: the INPUT FIELD it is about, and the whole
 * sentence naming it. §8 pins the pair as the wire shape of a refusal's `data.violations`,
 * so an owner (and §13's add-app form) learns every mistake in one round trip rather than
 * one per attempt. `field` is the OP's field name where the two spellings differ — the
 * caller typed `endpoint`, never this module's `upstreamUrl`.
 */
import type { Violation } from "./errors";
export type { Violation };

/**
 * The checks a draft and a patch share, COLLECTED rather than thrown at the first — every
 * one runs, and each contributes its own sentence. Shared by createApp and updateApp so
 * neither can validate what the other does not, and exported so admin's ops can merge
 * these with the checks that belong at the owner's trust boundary (§8) before either
 * write path is entered.
 */
export function patchViolations(kind: AppKind, patch: AppPatch): Violation[] {
  // deps: assertKindFields · assertRoles · assertCapabilities · assertRedactKeys
  return collect([
    () => assertKindFields(kind, patch),
    () => {
      if (patch.roles !== undefined) assertRoles(patch.roles);
    },
    () => assertOwnerRoles(kind, patch.ownerRoles),
    () => assertCapabilities(patch.capabilities),
    () => assertTypescriptAliases(patch.typescriptAliases),
    () => assertRedactKeys("redact", patch.redact),
    () => assertRedactKeys("redactResults", patch.redactResults),
  ]);
}

/** Every check's violations, in the order the checks are listed. The checks THROW — they
 *  are the same functions the single-refusal paths use — so this is the one place a
 *  RegistryRefusal is turned back into the list it carries. */
function collect(checks: (() => void)[]): Violation[] {
  const found: Violation[] = [];
  for (const check of checks) {
    try {
      check();
    } catch (err) {
      // Anything that is not a refusal is a bug and must not be collected into an owner's
      // "you asked wrongly" list (the class comment above draws that line).
      if (!(err instanceof RegistryRefusal)) throw err;
      found.push(...err.violations);
    }
  }
  return found;
}
