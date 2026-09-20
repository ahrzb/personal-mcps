/**
 * `/apps/<slug>`'s derivations — everything `server/src/pages/model.ts`'s `appDetailProps`
 * computed between the reads and the markup, moved to the browser because the reads are now
 * five independent queries and the page is what joins them.
 *
 * TWO groups live here, and the second is the reason this file is not just a types module:
 *
 *  - the READINGS of the four catalog answers: a family's state (listed / unread /
 *    undeclared / unconnected), the resources-and-templates join, the rail marker and the
 *    tiles line. Each is one sentence of `model.ts` with the same three-way distinction
 *    intact — an unread count is not an empty set, and neither is a family the app never
 *    advertised.
 *  - the REACH matcher: `/api/hub` reports declarations and grants but never reachability,
 *    because reachability is a function of both and the two are separate resources. So
 *    `catalog-view.reachabilityFor` and the slice of `registry`'s pattern language it sits
 *    on are ported here. This is the one place in the client that re-implements a server
 *    computation, and it is bounded on purpose: `matchesPattern`, the literal fast path,
 *    the `*` alias, `all`'s span across families, per-family independence and
 *    allow-beats-approval — and nothing else. Every pane asks THIS, so the Catalog's reach
 *    badges, the Roles editor's ticks and the Agents pane's reach line cannot disagree with
 *    each other. They can, in principle, disagree with the door; that is why the grammar is
 *    copied verbatim below rather than re-derived, and why the comments name their origin.
 *
 * Nothing here touches the network or React. It is (query answers) → (what a pane draws).
 */

import type {
  AliasDiagnostic,
  AppCapability,
  AppKind,
  AppRow,
  CatalogDerivation,
  CatalogFamily,
  FamilyPatterns,
  ListedAgent,
  ListedItem,
  RoleDeclaration,
  RoleFamily,
  RolesResponse,
  TokenInfo,
} from "@/lib/types";

/* ------------------------------ the pane contract ------------------------------ */

/**
 * One catalog family as a pane reads it — the four answers `gateway.ownerCatalog` exists to
 * keep apart, plus the one a client has and a server-rendered page did not.
 *
 * `listed` carries `items` and `derived` as PARALLEL arrays, one entry each, exactly as the
 * API answers them: `derived[i].subject` is the string a grant matches `items[i]` by, so no
 * consumer needs a second subject rule.
 *
 * `unread` is NOT `listed` with no items: the family could not be read, so nothing is known
 * about it — which is why its rail marker is blank rather than `0`. `undeclared` is the app
 * advertising no such capability, and `unconnected` is a tunneled app that has never
 * connected and therefore has no catalog at all. `pending` is the read still in flight.
 */
export type FamilyView =
  | { state: "listed"; items: ListedItem[]; derived: CatalogDerivation[] }
  | { state: "unread" }
  | { state: "undeclared" }
  | { state: "unconnected" }
  | { state: "pending" };

/**
 * What every one of the seven panes takes, and the whole of it: the page owns the reads, so
 * a pane is a pure function of this record and holds no query of its own.
 *
 * Five of the seven read only part of it. That is deliberate — the alternative is seven
 * prop types that drift, and the page would have to know which pane wants which read in
 * order to build them.
 */
export type AppPaneProps = {
  slug: string;
  /** `app_get`'s row. */
  app: AppRow;
  kind: AppKind;
  /** The advertised set and the never-connected flag. */
  capabilities: { capabilities: AppCapability[]; neverConnected: boolean } | null;
  /** The three GRANT families, resources and templates already joined. */
  views: Record<RoleFamily, FamilyView>;
  /** Whether any of the four family reads is in flight behind data already on screen. */
  refreshing: boolean;
  /** `app_roles`' three maps, or null while pending. */
  roles: RolesResponse | null;
  /** This namespace's agents, or []. */
  agents: ListedAgent[];
  /** This app's live tokens, newest first. */
  tokens: TokenInfo[];
  /** The render instant, so a frozen preview clock reaches every pane. */
  now: number;
  /** §23.6's owner-facing diagnostics, each sentence ALREADY WRITTEN by the server and
   *  carrying the subject it is about (`AppResponse.diagnostics`).
   *  `hub-types.aliasDiagnosticMessage` is the one author of that prose; a pane selects
   *  from these and never re-words `app.typescriptDiagnostics`. */
  diagnostics: AliasDiagnostic[];
};

