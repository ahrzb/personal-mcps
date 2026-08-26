// registry.ts — the hub's domain model: services, service accounts, and grants,
// plus the ENTIRE role-pattern language in one place.
//
// OWNS: the D1 rows for `service`, `service_account`, and `grant_` (row-level
// primitives only — cascade choreography across tokens, DO sever/wipe, and audit
// belongs to admin), the role-pattern semantics (anchored ^(?:p)$ compilation,
// the literal-grammar fast path, `*` as a `.*` alias, the built-in `all` role
// resolved at request time and never stored, union-of-roles with
// allow-beats-approval), role-declaration validation shared by hub/register and
// proxied config, textual drift detection on re-declaration, the `pmcp` slug
// reservation — and the redaction path grammar: writeOnlyPaths/applyRedaction are
// the system's ONE definition of how sensitive paths are found and applied, in
// BOTH directions (§7): tunnel walks cached input and output schemas with the
// former; approvals and the gateway's audit-body path mask with the latter.
//
// HIDES: the roles_json / redact_json / redact_results_json / log_bodies column
// formats (the tunnel DO hands wire-shaped
// declarations to upsertDeclaredRoles and never touches the columns), how
// patterns compile and match, and how grant rows plus a declaration resolve into
// a ToolFilter. This module never writes audit rows, never maps errors to
// JSON-RPC, and never reads or decrypts upstream credential envelopes — its one
// touch is CLEARING the envelope column when updateService flips the auth mode,
// a row invariant (mode and envelope kind can never disagree), not a read.

import type { Principal } from "./identity";
import { ROLE_NAME_MAX_LENGTH, ROLE_PATTERN_MAX_LENGTH, ROLE_PATTERNS_MAX } from "./limits";

/** The request-scoped Cloudflare D1 binding (`D1Database` from `@cloudflare/workers-types`). */
type D1Database = unknown;

/**
 * The two service shapes, in the wire vocabulary pinned by §5's CHECK constraint
 * and the YAML `kind:` field: `tunnel` dials in over the reverse WebSocket and
 * declares roles at registration; `proxy` is an upstream MCP endpoint the hub
 * forwards to, with roles defined in config. Immutable after create — a
 * conversion would orphan service tokens and DO state, so it's recreate-only.
 */
export type ServiceKind = "tunnel" | "proxy";

/**
 * The cross-module view of a service row — exactly what the request pipeline
 * needs to route, gate, and address. Richer reads go through ServiceDetail.
 */
export type Service = {
  id: string;        // opaque row id — the DO addressing key; never derived from user/slug, never reused
  ownerId: string;
  slug: string;
  kind: ServiceKind;
  archived: boolean;
  logBodies: boolean; // §15 — whether tools/call audit rows carry this service's bodies
};

/**
 * A per-tool access verdict. `deny` is only ever a resolver answer — grant rows
 * store `allow` or `approval`, never `deny` (an ungranted tool is simply
 * unmatched).
 */
export type AccessMode = "allow" | "approval" | "deny";

/**
 * A caller's resolved access to one service, produced by resolveAccess and
 * consumed by the gateway. Pure and snapshot-in-time: it holds the union of the
 * principal's granted roles resolved against the declaration as of the resolve
 * call, and does no I/O of its own.
 *
 * Semantics the gateway leans on: check() takes the UNPREFIXED tool name and
 * answers `allow` when any allow-mode role matches (allow beats approval),
 * `approval` when only approval-mode roles match, `deny` otherwise.
 * filterList() drops only `deny` tools — approval-gated tools list like any
 * other, since the agent must see them to call them. An empty roleNames on a
 * service-account principal means the account holds no grants at all on this
 * service (the gateway's scoped-404 signal) — distinct from granted-but-
 * undeclared roles, which appear in roleNames but match nothing (empty
 * tools/list and -32001, a normal state). Owners always carry ["all"].
 */
export type ToolFilter = {
  check(tool: string): AccessMode;
  filterList<T extends { name: string }>(tools: T[]): T[];
  roleNames: string[];   // granted role names, for hub/roles forwarding
};

/**
 * A role declaration in wire shape — role name to anchored patterns, exactly as
 * hub/register and the YAML `roles:` block carry it. `{}` means "no roles
 * declared": the service is reachable only by owners and `all`-granted accounts.
 */
