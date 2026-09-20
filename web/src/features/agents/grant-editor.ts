/**
 * The grant editor over one (grant set × app catalog) pair: the reach line's three numbers,
 * the listing groups, the pattern offer, and the family reads they are built from.
 *
 * A port of `server/src/pages/model.ts`'s `grantEditorOf` (`:3096-3283`) and the four family
 * reads `appPaneView` made around it. ONE builder for BOTH pages that edit a set —
 * `/agents/<slug>/apps/<app>` and `/apps/<slug>/access` with an agent selected — because §6
 * makes the second the first "verbatim", and two builders would be two listings that drift.
 *
 * `grantEditorOf` is pure over the views it is handed: the caller reads the catalogs and
 * this decides nothing about which app it is looking at.
 */

import { useQueries, useQuery } from "@tanstack/react-query";
import { BUILTIN_ROLE } from "@/lib/paths";
import { useApi } from "@/lib/api-context";
import { appCapabilitiesQuery, appCatalogQuery } from "@/lib/queries";
import type {
  CapabilitiesResponse,
  CatalogDerivation,
  CatalogFamily,
  FamilyPatterns,
  ListedItem,
  RoleDeclaration,
  RoleFamily,
} from "@/lib/types";
import {
  isLiteralPattern,
  itemEntry,
  grantEntryOf,
  reachabilityFor,
  ROLE_FAMILIES,
  spelledOf,
} from "./door";
import type { ParsedEntry, Reach } from "./door";
import type {
  AgentListGroup,
  AgentListRow,
  AgentPatternOffer,
  FamilyReach,
  GrantChoice,
  RowControl,
  RowProse,
} from "./GrantRows";

/**
 * One §20.3 family as the editor may find it. The five states are not decoration: an UNREAD
 * family is not an empty one (`gateway.ownerCatalog` exists on the server to keep those two
 * answers apart), and a save over an unread family must change no literal in it — which is
 * only safe because the draft carries the whole stored set.
 *
 * The listed arm's `derived` is optional so that `app-detail`'s own `FamilyView` — which
 * always carries it — is assignable here without a conversion.
 */
export type GrantFamilyView =
  | { state: "listed"; items: ListedItem[]; derived?: CatalogDerivation[] }
  | { state: "unread" }
  | { state: "undeclared" }
  | { state: "unconnected" }
  | { state: "pending" };

/** The pair's whole entry set as the editor holds it while being edited: entry string → the
 *  mode it will be saved with. `none` is a real value and means "not in the set" — it has to
 *  be, because a row the owner just lowered must render at `none` rather than vanish. */
export type GrantDraft = Record<string, GrantChoice>;

/** The stored set as a draft. Every entry the pair holds, spelled exactly as stored. */
export function draftOf(savedSpelled: string[]): GrantDraft {
  const draft: GrantDraft = {};
  for (const spelled of savedSpelled) {
    const entry = grantEntryOf(spelled);
    draft[entry.entry] = entry.mode;
  }
  return draft;
}

/* ------------------------------ the four reads ------------------------------ */

/** §20.2's four catalogs, in the order the two grant families need them. `resources` and
 *  `resourceTemplates` are one keyspace and are joined below. */
const CATALOG_FAMILIES: readonly CatalogFamily[] = ["tools", "prompts", "resources", "resourceTemplates"];

/** Which capability declares each catalog: a resource TEMPLATE rides the `resources`
 *  capability, which is why there are four reads behind three families. */
const CAPABILITY_OF: Record<CatalogFamily, "tools" | "prompts" | "resources"> = {
  tools: "tools",
  prompts: "prompts",
  resources: "resources",
  resourceTemplates: "resources",
};

/**
 * One app's three GRANT families, read for an editor: the capability set, then a catalog per
 * advertised family, joined into §20.3's keyspaces.
 *
 * The four reads are GATED on the family state rule, so an undeclared or never-connected
 * family issues no request at all: the state is a reading of the capability answer, not of a
 * catalog that was never going to be listed.
 *
 * Any catalog failure reads as `unread`, which is what the server's `ownerCatalog` answered
 * for one (`answered.ok ? listed : unread`) — the family could not be read, and that is a
 * different fact from its being empty whatever the reason underneath.
 */