/* ------------------------------- reading the URL -------------------------------- */

/**
 * One search key as the single string a pane acts on. The router validates search as a
 * pass-through bag, so a key a stale link repeated arrives as an array — and every key on
 * this page except `which` names ONE thing, so the first value is the answer and `""` is
 * "not set". Shared rather than re-spelled per pane: seven panes read this bag, and a pane
 * that read an array as `"a,b"` would open a dialog about a row named `a,b`.
 */
export function searchValue(search: Record<string, string | string[] | undefined>, key: string): string {
  const value = search[key];
  if (typeof value === "string") return value;
  return Array.isArray(value) ? (value[0] ?? "") : "";
}

/** The same key read as the REPEATED one it is — `?which=` names a set of expanded rows. */
export function searchValues(search: Record<string, string | string[] | undefined>, key: string): string[] {
  const value = search[key];
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value : [];
}

/* --------------------------------- the keyspaces -------------------------------- */

/** §20.3's three grant keyspaces, in the order every listing and every pattern line walks
 *  them. A family list is a SET; this is the ORDER a page prints them in, which is a
 *  different fact and the only one a renderer may rely on. */
export const ROLE_FAMILIES: readonly RoleFamily[] = ["tools", "prompts", "resources"];

/** §3's three family headings, in the order the Catalog and the editors draw them. `one` is
 *  the singular the `?sel=` grammar uses (`tool:get_news`) and the entry prefix shares. */
export const FAMILY_GROUPS: readonly { family: RoleFamily; title: string; one: "tool" | "prompt" | "resource" }[] = [
  { family: "tools", title: "Tools", one: "tool" },
  { family: "prompts", title: "Prompts", one: "prompt" },
  { family: "resources", title: "Resources", one: "resource" },
];

/** The entry prefix per family — singular, because an entry names one item, not a keyspace. */
export const KIND_OF_FAMILY: Record<RoleFamily, "tool" | "prompt" | "resource"> = {
  tools: "tool",
  prompts: "prompt",
  resources: "resource",
};

/** …read backwards. A prefix outside it is not a family at all (see `parseGrantEntry`). */
export const FAMILY_OF_KIND: Record<string, RoleFamily | undefined> = {
  tool: "tools",
  prompt: "prompts",
  resource: "resources",
};

/** Which capability declares a catalog family. `resourceTemplates` is not a capability of
 *  its own: templates ride the `resources` declaration (§20.2), which is why an app that
 *  advertises `resources` is asked for both. */
export const CAPABILITY_OF_FAMILY: Record<CatalogFamily, AppCapability> = {
  tools: "tools",
  prompts: "prompts",
  resources: "resources",
  resourceTemplates: "resources",
};

/* --------------------------- the pattern language, ported --------------------------- */

/**
 * Does `pattern` match `subject` when read in `family`? A verbatim port of
 * `registry.matchesPattern`, whose comment is the home of this grammar.
 *
 * A literal pattern is COMPARED, never compiled, so `get.news` matches only the tool
 * `get.news`. Anything else compiles as `^(?:pattern)$` with no flags, so a top-level `|`
 * stays anchored. Never throws: a pattern that fails to compile matches nothing.
 */
export function matchesPattern(pattern: string, subject: string, family: RoleFamily): boolean {
  if (isOneItem(pattern, family)) return pattern === subject;
  const compiled = compilePattern(pattern);
  return compiled === null ? false : compiled.test(subject);
}