export type RoleDeclaration = Record<string, string[]>;

/**
 * What upsertDeclaredRoles found when comparing old and new declarations.
 * A role appears here only when it holds at least one live grant AND its new
 * pattern set is not a subset of the old one (compared as exact strings — never
 * regex-language containment); `patterns` lists the added or changed strings.
 * Empty `widened` means no visible drift. The caller turns a non-empty report
 * into the `connect.roles_widened` audit row — this module never audits.
 */
export type DriftReport = {
  widened: { role: string; patterns: string[] }[];
};

/** The grant modes an owner can actually store — `deny` is never a grant. */
export type GrantMode = "allow" | "approval";

/** One granted role on one service, exactly as stored: name plus mode. */
export type GrantEntry = { role: string; mode: GrantMode };

/**
 * An account's grants on one service — the shape account_list returns inline
 * and the CLI diff planner consumes, so desired state is readable in one
 * grantsFor call per account.
 */
export type ServiceGrants = {
  serviceId: string;
  serviceSlug: string;
  entries: GrantEntry[];
};

/**
 * The full owner-facing read of a service row — everything service_get and the
 * diff planner need. Timestamps are epoch milliseconds. The upstream credential
 * envelope is deliberately absent: credentials never surface through any
 * registry read.
 */
export type ServiceDetail = Service & {
  name: string;
  description: string;
  upstreamUrl: string | null;              // proxied only, null on tunneled
  upstreamAuthMode: "headers" | "oauth" | null;  // proxied only; configuration, not credentials
  forwardIdentity: boolean;                // proxied only; X-Pmcp-* headers upstream
  declaredRoles: RoleDeclaration;
  redact: Record<string, string[]>;        // tool-or-pattern → argument paths (config-declared, §7)
  redactResults: Record<string, string[]>; // same shape, applied to result structuredContent (§7)
  createdAt: number;
  lastConnectedAt: number | null;          // tunneled only, null until first registration
};

/**
 * Input to createService. Proxied drafts must carry upstreamUrl and a valid
 * roles declaration; tunneled drafts must not (their roles arrive at
 * registration). `kind` is here and only here — no patch can ever change it.
 */
export type ServiceDraft = {
  ownerId: string;
  slug: string;
  name: string;
  description?: string;
  kind: ServiceKind;
  upstreamUrl?: string;
  upstreamAuthMode?: "headers" | "oauth";
  forwardIdentity?: boolean;
  roles?: RoleDeclaration;
  redact?: Record<string, string[]>;
  redactResults?: Record<string, string[]>;
  /** absent defaults by kind: tunnel true, proxy false (§15) */
  logBodies?: boolean;
};

/**
 * Input to updateService. `kind` and `archived` are absent by construction:
 * kind is immutable, and archive/unarchive are their own primitives.
 */
export type ServicePatch = Partial<{
  name: string;
  description: string;
  upstreamUrl: string;
  upstreamAuthMode: "headers" | "oauth";
  forwardIdentity: boolean;
  roles: RoleDeclaration;
  redact: Record<string, string[]>;
  redactResults: Record<string, string[]>;
  logBodies: boolean;
}>;

/** A service-account row. Timestamps are epoch milliseconds. */
export type ServiceAccount = {
  id: string;
  ownerId: string;
  slug: string;
  name: string;
  description: string;
  createdAt: number;
};

/** Input to createAccount. */
export type AccountDraft = {
  ownerId: string;
  slug: string;
  name: string;
  description?: string;
};

/**
 * The reserved slug of the built-in admin service. No `service` row ever exists
 * for it: createService rejects it, getService returns null for it, and every
 * admin op that takes a slug rejects it with one uniform error. Because the
 * builtin has no row id, service accounts can never accumulate grants on it —
 * the reservation is what makes "accounts can't hold pmcp grants" structural
 * rather than checked.
 */
export const PMCP_SLUG = "pmcp";

/**
 * The one pattern-language decision point: does `pattern` match `tool`?
 * A pattern made only of tool-name characters ([A-Za-z0-9._-]) is compared as a
 * literal string, never compiled — `get.news` matches only the tool `get.news`.
 * Anything else compiles as ^(?:pattern)$ with no flags, so top-level `|` stays
 * anchored (`foo|bar` never matches `foox`). An un-escaped `*` not already
 * preceded by `.` reads as `.*`, so glob-style `get_*` and regex-style `get_.*`
 * mean the same thing. Never throws: a pattern that fails to compile matches
 * nothing (validateRoles is where compilation failures are reported).
 */