export function useGrantFamilies(
  slug: string,
  /** Whether this app is one the editor may read at all. False leaves every family
   *  `pending` and issues NO request — the page that knows the app is not this owner's, or
   *  is archived with nothing granted on it, renders its own not-found instead, and asking
   *  for its catalogs first would be a round trip made to be thrown away. */
  enabled = true,
): {
  views: Record<RoleFamily, GrantFamilyView>;
  /** The advertised set, or null while it is still being read. */
  capabilities: CapabilitiesResponse | null;
  /** Whether any of the five reads is in flight behind data already on screen. */
  refreshing: boolean;
} {
  const api = useApi();
  const capabilities = useQuery({ ...appCapabilitiesQuery(api, slug), enabled });
  const advertised = capabilities.data;
  const catalogs = useQueries({
    queries: CATALOG_FAMILIES.map((family) => ({
      ...appCatalogQuery(api, slug, family),
      enabled:
        enabled &&
        advertised !== undefined &&
        !advertised.neverConnected &&
        advertised.capabilities.includes(CAPABILITY_OF[family]),
    })),
  });

  const viewOf = (index: number): GrantFamilyView => {
    if (advertised === undefined) return { state: "pending" };
    if (advertised.neverConnected) return { state: "unconnected" };
    if (!advertised.capabilities.includes(CAPABILITY_OF[CATALOG_FAMILIES[index] as CatalogFamily])) {
      return { state: "undeclared" };
    }
    const query = catalogs[index];
    if (query === undefined || query.isPending) return { state: "pending" };
    if (query.isError) return { state: "unread" };
    const answer = query.data;
    return answer === undefined
      ? { state: "pending" }
      : { state: "listed", items: answer.items, derived: answer.derived };
  };

  return {
    views: {
      tools: viewOf(0),
      prompts: viewOf(1),
      resources: joinViews(viewOf(2), viewOf(3)),
    },
    capabilities: advertised ?? null,
    refreshing:
      (capabilities.isFetching && !capabilities.isPending) ||
      catalogs.some((query) => query.isFetching && !query.isPending),
  };
}

/** Two reads of one keyspace as one family view (§3's resources-and-templates group). A half
 *  that could not be read makes the whole view unread: an unread count is not an empty set,
 *  and a group that listed one half would claim the other half is empty. */
function joinViews(a: GrantFamilyView, b: GrantFamilyView): GrantFamilyView {
  if (a.state === "unread" || b.state === "unread") return { state: "unread" };
  if (a.state === "listed" || b.state === "listed") {
    return {
      state: "listed",
      items: [...(a.state === "listed" ? a.items : []), ...(b.state === "listed" ? b.items : [])],
      derived: [...(a.state === "listed" ? a.derived ?? [] : []), ...(b.state === "listed" ? b.derived ?? [] : [])],
    };
  }
  if (a.state === "pending" || b.state === "pending") return { state: "pending" };
  return a;
}

/* ------------------------------ the derivations ------------------------------ */

/** The listing's headings, in the order §13 pins them. */
const FAMILY_TITLE: Record<RoleFamily, string> = { tools: "Tools", prompts: "Prompts", resources: "Resources" };

/** §20.3's three keyspaces, as the `?sel=` prefix and the entry prefix name them. */
export const KIND_OF_FAMILY: Record<RoleFamily, string> = {
  tools: "tool",
  prompts: "prompt",
  resources: "resource",
};

/** …read backwards, for a `?sel=<kind>:<name>` the URL carried. */
export const FAMILY_OF_KIND: Record<string, RoleFamily | undefined> = {
  tool: "tools",
  prompt: "prompts",
  resource: "resources",
};

/** A catalog item's own subject string: a name in two families, a URI in the third (§20.3 —
 *  grants match resources by URI, never by name). */
export function subjectOf(item: ListedItem, family: RoleFamily): string {
  return family === "resources" ? item.uri ?? item.uriTemplate ?? "" : item.name ?? "";
}

/**
 * A catalog item's one-line description, as the hub rendered it.
 *
 * App prose is untrusted and `pages/markdown.ts` is the only thing in the system allowed to
 * turn it into markup, so the rendered forms arrive on the wire (`CatalogDerivation.
 * description`) and this only picks one. A resource's line is its MEDIA TYPE instead — which
 * is what the board prints under a URI, and which is not prose at all, so it stays text.
 *
 * A family whose derivation is missing its row (a listing the server answered before this
 * field existed, or a subject the two arrays disagree about) reads as no description rather
 * than as raw source: printing unrendered Markdown would be the one thing the wire rendering
 * exists to prevent.
 */
export function itemProse(
  item: ListedItem,
  family: RoleFamily,
  derived: CatalogDerivation | undefined,
): RowProse {
  if (family === "resources") return { html: null, text: item.mimeType ?? "" };
  const prose = derived?.description;
  return prose === undefined ? { html: null, text: "" } : { html: prose.inline, text: prose.text };
}