/**
 * Whether a pattern names exactly ONE item — the test that sorts an inline entry into its
 * family's own rows rather than into `Patterns`, and decides whether typed filter text is
 * offered as a pattern at all. It is also `matchesPattern`'s literal fast path, which is
 * why the two share it: the rule that a page calls "names one item" and the rule the door
 * calls "compare, do not compile" have to be the same rule.
 *
 * The ONE thing that differs per family: tool and prompt names live in a closed charset, so
 * that charset is the test. A URI does not — `:` and `/` would drop every resource pattern
 * into compilation, where `.` matches anything — so a resource pattern is literal unless it
 * carries a regex metacharacter. `.` is deliberately not one.
 */
export function isOneItem(pattern: string, family: RoleFamily): boolean {
  return family === "resources" ? !RESOURCE_METACHARACTERS.test(pattern) : LITERAL_PATTERN.test(pattern);
}

/** The literal-grammar fast path for tool and prompt names: that charset only. */
const LITERAL_PATTERN = /^[A-Za-z0-9._-]+$/;

/** §20.3's metacharacter set, exactly: `* + ? ( ) [ ] { } | ^ $ \` — `.` is not in it. */
const RESOURCE_METACHARACTERS = /[*+?()[\]{}|^$\\]/;

/** `*` not already escaped or preceded by `.` reads as `.*`, so glob-style `get_*` and
 *  regex-style `get_.*` mean the same thing in every family. */
function aliasStars(pattern: string): string {
  let out = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    const previous = pattern[index - 1];
    out += character === "*" && previous !== "." && previous !== "\\" ? ".*" : character;
  }
  return out;
}

/** Anchored and flagless, or null when the owner's pattern is not a regex at all. */
function compilePattern(pattern: string): RegExp | null {
  try {
    return new RegExp(`^(?:${aliasStars(pattern)})$`);
  } catch {
    return null;
  }
}

/* -------------------------------- the grant grammar -------------------------------- */

/** One grant entry's two kinds: a ROLE NAME resolved through the app's declaration, or an
 *  INLINE ITEM (`tool/<pattern>`) that carries its own pattern and consults no declaration.
 *  They cannot collide — a role name is `[a-z0-9_-]+` and so contains no `/`. */
export type GrantEntryKind = { kind: "role"; role: string } | { kind: "item"; family: RoleFamily; pattern: string };

/**
 * The entry grammar, read. Total and never throws: an entry whose prefix is not one of the
 * three family words parses as a role NAMED that whole string, which resolves to nothing.
 * The pattern is everything after the FIRST `/`, so `resource/news://feed/*` keeps its whole
 * URI pattern.
 */
export function parseGrantEntry(entry: string): GrantEntryKind {
  const slash = entry.indexOf("/");
  const family = slash < 0 ? undefined : FAMILY_OF_KIND[entry.slice(0, slash)];
  return family === undefined
    ? { kind: "role", role: entry }
    : { kind: "item", family, pattern: entry.slice(slash + 1) };
}

/** The entry grammar, written: the inverse of `parseGrantEntry`'s item arm. */
export function itemEntry(family: RoleFamily, pattern: string): string {
  return `${KIND_OF_FAMILY[family]}/${pattern}`;
}

/** The wire spelling of approval mode in a grant entry (§8). */
const APPROVAL_SUFFIX = ":approval";

/** One stored entry, split into the two things a pane asks of it: what it names, and which
 *  side of the set it sits on. */
export type ParsedEntry = GrantEntryKind & { entry: string; mode: "allow" | "approval" };

/**
 * One stored grant string, parsed. The SUFFIX decides the mode, never the first colon — a
 * resource URI carries colons of its own, and splitting at the first would hand the matcher
 * `//feed/*` under a family that is not resources.
 */
export function grantEntryOf(spelled: string): ParsedEntry {
  const approval = spelled.endsWith(APPROVAL_SUFFIX);
  const entry = approval ? spelled.slice(0, -APPROVAL_SUFFIX.length) : spelled;
  return { ...parseGrantEntry(entry), entry, mode: approval ? "approval" : "allow" };
}