export function matchesPattern(pattern: string, tool: string): boolean {
  // deps: none
  if (LITERAL_PATTERN.test(pattern)) return pattern === tool;
  const re = compilePattern(pattern);
  return re ? re.test(tool) : false;
}

/** The literal-grammar fast path: tool-name characters only, compared as a string. */
const LITERAL_PATTERN = /^[A-Za-z0-9._-]+$/;

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
 * `all` is reserved (built in, never declarable), every pattern compiles under
 * the pattern language, and the size caps hold (limits.ROLE_PATTERN_MAX_LENGTH
 * per pattern, limits.ROLE_PATTERNS_MAX per role — named constants, so tests
 * never assert literals). Returns
 * human-readable violations, empty when valid ({} is valid — no roles
 * declared). Pure; callers decide whether violations become a JSON-RPC reply
 * (the tunnel DO) or a config error (admin/YAML).
 */
export function validateRoles(decl: RoleDeclaration): string[] {
  // deps: none
  const violations: string[] = [];
  for (const [name, patterns] of Object.entries(decl)) {
    if (name === "all") {
      violations.push(`role name "all" is reserved`);
      continue;
    }
    if (!ROLE_NAME_CHARSET.test(name) || name.length > ROLE_NAME_MAX_LENGTH) {
      violations.push(`role name "${name}" must match [a-z0-9_-]{1,${ROLE_NAME_MAX_LENGTH}}`);
    }
    if (patterns.length > ROLE_PATTERNS_MAX) {
      violations.push(`role "${name}" declares more than ${ROLE_PATTERNS_MAX} patterns`);
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
  return violations;
}

/** The role-name grammar validateRoles reports against. */
const ROLE_NAME_CHARSET = /^[a-z0-9_-]+$/;

/**
 * The pure heart of access resolution: grant entries (exactly as stored, or the
 * synthesized owner grant [{role: "all", mode: "allow"}]) plus the service's
 * declaration → a ToolFilter. A granted `all` contributes `.*` without touching
 * the declaration; a granted role absent from it contributes no patterns but
 * still appears in roleNames; per tool, any allow-mode match beats every
 * approval-mode match. Exported as the testable seam for the union and
 * precedence rules — resolveAccess is D1 reads plus this.
 */
export function buildToolFilter(entries: GrantEntry[], declared: RoleDeclaration): ToolFilter {
  // deps: matchesPattern
  const roleNames = entries.map((e) => e.role);

  function roleMatches(role: string, tool: string): boolean {
    if (role === "all") return true;
    const patterns = declared[role];
    return patterns ? patterns.some((p) => matchesPattern(p, tool)) : false;
  }

  function check(tool: string): AccessMode {
    let approved = false;
    for (const entry of entries) {
      if (!roleMatches(entry.role, tool)) continue;
      if (entry.mode === "allow") return "allow"; // allow beats approval, any order
      approved = true;
    }
    return approved ? "approval" : "deny";
  }

  return {
    check,
    filterList: (tools) => tools.filter((t) => check(t.name) !== "deny"),
    roleNames,
  };
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
 * 2^(sharing depth) even when the answer is EMPTY — on schemas the registered service
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

/**
 * The domain model over the shared D1 control plane. Construct one per request
 * (D1 bindings are request-scoped); the tunnel DO constructs its own around the
 * same binding for upsertDeclaredRoles. Methods are row-level primitives: they
 * keep the row invariants (slug uniqueness, kind immutability, mode/envelope
 * agreement) but never orchestrate across modules — token deletion, DO
 * sever/wipe, and audit rows are the caller's choreography.
 */
export class Registry {
  private readonly db: D1Like;

  constructor(db: D1Database) {
    // deps: none
    this.db = db as D1Like;
  }

  /** The one `service` read every method below shares — by opaque id, reservation-blind. */
  private async row(serviceId: string): Promise<ServiceRow | null> {
    return this.db.prepare(`SELECT * FROM service WHERE id = ?`).bind(serviceId).first<ServiceRow>();
  }

  /**
   * Looks up one service row by (owner, slug), archived or not — the archived
   * check is a later pipeline stage, not a lookup filter. Returns null for a
   * missing slug and for the reserved `pmcp` slug alike (the builtin is
   * virtual; admin materializes it). Never throws for absence.
   */
  /**
   * The same row by its opaque id — the read the /connect upgrade makes, which knows only
   * the id resolveServiceToken hands back, and the one the tunnel DO re-checks with when
   * a registration write fails. Registry's vocabulary, not the column format: `archived`
   * is a boolean and `kind` a ServiceKind, so the `archived_at` timestamp stays owned
   * here. Null when the row is gone; the virtual `pmcp` builtin has none.
   */
  async serviceById(serviceId: string): Promise<ServiceDetail | null> {
    // deps: D1 `service`
    const row = await this.row(serviceId);
    return row ? toDetail(row) : null;
  }

  async getService(ownerId: string, slug: string): Promise<ServiceDetail | null> {
    // deps: D1 `service`
    if (slug === PMCP_SLUG) return null;
    const row = await this.db
      .prepare(`SELECT * FROM service WHERE owner_id = ? AND slug = ?`)
      .bind(ownerId, slug)
      .first<ServiceRow>();
    return row ? toDetail(row) : null;
  }

  /**
   * The services a principal can see, archived rows included: for an owner,
   * every row in their namespace; for a service account, exactly the rows it
   * holds at least one grant on — so a zero-grant account sees nothing and can
   * enumerate nothing. Never contains the virtual `pmcp` builtin. Aggregation
   * skips archived rows itself; they are returned here because the -32002
   * answer and the /services page both need them.
   */
  async listServicesFor(principal: Principal): Promise<ServiceDetail[]> {
    // deps: D1 `service` · D1 `grant_`
    // A zero-grant account's subselect is empty, so "sees nothing" needs no special case.
    const [sql, key] =
      principal.kind === "user"
        ? [`SELECT * FROM service WHERE owner_id = ?`, principal.userId]
        : [
            `SELECT * FROM service
             WHERE id IN (SELECT service_id FROM grant_ WHERE service_account_id = ?)`,
            principal.accountId,
          ];
    const { results } = await this.db.prepare(`${sql} ORDER BY slug`).bind(key).all<ServiceRow>();
    return results.map(toDetail);
  }

  /**
   * Creates a service row with a fresh opaque id (never derived from
   * user/slug, never reused — deleting and recreating a slug can never rebind
   * a stale DO). Rejects a malformed slug ([a-z0-9-] only — no underscore; §7's
   * prefix split relies on it), the reserved `pmcp` slug, a duplicate (owner,
   * slug), and kind/field mismatches: a proxied draft needs upstreamUrl and a
   * declaration that passes validateRoles, and a tunneled draft carries none of
   * the PROXY_ONLY fields — the same set, and the same check, updateService
   * refuses to patch.
   * An absent `logBodies` resolves here, by kind (tunnel true, proxy false,
   * §15) — the stored column is always concrete, never "default".
   */
  async createService(draft: ServiceDraft): Promise<ServiceDetail> {
    // deps: validateRoles · D1 `service` · crypto
    assertSlug(draft.slug);
    if (draft.slug === PMCP_SLUG) {
      throw new RegistryRefusal("slug", `"${PMCP_SLUG}" is reserved for the builtin`);
    }
    const proxied = draft.kind === "proxy";
    if (proxied && !draft.upstreamUrl) {
      throw new RegistryRefusal("upstreamUrl", "is required for a proxied service");
    }
    assertKindFields(draft.kind, draft);
    const roles = draft.roles ?? {};
    assertRoles(roles);
    if (await this.getService(draft.ownerId, draft.slug)) {
      throw new RegistryRefusal("slug", "already exists in this namespace");
    }

    const row: ServiceRow = {
      // Opaque and fresh: never derived from user/slug, so a recreated slug can never be
      // rebound to the deleted service's DO.
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
      roles_json: JSON.stringify(roles),
      redact_json: JSON.stringify(draft.redact ?? {}),
      redact_results_json: JSON.stringify(draft.redactResults ?? {}),
      // §15: resolved HERE, by kind, so the stored column is always concrete.
      log_bodies: (draft.logBodies ?? !proxied) ? 1 : 0,
      created_at: Date.now(),
      last_connected_at: null,
      archived_at: null,
    };
    await this.db
      .prepare(
        `INSERT INTO service (id, owner_id, slug, name, description, kind, upstream_url,
           upstream_auth_mode, forward_identity, roles_json, redact_json, redact_results_json,
           log_bodies, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        row.redact_json,
        row.redact_results_json,
        row.log_bodies,
        row.created_at,
      )
      .run();
    return toDetail(row);
  }

  /**
   * Patches one service row. Kind is unpatchable by construction. The
   * PROXY_ONLY fields are writable for proxied rows only — the same set
   * createService refuses on a tunneled draft, through the same check (tunneled
   * declarations arrive via upsertDeclaredRoles) — and get the same validation
   * as create; redact/redactResults paths and logBodies are writable for
   * either kind. Flipping
   * upstreamAuthMode clears the stored credential envelope in the same write —
   * the mode column and the envelope kind can never disagree; the audit row
   * for that wipe is the caller's. Throws on an unknown id.
   */
  async updateService(serviceId: string, patch: ServicePatch): Promise<ServiceDetail> {
    // deps: validateRoles · D1 `service`
    const row = await this.row(serviceId);
    if (!row) throw new Error(`no service with id "${serviceId}"`);
    assertKindFields(row.kind, patch);
    if (patch.roles !== undefined) assertRoles(patch.roles);

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
    if (patch.roles !== undefined) set("roles_json", JSON.stringify(patch.roles));
    if (patch.redact !== undefined) set("redact_json", JSON.stringify(patch.redact));
    if (patch.redactResults !== undefined) set("redact_results_json", JSON.stringify(patch.redactResults));
    if (patch.logBodies !== undefined) set("log_bodies", patch.logBodies ? 1 : 0);
    if (patch.upstreamAuthMode !== undefined) {
      set("upstream_auth_mode", patch.upstreamAuthMode);
      // The row invariant: mode and envelope kind can never disagree, so a FLIP wipes the
      // envelope in the SAME write. Re-declaring the mode it already has is not a flip —
      // an idempotent `apply` must not disconnect the service it is re-applying.
      if (patch.upstreamAuthMode !== row.upstream_auth_mode) set("upstream_auth_json", null);
    }
    if (columns.length > 0) {
      await this.db
        .prepare(`UPDATE service SET ${columns.join(", ")} WHERE id = ?`)
        .bind(...values, serviceId)
        .run();
    }
    const updated = await this.row(serviceId);
    if (!updated) throw new Error(`service "${serviceId}" vanished mid-update`);
    return toDetail(updated);
  }

  /**
   * Deletes the row; grant and approval rows go with it via FK cascade. Token
   * deletion and DO sever/wipe are admin's cascade, ordered D1-first — this
   * method knows nothing of them. Deleting an already-absent id is a no-op.
   */
  async deleteService(serviceId: string): Promise<void> {
    // deps: D1 `service`
    await this.deleteServiceStatement(serviceId).run();
  }

  /**
   * The same delete as a STATEMENT rather than a write, so admin's cascade can put it and
   * the token delete into one `batch` — which is what §15 means by "one atomic D1 batch",
   * and the only way to have it: D1 offers no interactive transaction. Nothing else
   * differs; a caller with only this row to remove uses deleteService.
   */
  deleteServiceStatement(serviceId: string): D1Stmt {
    // deps: D1 `service`
    return this.db.prepare(`DELETE FROM service WHERE id = ?`).bind(serviceId);
  }

  /**
   * Marks the row archived (reversible parking; roles, grants, and tokens all
   * survive). Row flag only — severing a live socket is admin's choreography.
   * Archiving an archived row is a no-op; throws on an unknown id.
   */
  async archiveService(serviceId: string): Promise<void> {
    // deps: D1 `service`
    await this.setArchived(serviceId, Date.now());
  }

  /** Both flags in one write, so idempotence and the unknown-id throw are stated once. */
  private async setArchived(serviceId: string, at: number | null): Promise<void> {
    const row = await this.row(serviceId);
    if (!row) throw new Error(`no service with id "${serviceId}"`);
    if ((row.archived_at !== null) === (at !== null)) return;
    await this.db.prepare(`UPDATE service SET archived_at = ? WHERE id = ?`).bind(at, serviceId).run();
  }

  /**
   * Clears the archived flag; the service is consumer-visible again on the
   * next request (reconnecting bots heal on their own — the hub does nothing
   * active). Unarchiving an unarchived row is a no-op; throws on an unknown id.
   */
  async unarchiveService(serviceId: string): Promise<void> {
    // deps: D1 `service`
    await this.setArchived(serviceId, null);
  }

  /** Looks up one service-account row by (owner, slug); null when absent. */
  async getAccount(ownerId: string, slug: string): Promise<ServiceAccount | null> {
    // deps: D1 `service_account`
    const row = await this.db
      .prepare(`SELECT * FROM service_account WHERE owner_id = ? AND slug = ?`)
      .bind(ownerId, slug)
      .first<AccountRow>();
    return row ? toAccount(row) : null;
  }

  /** Every service-account row in the namespace; grants ride grantsFor. */
  async listAccounts(ownerId: string): Promise<ServiceAccount[]> {
    // deps: D1 `service_account`
    const { results } = await this.db
      .prepare(`SELECT * FROM service_account WHERE owner_id = ? ORDER BY slug`)
      .bind(ownerId)
      .all<AccountRow>();
    return results.map(toAccount);
  }

  /**
   * Creates a service-account row with a fresh opaque id. Rejects a malformed
   * slug and a duplicate (owner, slug). Tokens are a separate, imperative
   * surface — an account is born credential-less.
   */
  async createAccount(draft: AccountDraft): Promise<ServiceAccount> {
    // deps: D1 `service_account` · crypto
    assertSlug(draft.slug);
    if (await this.getAccount(draft.ownerId, draft.slug)) {
      throw new RegistryRefusal("slug", "already exists in this namespace");
    }
    const account: ServiceAccount = {
      id: crypto.randomUUID(),
      ownerId: draft.ownerId,
      slug: draft.slug,
      name: draft.name,
      description: draft.description ?? "",
      createdAt: Date.now(),
    };
    await this.db
      .prepare(
        `INSERT INTO service_account (id, owner_id, slug, name, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        account.id,
        account.ownerId,
        account.slug,
        account.name,
        account.description,
        account.createdAt,
      )
      .run();
    return account;
  }

  /**
   * Deletes the row; grant rows cascade via FK. Token deletion is admin's
   * cascade. Deleting an already-absent id is a no-op.
   */
  async deleteAccount(accountId: string): Promise<void> {
    // deps: D1 `service_account`
    await this.deleteAccountStatement(accountId).run();
  }

  /** The account delete as a statement — deleteServiceStatement's twin, same reason. */
  deleteAccountStatement(accountId: string): D1Stmt {
    // deps: D1 `service_account`
    return this.db.prepare(`DELETE FROM service_account WHERE id = ?`).bind(accountId);
  }

  /**
   * Replaces the FULL grant set for (account, service) atomically — an empty
   * entries list revokes everything on that pair. Rejects the same role in
   * both modes and, for proxied services, roles absent from the declaration;
   * `all` is always grantable and never declared. Returns warnings instead of
   * failing for tunneled roles not yet declared (the file may legitimately be
   * ahead of the first connection). The `pmcp` builtin is unreachable here by
   * construction — it has no service id.
   */
  async setGrants(accountId: string, serviceId: string, entries: GrantEntry[]): Promise<string[]> {
    // deps: validateRoles · D1 `grant_` · D1 `service`
    const row = await this.row(serviceId);
    if (!row) throw new Error(`no service with id "${serviceId}"`);
    const declared: RoleDeclaration = JSON.parse(row.roles_json);
    const warnings: string[] = [];
    const seen = new Set<string>();

    // Everything that can refuse runs BEFORE the write: a rejected set stores nothing.
    for (const entry of entries) {
      if (seen.has(entry.role)) {
        throw new RegistryRefusal(
          "roles",
          `names "${entry.role}" twice — one grant row per (account, service, role)`,
        );
      }
      seen.add(entry.role);
      if (entry.role === "all") continue; // the built-in: always grantable, never declared
      assertRoles({ [entry.role]: [] });
      if (Object.prototype.hasOwnProperty.call(declared, entry.role)) continue;
      if (row.kind === "proxy") {
        // A proxied declaration is complete by construction, so this is an owner error.
        throw new RegistryRefusal("roles", `names "${entry.role}", which this service does not declare`);
      }
      // A tunneled declaration arrives at registration — the file may be ahead of it.
      warnings.push(`role "${entry.role}" is not declared by service "${row.slug}" yet`);
    }

    // The full set, replaced atomically: an empty entries list is a legal revoke-everything.
    await this.db.batch([
      this.db
        .prepare(`DELETE FROM grant_ WHERE service_account_id = ? AND service_id = ?`)
        .bind(accountId, serviceId),
      ...entries.map((entry) =>
        this.db
          .prepare(`INSERT INTO grant_ (service_account_id, service_id, role, mode) VALUES (?, ?, ?, ?)`)
          .bind(accountId, serviceId, entry.role, entry.mode),
      ),
    ]);
    return warnings;
  }

  /**
   * Every grant the account holds, grouped per service — the one read behind
   * account_list's inline grants and the CLI diff planner's current-state
   * picture. Services with no grants simply don't appear.
   */
  async grantsFor(accountId: string): Promise<ServiceGrants[]> {
    // deps: D1 `grant_` · D1 `service`
    const { results } = await this.db
      .prepare(
        `SELECT g.service_id, s.slug, g.role, g.mode
         FROM grant_ g JOIN service s ON s.id = g.service_id
         WHERE g.service_account_id = ?
         ORDER BY s.slug, g.role`,
      )
      .bind(accountId)
      .all<{ service_id: string; slug: string; role: string; mode: GrantMode }>();

    const perService = new Map<string, ServiceGrants>();
    for (const row of results) {
      let grants = perService.get(row.service_id);
      if (!grants) {
        grants = { serviceId: row.service_id, serviceSlug: row.slug, entries: [] };
        perService.set(row.service_id, grants);
      }
      grants.entries.push({ role: row.role, mode: row.mode });
    }
    return [...perService.values()];
  }

  /**
   * Resolves what a principal may call on one service, at request time — the
   * declaration is re-read on every call, so a role widened at reconnect takes
   * effect immediately. Owners get the everything-filter (roleNames ["all"]);
   * service accounts get their stored grants resolved through buildToolFilter.
   * Works unchanged for the virtual `pmcp` service: owners see everything,
   * accounts resolve to zero grants — no special case. Never throws for
   * "no access"; absence of grants is a normal ToolFilter (see roleNames).
   */
  async resolveAccess(principal: Principal, service: Service): Promise<ToolFilter> {
    // deps: buildToolFilter · D1 `grant_` · D1 `service`
    if (principal.kind === "user") return buildToolFilter([{ role: "all", mode: "allow" }], {});
    // Re-read, never trust the passed row: a role widened at reconnect must bite on the very
    // next call. The virtual `pmcp` service has no row, which reads as "declares nothing".
    const row = await this.row(service.id);
    const declared: RoleDeclaration = row ? JSON.parse(row.roles_json) : {};
    const { results } = await this.db
      .prepare(
        `SELECT role, mode FROM grant_
         WHERE service_account_id = ? AND service_id = ? ORDER BY role`,
      )
      .bind(principal.accountId, service.id)
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
    service: Service,
    tool: string,
    direction: "args" | "results",
  ): Promise<string[]> {
    // deps: matchesPattern · D1 `service`
    const row = await this.row(service.id);
    if (!row) return []; // the virtual `pmcp` builtin declares no redaction config
    const config: Record<string, string[]> = JSON.parse(
      direction === "args" ? row.redact_json : row.redact_results_json,
    );
    const paths = new Set<string>();
    for (const [key, declared] of Object.entries(config)) {
      if (matchesPattern(key, tool)) for (const path of declared) paths.add(path);
    }
    return [...paths];
  }

  /**
   * The tunnel registration write: stores a service's self-declared roles and
   * reports drift. The DO hands the wire-shaped declaration straight here — the
   * stored column format never enters tunnel code. Throws on an invalid
   * declaration (never partially writes; callers wanting the violation list
   * for their error reply run validateRoles first), on a proxied service, and
   * on a row that no longer exists (the caller's close-4003 signal). Also
   * stamps the row's last-connected timestamp — successful registration is the
   * only moment a tunnel comes online. Drift is textual only (see DriftReport);
   * auditing a non-empty report is the caller's job.
   */
  async upsertDeclaredRoles(serviceId: string, roles: RoleDeclaration): Promise<DriftReport> {
    // deps: validateRoles · D1 `service` · D1 `grant_`
    const row = await this.row(serviceId);
    if (!row) throw new Error(`service "${serviceId}" no longer exists`); // caller's close-4003
    if (row.kind !== "tunnel") throw new Error(`proxied service "${row.slug}" declares roles in config`);
    assertRoles(roles); // before any write: an invalid declaration never lands partially

    const previous: RoleDeclaration = JSON.parse(row.roles_json);
    const { results } = await this.db
      .prepare(`SELECT DISTINCT role FROM grant_ WHERE service_id = ?`)
      .bind(serviceId)
      .all<{ role: string }>();
    const granted = new Set(results.map((g) => g.role));

    // Textual only (§6): a role absent from either side is the empty set, and a role nobody
    // holds is silent. Never regex-language containment — a rewritten string IS drift.
    const widened: DriftReport["widened"] = [];
    for (const [role, patterns] of Object.entries(roles)) {
      if (!granted.has(role)) continue;
      const before = new Set(previous[role] ?? []);
      const added = [...new Set(patterns.filter((p) => !before.has(p)))];
      if (added.length > 0) widened.push({ role, patterns: added });
    }

    await this.db
      .prepare(`UPDATE service SET roles_json = ?, last_connected_at = ? WHERE id = ?`)
      .bind(JSON.stringify(roles), Date.now(), serviceId)
      .run();
    return { widened };
  }
}

/** The `service` row as §5 declares it — the column format this module alone reads. */
type ServiceRow = {
  id: string;
  owner_id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: ServiceKind;
  upstream_url: string | null;
  upstream_auth_mode: "headers" | "oauth" | null;
  forward_identity: number;
  upstream_auth_json: string | null;
  roles_json: string;
  redact_json: string;
  redact_results_json: string;
  log_bodies: number;
  created_at: number;
  last_connected_at: number | null;
  archived_at: number | null;
};

/** The `service_account` row, same discipline. */
type AccountRow = {
  id: string;
  owner_id: string;
  slug: string;
  name: string;
  description: string | null;
  created_at: number;
};

/** The one row→domain translation: archived is a timestamp column, the booleans are 0/1. */
function toDetail(row: ServiceRow): ServiceDetail {
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
    declaredRoles: JSON.parse(row.roles_json),
    redact: JSON.parse(row.redact_json),
    redactResults: JSON.parse(row.redact_results_json),
    createdAt: row.created_at,
    lastConnectedAt: row.last_connected_at,
  };
}

function toAccount(row: AccountRow): ServiceAccount {
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

/** validateRoles' violations, as the throw every write path owes its caller. */
function assertRoles(decl: RoleDeclaration): void {
  const violations = validateRoles(decl);
  if (violations.length > 0) throw new RegistryRefusal("roles", violations.join("; "));
}

/**
 * The fields only a PROXIED service may carry, named ONCE: the upstream endpoint and its
 * declared auth mode, the identity-forwarding flag, and the role declaration a tunneled
 * service instead sends at registration. Both write paths ask the question through
 * assertKindFields below, so create and patch can never answer it differently — and the
 * next proxy-only field is one edit here rather than two lists that silently disagree.
 */
const PROXY_ONLY = ["upstreamUrl", "upstreamAuthMode", "forwardIdentity", "roles"] as const;

/** A draft or patch, seen as just the proxy-only fields — all that this check reads. */
type ProxyOnlyFields = Partial<Record<(typeof PROXY_ONLY)[number], unknown>>;

/**
 * The kind/field rule of §5, as the throw both createService and updateService owe their
 * caller: a tunneled row carries none of PROXY_ONLY, in either direction. The message
 * names every offending field at once, so a caller fixes one draft rather than one field
 * per round trip.
 */
function assertKindFields(kind: ServiceKind, fields: ProxyOnlyFields): void {
  if (kind === "proxy") return;
  const offending = PROXY_ONLY.filter((field) => fields[field] !== undefined);
  if (offending.length === 0) return;
  throw new RegistryRefusal(
    "kind",
    `a tunneled service has no ${offending.join(", ")}: ` +
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
  constructor(
    readonly field: string,
    readonly reason: string,
  ) {
    super(`"${field}" ${reason}`);
  }
}