/** One listed family's derivation for one subject, or undefined. */
export function derivationOf(view: GrantFamilyView, subject: string): CatalogDerivation | undefined {
  return view.state === "listed" ? view.derived?.find((each) => each.subject === subject) : undefined;
}

/** What the whole editor computes, in one value, so the listing, the reach line, the level
 *  header and the details column all read the same answers. */
export type GrantEditor = {
  /** The set as RENDERED: the draft's entries that are not `none`. */
  entries: ParsedEntry[];
  /** The filter text, trimmed. */
  q: string;
  reach: Record<RoleFamily, FamilyReach>;
  /** Subject key (`<family>::<subject>`) → what the whole set grants it and which entries
   *  said so. The details column reads it for one subject. */
  standing: Map<string, { mode: "allow" | "approval" | null; hits: Reach[] }>;
  /** Entry → the subjects it matches, per family — the details card's "Matches today". */
  matchedNames: Map<string, Record<RoleFamily, string[]>>;
  /** Entry → how many subjects it matches at all, which is every row's `matches N`. */
  matchCount: Map<string, number>;
  groups: AgentListGroup[];
  offer: AgentPatternOffer | null;
  /** The filter matched nothing it could match — and the Patterns group, which the filter
   *  never touches, does not answer for it. */
  nothingMatches: boolean;
  /** The STORED set's two counts, which is what `saved · N allow · M ask` means. */
  saved: { allow: number; approval: number };
};