/** The stored spelling of a parsed entry — the inverse of `grantEntryOf`. */
export function spelledOf(entry: ParsedEntry): string {
  return entry.mode === "approval" ? `${entry.entry}${APPROVAL_SUFFIX}` : entry.entry;
}

/**
 * §20.3's normalization: a bare list IS the tools list. Never mutates — the bare arm builds
 * a new object and the object arm is handed straight back, unknown keys included, because
 * judging those is the write path's job and hiding them here would make an invalid
 * declaration look clean.
 */
export function normalizeRole(declared: string[] | FamilyPatterns): FamilyPatterns {
  return Array.isArray(declared) ? { tools: declared } : declared;
}

/* ---------------------------------- reachability ---------------------------------- */

/** One agent that reaches a subject, as §13's "Reachable by …" line renders it. */
export type Reach = {
  /** The agent's slug — `agent_list`'s own key. */
  agent: string;
  /** The verdict for this agent on this subject; never `deny`, those are dropped. */
  mode: "allow" | "approval";
  /** The granted entries that matched, each named as it is stored: `all` naming itself and
   *  never expanded, an inline item naming itself too (`tool/get_news`). */
  roles: string[];
};

/** One app's grants, parsed and built into matchers once. */
export type Reachability = {
  /** Which agents reach this subject in this family, and how. */
  reach(subject: string, family: RoleFamily): Reach[];
};

/**
 * The build-then-check split of `catalog-view.reachabilityFor`, kept split for its reason:
 * the declaration is normalized once per app rather than once per (subject × agent × grant),
 * and this page renders every family of every row.
 *
 * `declared` is the EFFECTIVE map — `app_roles`' `effective`, the one the door resolves
 * against — and `grants` is agent slug → its stored grant strings on this app. The role
 * NAMES are the granted entries that match on their own, asked the same way, so "via
 * `<role>`" can never name a role that did not match.
 */
export function reachabilityFor(declared: RoleDeclaration, grants: Record<string, string[]>): Reachability {
  const byFamily: Record<string, FamilyPatterns> = {};
  for (const [role, patterns] of Object.entries(declared)) byFamily[role] = normalizeRole(patterns);

  /** One entry's verdict on one subject. `all` spans every family, present and future
   *  (§20.3), and touches no declaration. */
  function entryMatches(role: string, subject: string, family: RoleFamily): boolean {
    if (role === BUILTIN_ROLE) return true;
    const parsed = parseGrantEntry(role);
    if (parsed.kind === "item") {
      // An inline item IS its own one-pattern role, confined to its own family — so
      // `tool/x` can never answer for the prompt `x`, exactly as a tools-only declared
      // role cannot.
      return parsed.family === family && matchesPattern(parsed.pattern, subject, family);
    }
    const patterns = byFamily[role]?.[family];
    return patterns === undefined ? false : patterns.some((pattern) => matchesPattern(pattern, subject, family));
  }

  const doors = Object.entries(grants).map(([agent, spelled]) => ({
    agent,
    entries: spelled.map(grantEntryOf),
  }));

  return {
    reach(subject, family) {
      const reached: Reach[] = [];
      for (const door of doors) {
        let allowed = false;
        let approved = false;
        const matched: string[] = [];
        for (const entry of door.entries) {
          if (!entryMatches(entry.entry, subject, family)) continue;
          matched.push(entry.entry);
          // Allow beats approval in any order (§7): one allowing entry settles the mode
          // however many approval-mode entries also match.
          if (entry.mode === "allow") allowed = true;
          else approved = true;
        }
        if (!allowed && !approved) continue;
        reached.push({ agent: door.agent, mode: allowed ? "allow" : "approval", roles: [...new Set(matched)] });
      }
      return reached;
    },
  };
}

/** §2's reserved role: granted like any other, declared by nobody. */
const BUILTIN_ROLE = "all";

/** One family's reach for one agent — the three numbers §13's reach line prints. */
export type FamilyReach = { reached: number; total: number; approval: number };

/**
 * How far one agent reaches into one family, counted over the rows the pane is HOLDING. A
 * family that is not listed counts zero of zero: there is nothing to reach into, which is a
 * true statement about an unread family too — the line says how far the reader can see, not
 * how far the grant would go.
 */
export function familyReachOf(view: FamilyView, family: RoleFamily, doors: Reachability, agent: string): FamilyReach {
  let reached = 0;
  let approval = 0;
  for (const subject of subjectsOf(view)) {
    const hit = doors.reach(subject, family).find((each) => each.agent === agent);
    if (hit === undefined) continue;
    reached += 1;
    if (hit.mode === "approval") approval += 1;
  }
  return { reached, total: countOf(view), approval };
}

/** `<agent> reaches N of T tools · K ask first · P of PT prompts · R of RT resources`. */
export function reachLine(agent: string, reach: Record<RoleFamily, FamilyReach>): string {
  return `${agent} reaches ${reach.tools.reached} of ${reach.tools.total} tools · ${reach.tools.approval} ask first · ${reach.prompts.reached} of ${reach.prompts.total} prompts · ${reach.resources.reached} of ${reach.resources.total} resources`;
}

/**
 * The grants held ON this app, and the agents holding them — the pair `appDetailProps` built
 * in one loop, because every matcher takes the map and every listing takes the rows, and
 * building them separately is two chances to disagree about who holds a grant.
 *
 * An agent with an empty entry list on this app is NOT holding a grant: `agent_list` reports
 * the key, and counting it would put an agent in the Agents pane with nothing to edit.
 */
export function grantsOn(
  app: string,
  agents: ListedAgent[],
): { grants: Record<string, string[]>; agents: ListedAgent[] } {
  const grants: Record<string, string[]> = {};
  const holding: ListedAgent[] = [];
  for (const agent of agents) {
    const held = agent.grants[app] ?? [];
    if (held.length === 0) continue;
    grants[agent.slug] = held;
    holding.push(agent);
  }
  return { grants, agents: holding };
}

/* ------------------------------ reading the families ------------------------------ */

/** A listed family's rows, or none — so a caller may walk any view without narrowing it. */
export function itemsOf(view: FamilyView): ListedItem[] {
  return view.state === "listed" ? view.items : [];
}

/** The same, for the parallel derivations. Index `i` describes `itemsOf(view)[i]`. */
export function derivedOf(view: FamilyView): CatalogDerivation[] {
  return view.state === "listed" ? view.derived : [];
}

/** Every subject in a family, in listing order — the strings a grant matches by. */
export function subjectsOf(view: FamilyView): string[] {
  return derivedOf(view).map((each) => each.subject);
}

/** A listed family's length, or 0 — what the tiles line counts, which is NOT what the rail
 *  marker says: an unread family has no count at all there. */
export function countOf(view: FamilyView): number {
  return view.state === "listed" ? view.items.length : 0;
}

/**
 * What a row prints under its name: a tool's or prompt's description, and a RESOURCE's mime
 * type — a resource's own description is not what the board prints under a URI (§20.3).
 */
export function itemDescription(item: ListedItem, family: RoleFamily): string {
  const text = family === "resources" ? item.mimeType : item.description;
  return typeof text === "string" ? text : "";
}

/** One family's non-list answer as the ONE note line that stands in for its rows — the same
 *  three states the page distinguishes, said in one sentence each. `pending` has no sentence:
 *  a skeleton stands in for it, because it is about to become one of the others. */
export function familyNote(view: FamilyView, app: string, title: string): string | null {
  if (view.state === "unconnected") return `${app} has not connected yet — nothing to list until it does.`;
  if (view.state === "undeclared") return `${title} is not advertised.`;
  if (view.state === "unread") return `${title} could not be read just now.`;
  return null;
}