export function grantEditorOf(args: {
  app: string;
  /** The declaration the DOOR resolves against — `effectiveRolesOf` on both pages. */
  roles: RoleDeclaration;
  views: Record<RoleFamily, GrantFamilyView>;
  /** The pair's stored set, for the `saved · …` line alone. */
  savedSpelled: string[];
  /** The set being edited. */
  draft: GrantDraft;
  q: string;
  /** Offer typed text as a pattern entry — the agent page's filter does; the app page's
   *  Agents details has no filter, so there is nothing to offer (§6). */
  offerPattern: boolean;
}): GrantEditor {
  const { app: appSlug, views, draft, q } = args;
  const saved = args.savedSpelled.map(grantEntryOf);
  // The set the pane RENDERS is the draft's own, so a refused save redraws the owner's
  // choices rather than the stored state they tried to replace — which is what the server's
  // `submitted` arm did with a 400 re-render.
  const entries: ParsedEntry[] = [];
  for (const [entry, choice] of Object.entries(draft)) {
    if (choice === "none") continue;
    entries.push(grantEntryOf(spelledOf({ entry, mode: choice })));
  }

  // ONE door per entry, built once: keyed BY the entry, so `reach(subject, family)` comes
  // back naming exactly the entries that match that subject and the mode each carries. Every
  // number on this pane is read off these answers, so the page cannot disagree with the door
  // about any of them.
  const doors = reachabilityFor(
    args.roles,
    Object.fromEntries(entries.map((entry) => [entry.entry, [spelledOf(entry)]])),
  );
  const matchCount = new Map<string, number>();
  const matchedNames = new Map<string, Record<RoleFamily, string[]>>();
  const reach: Record<RoleFamily, FamilyReach> = {
    tools: { reached: 0, total: 0, approval: 0 },
    prompts: { reached: 0, total: 0, approval: 0 },
    resources: { reached: 0, total: 0, approval: 0 },
  };
  const standing = new Map<string, { mode: "allow" | "approval" | null; hits: Reach[] }>();
  for (const family of ROLE_FAMILIES) {
    const view = views[family];
    if (view.state !== "listed") continue;
    for (const item of view.items) {
      const subject = subjectOf(item, family);
      const hits = doors.reach(subject, family);
      const mode = hits.length === 0 ? null : hits.some((hit) => hit.mode === "allow") ? "allow" : "approval";
      standing.set(`${family}::${subject}`, { mode, hits });
      reach[family].total += 1;
      if (mode !== null) reach[family].reached += 1;
      if (mode === "approval") reach[family].approval += 1;
      for (const hit of hits) {
        matchCount.set(hit.agent, (matchCount.get(hit.agent) ?? 0) + 1);
        const names = matchedNames.get(hit.agent) ?? { tools: [], prompts: [], resources: [] };
        names[family].push(subject);
        matchedNames.set(hit.agent, names);
      }
    }
  }

  const needle = q.toLowerCase();
  const hit = (name: string, description: string): boolean =>
    needle === "" || name.toLowerCase().includes(needle) || description.toLowerCase().includes(needle);

  const modeOf = new Map(entries.map((entry) => [entry.entry, entry.mode]));
  const controlFor = (entry: string, hits: Reach[]): RowControl => {
    const others = hits.filter((each) => each.agent !== entry);
    return {
      entry,
      value: modeOf.get(entry) ?? "none",
      implied: others.length === 0 ? null : others.some((each) => each.mode === "allow") ? "allow" : "approval",
      impliedBy: others.map((each) => each.agent),
    };
  };

  const groups: AgentListGroup[] = [];

  // Roles, then the held role names the app does not declare — the board keeps those
  // immediately under the declared ones rather than in a heading of their own, because they
  // are the same kind of entry in a state the app can end at any connect.
  const declared = Object.keys(args.roles);
  const roleNames = [...declared, BUILTIN_ROLE].filter((role) => hit(role, ""));
  if (roleNames.length > 0) {
    groups.push({
      title: "Roles",
      count: String(roleNames.length),
      // No note: this group holds the EFFECTIVE roles — the app's declaration, the owner's
      // own, and the built-in `all` — so any one provenance named here would be wrong about
      // the rest of the rows under it.
      note: "",
      state: null,
      rows: roleNames.map((role) => ({
        kind: "role" as const,
        entry: role,
        builtin: role === BUILTIN_ROLE,
        detail:
          role === BUILTIN_ROLE
            ? `every tool, prompt and resource, present and future · matches ${matchCount.get(role) ?? 0}`
            : `${patternText(args.roles[role])} · matches ${matchCount.get(role) ?? 0}`,
        sel: `role:${role}`,
        // No implied arm on a role: nothing in the set grants a ROLE, so the three buttons
        // are always live and the checked one is the entry's own mode.
        control: controlFor(role, []),
      })),
    });
  }
  const undeclared = entries.filter(
    (entry) => entry.kind === "role" && entry.role !== BUILTIN_ROLE && !declared.includes(entry.role),
  );
  if (undeclared.length > 0) {
    groups.push({
      title: "",
      count: "",
      note: "",
      state: null,
      rows: undeclared.map((entry) => ({
        kind: "undeclared" as const,
        entry: entry.entry,
        standing: entry.mode,
      })),
    });
  }

  // What the filter hides must still be COUNTED as filterable, because `Nothing matches` is a
  // statement about the rows a filter can reach.
  let filterable = roleNames.length;
  for (const family of ROLE_FAMILIES) {
    const view = views[family];
    const state = familyNote(view, appSlug, FAMILY_TITLE[family]);
    const rows =
      view.state === "listed"
        ? view.items
            .map((item) => ({ item, derived: derivationOf(view, subjectOf(item, family)) }))
            // FILTER on the un-marked-up form, so a needle cannot hit a delimiter the reader
            // never saw; then map, because mapping is what registers a control as drawn.
            .filter(({ item, derived }) =>
              hit(subjectOf(item, family), itemProse(item, family, derived).text),
            )
            .map(({ item, derived }) => itemRow(item, family, derived, standing, modeOf, controlFor))
        : [];
    filterable += rows.length;
    if (state === null && rows.length === 0) continue;
    groups.push({
      title: FAMILY_TITLE[family],
      count: state === null ? String(rows.length) : "",
      note:
        state !== null
          ? ""
          : family === "tools"
            ? `${reach.tools.reached} reached · ${reach.tools.total - reach.tools.reached} not`
            : family === "resources"
              ? "matched by URI"
              : "",
      state,
      rows,
    });
  }

  // The entries that are not one item: their own group, kept whatever the filter says,
  // because a pattern has no name to filter on and hiding it would hide what it grants.
  const patterns = entries.filter(
    (entry) => entry.kind === "item" && !isLiteralPattern(entry.pattern, entry.family),
  );
  if (patterns.length > 0) {
    groups.push({
      title: "Patterns",
      count: String(patterns.length),
      note: "entries that are not one item",
      state: null,
      rows: patterns.map((entry) => {
        const matches = matchCount.get(entry.entry) ?? 0;
        return {
          kind: "pattern" as const,
          entry: entry.entry,
          detail: matches === 0 ? "matches nothing today" : `matches ${matches} today`,
          dormant: matches === 0,
          sel: `pattern:${entry.entry}`,
          control: controlFor(entry.entry, []),
        };
      }),
    });
  }

  const offer = args.offerPattern ? patternOffer(q, entries, args.roles, views) : null;
  return {
    entries,
    q,
    reach,
    standing,
    matchedNames,
    matchCount,
    groups,
    offer,
    nothingMatches: q !== "" && offer === null && filterable === 0,
    saved: {
      allow: saved.filter((entry) => entry.mode === "allow").length,
      approval: saved.filter((entry) => entry.mode === "approval").length,
    },
  };
}