/**
 * Two reads of ONE keyspace as one family view (§3's resources-and-templates group). A
 * template is named by its raw `uriTemplate`, which the API already reports as its subject,
 * so the two listings become one keyspace here and every matcher below asks one question.
 *
 * A half that could not be read makes the WHOLE view unread: an unread count is not an empty
 * set, and a group that listed one half would be claiming the other half is empty. Pending
 * comes next for the same reason one step weaker — the count is not wrong yet, it is not in
 * yet.
 */
export function joinFamilies(left: FamilyView, right: FamilyView): FamilyView {
  if (left.state === "unread" || right.state === "unread") return { state: "unread" };
  if (left.state === "pending" || right.state === "pending") return { state: "pending" };
  if (left.state === "listed" || right.state === "listed") {
    return {
      state: "listed",
      items: [...itemsOf(left), ...itemsOf(right)],
      derived: [...derivedOf(left), ...derivedOf(right)],
    };
  }
  return left;
}

/**
 * §2's rail marker over the views one entry stands for. FOUR answers that must stay apart: a
 * count, the dimmed `—` where the app advertises none, and the empty string both where a
 * listing could not be read and where it has not arrived yet — "an unread count is not an
 * empty set", so unread is neither `—` nor `0`, and one unread family blanks the whole
 * marker.
 *
 * Pending shares unread's blank because neither has a number to print; they differ in that
 * one of them is about to.
 */
export function familyMarker(...views: FamilyView[]): string {
  if (views.some((view) => view.state === "unread" || view.state === "pending")) return "";
  if (views.every((view) => view.state === "undeclared" || view.state === "unconnected")) return DIMMED_MARKER;
  return String(views.reduce((total, view) => total + countOf(view), 0));
}

/** §2's dimmed marker — an em dash, and the ONE thing that means "advertises none". Spelled
 *  here rather than imported from `lib/paths`'s `DIMMED` so the meaning and the glyph stay
 *  in one place; the page passes `DIMMED` through for the token entry, which means the same
 *  thing for its own reason. */
const DIMMED_MARKER = "—";

/* ------------------------------- the header's lines ------------------------------- */

/** `1 tool` / `3 tools` — a real plural, everywhere a count is said in words. Never
 *  `tool(s)`: a count of one is a sentence the reader is owed too. */
export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * §2's one tiles line under the title row — the parts separated by the hub's own middot,
 * because five tiles side by side would read as five independent facts rather than one
 * partition.
 *
 * `lastSeen` is formatted by the caller and passed in, so this function holds no clock: the
 * page has the render instant and the preview freezes it.
 */
export function tilesLine(
  row: AppRow,
  counts: { tools: number; prompts: number; resources: number },
  agents: number,
  lastSeen: string | null,
): string {
  const parts = [
    plural(counts.tools, "tool"),
    plural(counts.prompts, "prompt"),
    plural(counts.resources, "resource"),
    plural(agents, "agent"),
    `body logging ${row.logBodies ? "on" : "off"}`,
  ];
  if (lastSeen !== null) parts.push(`last seen ${lastSeen}`);
  return parts.join(" · ");
}

/**
 * A role's patterns, per family, as a row prints them — `tools a, b · prompts c`. A bare
 * list is the tools list, and an absent declaration is `no patterns` rather than an empty
 * line: a granted role the app does not declare reaches nothing, and the row says so.
 */
export function patternText(patterns: string[] | FamilyPatterns | undefined): string {
  if (patterns === undefined) return "no patterns";
  if (Array.isArray(patterns)) return `tools ${patterns.join(", ")}`;
  return ROLE_FAMILIES.filter((family) => (patterns[family] ?? []).length > 0)
    .map((family) => `${family} ${(patterns[family] ?? []).join(", ")}`)
    .join(" · ");
}

/* ---------------------------------- tokens & masks ---------------------------------- */

/**
 * This app's LIVE keys, newest first — `token_list`'s whole-namespace answer narrowed to
 * what §7's "every live app token" means: this app's, unrevoked, unexpired. That is what the
 * rail marker counts and what the Token pane lists.
 */
export function liveAppTokens(tokens: TokenInfo[], slug: string, now: number): TokenInfo[] {
  return tokens
    .filter(
      (token) =>
        token.kind === "app" &&
        token.refSlug === slug &&
        token.revokedAt === null &&
        (token.expiresAt === null || token.expiresAt > now),
    )
    .sort((left, right) => right.createdAt - left.createdAt);
}

/**
 * Which key the live socket presented is not stored, so it is DERIVED: when the app is
 * online, the most recently used live key is the one that opened it. Null when none has ever
 * been used, or when nothing is online to have opened anything.
 */
export function liveTokenId(tokens: TokenInfo[], online: boolean): string | null {
  if (!online) return null;
  let best: TokenInfo | null = null;
  for (const token of tokens) {
    if (token.lastUsedAt === null) continue;
    if (best === null || token.lastUsedAt > (best.lastUsedAt ?? 0)) best = token;
  }
  return best?.id ?? null;
}

/**
 * The path union one redaction map declares for one tool: every path under every matching
 * key, deduped (§7). The maps stay family-blind — one keyspace, matched under the tool-name
 * grammar, which is also the grammar a prompt name lives in.
 */
export function redactPathsIn(config: Record<string, string[]>, tool: string): string[] {
  const paths = new Set<string>();
  for (const [key, declared] of Object.entries(config)) {
    if (matchesPattern(key, tool, "tools")) for (const path of declared) paths.add(path);
  }
  return [...paths];
}

/* ------------------------------ §23.6's two identities ------------------------------ */

/** The two identity spellings one selected catalog member owns. */
export type CatalogIdentity = {
  /** Canonical MCP identity — never rewritten (§20.2). */
  scoped: { service: string; member: string; endpoint: string };
  /** §23.6's hub-local TypeScript path, or null for a family that has none (only tools are
   *  addressed by a generated name). */
  typescript: { path: string | null; source: string | null; diagnostic: string | null } | null;
};

/**
 * One catalog member's two identities. A TypeScript path exists only when BOTH active
 * reservations exist — the service's and the member's — because a path missing either half
 * is not a name any generated program could have been written against.
 *
 * `diagnostics` is `AppResponse.diagnostics`: each sentence already written by
 * `hub-types.aliasDiagnosticMessage` and carrying the subject it is about, so the ones
 * belonging to this member are selected here and never re-worded. `app.typescriptDiagnostics`
 * is the same facts as raw objects and is deliberately not read.
 */
export function catalogIdentity(
  row: AppRow,
  diagnostics: AliasDiagnostic[],
  slug: string,
  family: RoleFamily,
  member: string,
  endpoint: string,
): CatalogIdentity {
  const scoped = { service: slug, member, endpoint };
  if (family !== "tools") return { scoped, typescript: null };
  const service = row.typescriptReservations.find(
    (reservation) => reservation.active && reservation.family === "service" && reservation.canonicalName === slug,
  );
  const tool = row.typescriptReservations.find(
    (reservation) => reservation.active && reservation.family === "tool" && reservation.canonicalName === member,
  );
  const mine = diagnostics.filter(
    (entry) =>
      (entry.family === "service" && entry.canonicalName === slug) ||
      (entry.family === "tool" && entry.canonicalName === member),
  );
  const both = service !== undefined && tool !== undefined;
  return {
    scoped,
    typescript: {
      path: both ? `mcp.${service.typescriptName}.${tool.typescriptName}` : null,
      source: !both ? null : service.source === tool.source ? service.source : `service ${service.source} · tool ${tool.source}`,
      diagnostic: mine.length === 0 ? null : mine.map((entry) => entry.message).join(" "),
    },
  };
}

/** §3's scoped MCP endpoint for one app — the only URL a resource of it is served on. The
 *  origin is the caller's, so a preview renders the same string the deployed hub would. */
export function scopedEndpoint(origin: string, username: string, slug: string): string {
  return `${origin}/${encodeURIComponent(username)}/mcp/${encodeURIComponent(slug)}`;
}