function itemRow(
  item: ListedItem,
  family: RoleFamily,
  derived: CatalogDerivation | undefined,
  standing: Map<string, { mode: "allow" | "approval" | null; hits: Reach[] }>,
  modeOf: Map<string, "allow" | "approval">,
  controlFor: (entry: string, hits: Reach[]) => RowControl,
): AgentListRow & { kind: "item" } {
  const name = subjectOf(item, family);
  const entry = itemEntry(family, name);
  const hits = standing.get(`${family}::${name}`)?.hits ?? [];
  const control = controlFor(entry, hits);
  const direct = modeOf.get(entry);
  return {
    kind: "item",
    entry,
    name,
    description: itemProse(item, family, derived),
    via: control.impliedBy,
    alsoVia: direct !== undefined,
    // A direct ask under something that already allows: allow wins (§7), so the entry is
    // kept and badged rather than silently dropped — it is the owner's, and only they should
    // remove it.
    noEffect: direct === "approval" && control.implied === "allow",
    sel: `${KIND_OF_FAMILY[family]}:${name}`,
    control,
  };
}

/** A role's patterns, per family, as the row prints them — `tools a, b · prompts c`. */
export function patternText(patterns: string[] | FamilyPatterns | undefined): string {
  if (patterns === undefined) return "no patterns";
  if (Array.isArray(patterns)) return `tools ${patterns.join(", ")}`;
  return ROLE_FAMILIES.filter((family) => (patterns[family] ?? []).length > 0)
    .map((family) => `${family} ${(patterns[family] ?? []).join(", ")}`)
    .join(" · ");
}

/** A role declaration's patterns as `[family, patterns]` pairs — the bare-array spelling is
 *  §20.3's tools-only shorthand, expanded here so the card has one shape to draw. */
export function familyEntries(patterns: string[] | FamilyPatterns | undefined): [string, string[]][] {
  if (patterns === undefined) return [];
  if (Array.isArray(patterns)) return [["tools", patterns]];
  return ROLE_FAMILIES.filter((family) => (patterns[family] ?? []).length > 0).map((family) => [
    family,
    patterns[family] ?? [],
  ]);
}

/** One family's non-list answer as the ONE note line that stands in for its rows — the same
 *  states /apps/<slug> distinguishes, said here in one sentence each. A family still being
 *  read says so rather than claiming one of the other four. */
function familyNote(view: GrantFamilyView, app: string, title: string): string | null {
  if (view.state === "unconnected") return `${app} has not connected yet — nothing to list until it does.`;
  if (view.state === "undeclared") return `${title} is not advertised.`;
  if (view.state === "unread") return `${title} could not be read just now.`;
  if (view.state === "pending") return `Reading ${title.toLowerCase()}…`;
  return null;
}

/**
 * The typed filter text offered as a pattern entry. Offered only when the text is not one
 * item's own name — anything else is a filter over the rows already on screen — and never
 * when the set already holds the entry it would add.
 */
function patternOffer(
  q: string,
  entries: ParsedEntry[],
  declared: RoleDeclaration,
  views: Record<RoleFamily, GrantFamilyView>,
): AgentPatternOffer | null {
  if (q === "") return null;
  const family: RoleFamily = q.includes("://") ? "resources" : "tools";
  if (isLiteralPattern(q, family)) return null;
  const entry = itemEntry(family, q);
  if (entries.some((held) => held.entry === entry)) return null;
  const door = reachabilityFor(declared, { offer: [entry] });
  const view = views[family];
  const matches =
    view.state === "listed"
      ? view.items.filter((item) => door.reach(subjectOf(item, family), family).length > 0).length
      : 0;
  return {
    entry,
    detail: matches === 0 ? "matches nothing today" : `would match ${matches} today, and any added later`,
  };
}

/** One family's `T · R reached by <agent>` pair for the details column's Catalog card. */
export function familyCount(
  view: GrantFamilyView,
  standing: Map<string, { mode: "allow" | "approval" | null; hits: Reach[] }>,
  family: RoleFamily,
): FamilyReach {
  if (view.state !== "listed") return { reached: 0, total: 0, approval: 0 };
  let reached = 0;
  let approval = 0;
  for (const item of view.items) {
    const mode = standing.get(`${family}::${subjectOf(item, family)}`)?.mode ?? null;
    if (mode !== null) reached += 1;
    if (mode === "approval") approval += 1;
  }
  return { reached, total: view.items.length, approval };
}
