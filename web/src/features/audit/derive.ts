/**
 * Every reading `/audit` makes of one row set — the whole of the explorer's thinking, with no
 * React, no DOM and no clock of its own.
 *
 * PURE, and that is a contract rather than a style: `server/test/unit/audit-derive.test.ts`
 * imports this module into the `unit` project, which is plain Node with the repo's ROOT
 * tsconfig — a program with no `@/` path mapping. So every import here is relative and
 * type-only, and nothing in this file touches `window`, `Date.now()` or a component. The
 * instant a rule needs is always a parameter.
 *
 * What lives here and not in a view: the outcome classes, the URL codec, the filters, the
 * facet counts, the lanes, the merge, the sessions, the waterfall fold, the insights, the
 * export href, and the few strings whose exact spelling §13 pins. A view draws what these
 * answer and decides nothing.
 */

import type { AuditWindowRow, BodyStub, NoBodiesReason } from "../../lib/types";

/* ------------------------------------------------------------ the classes ---- */

/**
 * §13's five classes over the six recorded `outcome` values. A class is the PAGE's grouping
 * and nothing below it: `audit_query`'s own filter takes the raw recorded value, which is why
 * `outcomeCodes` exists and why the record's field table prints the raw code beside the class.
 *
 * In rank order, worst last — the lane strip reads this array as its ranking, so "worst
 * outcome in the hour" and "the legend's order" cannot disagree.
 */
export const OUTCOME_CLASSES = ["ok", "approval", "archived", "denied", "error"] as const;

export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

/** Raw recorded outcome → its class. `denied` folds two codes (§5's `-32001` and `-32000`). */
const CLASS_OF: Record<string, OutcomeClass> = {
  ok: "ok",
  "-32003": "approval",
  "-32002": "archived",
  "-32001": "denied",
  "-32000": "denied",
  error: "error",
};

/** The inverse, for the export link: a class back to the raw codes `audit_query` takes. */
const CODES_OF: Record<OutcomeClass, readonly string[]> = {
  ok: ["ok"],
  approval: ["-32003"],
  archived: ["-32002"],
  denied: ["-32001", "-32000"],
  error: ["error"],
};

/**
 * Which class a recorded outcome belongs to. A value this table has never seen reads as
 * `error` rather than throwing: a row the page cannot classify is still a row somebody has to
 * look at, and a thrown exception would take the whole window down with it.
 */
export function outcomeClass(outcome: string): OutcomeClass {
  return CLASS_OF[outcome] ?? "error";
}

/** A class as the raw codes the export filter takes; anything else passes through, so a
 *  hand-edited `?outcome=` still exports something. */
export function outcomeCodes(cls: string): readonly string[] {
  return CODES_OF[cls as OutcomeClass] ?? [cls];
}

/* ------------------------------------------------- a code never stands alone ---- */

/**
 * What each recorded outcome MEANS, in the hub's own §7 words — a label everywhere, and for the
 * four refusals and `error` a sentence as well.
 *
 * The rule this table exists for, in the owner's words: "I literally won't know what -32001 is,
 * it's not like 404." A JSON-RPC code is an implementation detail of the wire, and a page that
 * prints one bare is a page that answers "why did this fail?" with a number to go and look up.
 * So the raw code is printed in exactly ONE place — the record's outcome row, beside its label,
 * because that is the value `pmcp audit --outcome` and the export take — and everywhere else
 * the words stand on their own.
 *
 * Both live here rather than in a component because three surfaces say them (the record, the
 * legend, the waterfall) and a fourth wording would be a fourth account of the same refusal.
 */
const OUTCOME_WORDS: Record<string, { label: string; sentence?: string }> = {
  ok: { label: "ok" },
  "-32003": {
    label: "approval required",
    sentence:
      "This tool needs your approval for this agent. The call was held, not run — it waits on, or was settled in, Approvals.",
  },
  "-32002": {
    label: "app archived",
    sentence: "The app is archived, so the hub dispatches nothing to it.",
  },
  "-32001": {
    label: "not permitted",
    // Both named causes, and then "every such case" rather than a count: §7 answers THREE
    // indistinguishable sources the same way, so the ledger cannot tell them apart and the
    // sentence must not imply it has enumerated them. Saying only "no grant" would be a guess
    // printed as a fact.
    sentence:
      "The hub refused this call: the agent holds no grant that reaches this tool, or it named an app or tool the hub doesn't know. The hub answers every such case the same way, so the ledger cannot say which.",
  },
  "-32000": {
    label: "app unavailable",
    sentence: "The app could not be reached or did not answer in time.",
  },
  error: {
    label: "error",
    sentence: "The call was dispatched and the app answered with an error.",
  },
};

/** An outcome in words. One the table does not know is labelled by its raw value — which is at
 *  least the truth, where a made-up label would not be. */
export function outcomeLabel(outcome: string): string {
  return OUTCOME_WORDS[outcome]?.label ?? outcome;
}

/**
 * What the record's outcome row PRINTS: the chip's class, and the label and the raw code only
 * where each says something the one before it did not.
 *
 * A word is never printed twice. The chip already carries the class, so `ok` read "ok ok ok"
 * and `error` read "error error error" when all three were printed unconditionally. A refusal
 * is three genuinely different things — the grouping (`denied`), what the hub did (`not
 * permitted`) and the value the export and `pmcp audit --outcome` take (`-32001`) — and prints
 * all three. An outcome the table does not know has no label of its own, so it prints once, as
 * the code: that is where the page sets a raw value in mono.
 *
 * Here rather than in the drawer because the drawer and the phone level are one component's
 * two renderings of it, and because "which of these three is redundant" is a rule with cases.
 */
export function outcomeRow(outcome: string): { cls: OutcomeClass; label: string | null; code: string | null } {
  const cls = outcomeClass(outcome);
  const words = outcomeLabel(outcome);
  // A label that merely repeats the chip, or that IS the raw code, says nothing new.
  const label = words === cls || words === outcome ? null : words;
  // …and the code says nothing new when the line above it already reads the same.
  const code = outcome === (label ?? cls) ? null : outcome;
  return { cls, label, code };
}

/**
 * Why this row ended the way it did, or null where there is nothing to explain: `ok` needs no
 * sentence, and an outcome the table does not know gets none rather than a wrong one.
 *
 * A `-32000` that recorded a `failureClass` appends it as a cause. That class is the only thing
 * the ledger knows about WHY the app was unreachable, so it is said here rather than left in
 * the Detail tree for the reader to find.
 */
export function outcomeSentence(row: Pick<AuditWindowRow, "outcome" | "detail">): string | null {
  const sentence = OUTCOME_WORDS[row.outcome]?.sentence;
  if (sentence === undefined) return null;
  const cause = row.detail?.failureClass;
  return typeof cause === "string" && cause !== "" ? `${sentence} Cause: ${cause}.` : sentence;
}

/* --------------------------------------------------------------- the URL ---- */

/** The three readings of one filtered set. Switching one never refetches and never changes
 *  what matches (§13). */
export type AuditView = "summary" | "sessions" | "events";

/**
 * Every key that filters, as the URL spells it. `session` is among them and is deliberately
 * NOT in `FACET_FIELDS`: it is set from a record, never browsed — there are too many session
 * ids to list, and a facet group of them would be a scrolling wall.
 */
export const FILTER_FIELDS = ["outcome", "principal", "app", "tool", "event", "session"] as const;

export type FilterField = (typeof FILTER_FIELDS)[number];

/** The five groups the rail lists, in rail order. */
export const FACET_FIELDS = ["outcome", "principal", "app", "tool", "event"] as const;

export type FacetField = (typeof FACET_FIELDS)[number];

/** How many values a group shows before **Show all N** (§3: six for the two long tails). */
export const FACET_TOP: Record<FacetField, number> = {
  outcome: 5,
  principal: 5,
  app: 5,
  tool: 6,
  event: 6,
};

/** One active filter. A `tool` value is spelled `<app>/<tool>` — the facet names a tool by its
 *  app, so two apps' `search` are two values — and is split again for the export link. */
export type Filter = { field: FilterField; value: string };

/**
 * The page's whole state, read off the URL and written back to it.
 *
 * `since`/`until` are the BRUSH and are always a real window: they fall back to the loaded
 * window's own bounds, so every consumer can compare against them without a null check.
 * `brushed` is how you tell the fallback from a deliberate selection of the same span — the
 * `7d` preset on a seven-day retention selects the whole window and must still light up.
 */
export type AuditSelection = {
  view: AuditView;
  /** Epoch ms, inclusive. */
  since: number;
  /** Epoch ms, inclusive. */
  until: number;
  brushed: boolean;
  filters: Filter[];
  /** The search box's text, verbatim — sent to the server as `text`, matched case-insensitively. */
  q: string;
  /** The open record's row id, as a string (a URL carries no numbers). */
  expand: string | null;
  /** The open session in Sessions. */
  open: string | null;
};

/** The search bag a route hands over: every value a string or repeated strings, `router.tsx`'s
 *  contract. Spelled here rather than imported so this module stays free of `@/`. */
export type SearchBag = Record<string, string | string[] | undefined>;

/** The loaded window, as the window read echoed it. */
export type LoadedWindow = { start: number; end: number };

const HOUR_MS = 3_600_000;

/** `?range=` as hours back from the window's end. `30d` is the readable spelling of "all of
 *  it" and is therefore NOT a brush, which is why it maps to null rather than to 720. */
const RANGE_HOURS: Record<string, number | null> = { "1h": 1, "24h": 24, "7d": 7 * 24, "30d": null };

/**
 * The URL as state. Every unreadable value falls back rather than refusing: these are read
 * controls on an address somebody may have edited or bookmarked years ago, and the answer to a
 * stale key is the page, not an error.
 *
 * `window` is the read's own echoed bounds, so the client never computes "now" twice.
 */
export function selectionOf(search: SearchBag, window: LoadedWindow): AuditSelection {
  const view = one(search, "view");
  const filters: Filter[] = [];
  for (const field of FILTER_FIELDS) {
    for (const value of many(search, field)) {
      const normalised = field === "outcome" ? classOfFilterValue(value) : value;
      if (normalised === null) continue;
      if (!filters.some((held) => held.field === field && held.value === normalised)) {
        filters.push({ field, value: normalised });
      }
    }
  }
  return {
    view: view === "sessions" || view === "events" ? view : "summary",
    ...brushOf(search, window),
    filters,
    q: one(search, "q") ?? "",
    expand: one(search, "expand") ?? null,
    open: one(search, "open") ?? null,
  };
}

/** `since`/`until` first, then `?range=`, then the whole window. Epoch ms in both spellings —
 *  `?range=` is only ever a readable name for a window ending where the loaded one does. */
function brushOf(search: SearchBag, window: LoadedWindow): Pick<AuditSelection, "since" | "until" | "brushed"> {
  const since = msOf(one(search, "since"));
  const until = msOf(one(search, "until"));
  if (since !== null || until !== null) {
    return { since: since ?? window.start, until: until ?? window.end, brushed: true };
  }
  const hours = RANGE_HOURS[one(search, "range") ?? ""];
  if (hours !== null && hours !== undefined) {
    return { since: window.end - hours * HOUR_MS, until: window.end, brushed: true };
  }
  return { since: window.start, until: window.end, brushed: false };
}

/** An `?outcome=` value as a class: a class name as it stands, a RAW recorded code folded to
 *  its class (so the export's own spelling still opens the page), anything else dropped. */
function classOfFilterValue(value: string): OutcomeClass | null {
  if ((OUTCOME_CLASSES as readonly string[]).includes(value)) return value as OutcomeClass;
  return CLASS_OF[value] ?? null;
}

/**
 * The selection back as a search bag — the inverse of `selectionOf`, so a navigation writes
 * exactly what the next read will parse.
 *
 * A default is OMITTED rather than written: `view=summary`, an unbrushed window and an empty
 * search box all leave no key, which is what keeps a shared link short and keeps `?range=`
 * from being rewritten into two timestamps behind the reader's back.
 */
export function searchOf(selection: AuditSelection): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (selection.view !== "summary") out.view = selection.view;
  if (selection.brushed) {
    out.since = String(Math.round(selection.since));
    out.until = String(Math.round(selection.until));
  }
  for (const field of FILTER_FIELDS) {
    const values = selection.filters.filter((each) => each.field === field).map((each) => each.value);
    if (values.length > 0) out[field] = values;
  }
  if (selection.q !== "") out.q = selection.q;
  if (selection.expand !== null) out.expand = selection.expand;
  if (selection.open !== null) out.open = selection.open;
  return out;
}

/** Toggling one facet value — the rail, a top-N bar and an id button all do exactly this, and
 *  a second copy of "is it already on" is a second chance for them to disagree. */
export function toggleFilter(filters: Filter[], field: FilterField, value: string): Filter[] {
  const at = filters.findIndex((each) => each.field === field && each.value === value);
  return at < 0 ? [...filters, { field, value }] : filters.filter((_, index) => index !== at);
}

/**
 * The export link: the same read, serialized (§2 — never a second capability).
 *
 * Two translations happen here and nowhere else, which is why the href is derived rather than
 * assembled at the call site.
 *
 * An outcome CLASS becomes its raw codes, because `denied` folds two and the export filter
 * takes recorded values.
 *
 * A `tool` value travels WHOLE, as `target=<app>/<tool>`, and is never split into an `app=`
 * and a `tool=`: splitting two selected pairs would export their CROSS PRODUCT — pick
 * `news/get_news` and `notion/search` and the lists `app=news&app=notion&tool=get_news&
 * tool=search` also match `news/search`, which the page never selected.
 *
 * The brush is omitted when it is the whole window: the export's own default is the whole
 * retention window, so writing it out would pin a link to the instant it was copied.
 *
 * No client-side guard on the size of the selection: the route answers 400 for a malformed
 * `target` and 400 past its own bound, so this stays a plain link.
 *
 * The path is §2's unchanged one — a bookmark must not break — and it is written HERE rather
 * than beside the other URLs in `lib/paths.ts` so the one literal sits in the module the unit
 * test covers; `paths.ts` holds no second spelling of it.
 */
export const AUDIT_EXPORT_PATH = "/audit/export.jsonl";

export function exportHref(selection: AuditSelection): string {
  const params = new URLSearchParams();
  if (selection.brushed) {
    params.set("since", String(Math.round(selection.since)));
    params.set("until", String(Math.round(selection.until)));
  }
  if (selection.q !== "") params.set("text", selection.q);
  for (const filter of selection.filters) {
    if (filter.field === "outcome") {
      for (const code of outcomeCodes(filter.value)) params.append("outcome", code);
    } else if (filter.field === "tool") {
      params.append("target", filter.value);
    } else {
      params.append(filter.field, filter.value);
    }
  }
  const query = params.toString();
  return query === "" ? AUDIT_EXPORT_PATH : `${AUDIT_EXPORT_PATH}?${query}`;
}

/**
 * One page of the window read, as a path under `/api/hub`.
 *
 * THE INVARIANT: page 0 asks with its window open and the server resolves and ECHOES one —
 * every later page must then be pinned to that echoed pair. Left open, each request resolves a
 * fresh `until = now`, so a single row written between two requests shifts every later offset
 * by one and the concatenated result carries a duplicate at each page seam (and, drawn, a
 * duplicate React key with it). This is the whole reason the read echoes its window.
 *
 * `text` is the search box under the read's own name for it; blank sends no key at all, since
 * an empty `LIKE` is a scan that matches everything.
 */
export function windowPagePath(page: { offset: number; text: string; since?: number; until?: number }): string {
  const params = new URLSearchParams({ offset: String(page.offset) });
  const text = page.text.trim();
  if (text !== "") params.set("text", text);
  if (page.since !== undefined) params.set("since", String(page.since));
  if (page.until !== undefined) params.set("until", String(page.until));
  return `/audit/window?${params.toString()}`;
}

/* ------------------------------------------------------------ what a row is ---- */

/** The three events whose row IS a call, and therefore the three titled by their target
 *  (§13). Everything else — `approval.*`, `admin.*`, `upstream.*` — is titled by its event
 *  name, and an `approval.requested` naming an app and a tool must never read as the call. */
const CALL_EVENTS = ["tools/call", "prompts/get", "resources/read"];

/** Only the three fields a title is made of, so the record drawer can title the FULL row it
 *  fetched with the same function that titles the slim rows in the list. */
type Titleable = Pick<AuditWindowRow, "event" | "app" | "tool">;

/** `<app>/<tool>`, or the app alone, or nothing — what a row points AT. */
export function targetOf(row: Titleable): string | null {
  if (row.app === undefined) return null;
  return row.tool === undefined ? row.app : `${row.app}/${row.tool}`;
}

/**
 * What a row is called, and what goes dim beside it. A call wears its target as the title; every
 * other event wears its own name, with the target as secondary text — so the reader can tell
 * "somebody called news/publish" from "somebody asked to".
 */
export function titleOf(row: Titleable): { title: string; secondary: string | null } {
  const target = targetOf(row);
  // A CALL without a tool is not a call anybody can name — a `resources/read` row that recorded
  // no target reads as its event, with the app beside it, like every other event.
  if (CALL_EVENTS.includes(row.event) && row.tool !== undefined && target !== null) {
    return { title: target, secondary: null };
  }
  return { title: row.event, secondary: target };
}

/**
 * What a MERGED row is called — `titleOf` with one exception, and the exception is the point.
 *
 * A chain row is the story of a call: "asked → you approved → ran ok" is one thing that
 * happened to `home/set_scene`, so the row is titled by that call whichever event heads it. A
 * chain headed by `approval.requested` and titled `approval.requested` would file the same
 * event under two different names depending on whether the ask was recorded.
 *
 * The RECORD the row opens is the head row's own and keeps the general rule, so the drawer
 * reads `approval.requested` with `home/set_scene` dim beside it. Un-chained rows, waterfall
 * lines, timeline lines and record heads are all `titleOf`.
 */
export function titleOfMerged(merged: MergedRow): { title: string; secondary: string | null } {
  if (merged.kind === "chain") {
    for (const row of merged.group) {
      const target = targetOf(row);
      if (CALL_EVENTS.includes(row.event) && row.tool !== undefined && target !== null) {
        return { title: target, secondary: null };
      }
    }
  }
  return titleOf(merged.head);
}

/** A row's value in one filter group, or null where it has none. `tool` is named by its app,
 *  and `session` reads the client's allowlisted id (§7) — untrusted display data. */
export function filterValueOf(row: AuditWindowRow, field: FilterField): string | null {
  switch (field) {
    case "outcome":
      return outcomeClass(row.outcome);
    case "tool":
      return row.tool === undefined || row.app === undefined ? null : `${row.app}/${row.tool}`;
    case "session":
      return row.client?.sessionId ?? null;
    default:
      return row[field] ?? null;
  }
}

/**
 * Whether a row survives the facets and the search — the BRUSH excluded, because the strip is
 * drawn over the brush rather than dimmed by it, and the rail's counts are "of N in window".
 *
 * `except` is the group whose own filters are ignored: Hearst's exhaustive counts, so ticking
 * one value in a group never zeroes the group's other values and leaves them unreachable.
 */
export function matchesFilters(row: AuditWindowRow, selection: AuditSelection, except?: FilterField): boolean {
  const byField = new Map<FilterField, string[]>();
  for (const filter of selection.filters) {
    if (filter.field === except) continue;
    const held = byField.get(filter.field);
    if (held === undefined) byField.set(filter.field, [filter.value]);
    else held.push(filter.value);
  }
  for (const [field, values] of byField) {
    if (field === "tool") {
      if (!values.some((value) => matchesTool(row, value))) return false;
      continue;
    }
    const value = filterValueOf(row, field);
    if (value === null || !values.includes(value)) return false;
  }
  return true;
}

/**
 * Whether a row matches one `tool` filter value, which has TWO spellings.
 *
 * `news/get_news` is the page's own — the rail names a tool by its app, so two apps' `search`
 * are two values. `get_news`, with no slash, is the legacy deep link the agent and app pages
 * have been emitting since before there was a pair, and it means the tool name ACROSS apps.
 * Both keep working, and neither can be mistaken for the other: a bare tool name has no slash
 * and a pair always does.
 */
function matchesTool(row: AuditWindowRow, value: string): boolean {
  return value.includes("/") ? filterValueOf(row, "tool") === value : row.tool === value;
}

export function inBrush(row: AuditWindowRow, selection: AuditSelection): boolean {
  return row.ts >= selection.since && row.ts <= selection.until;
}

/**
 * The facet set: every loaded row the facets keep, whatever the brush. What the strip is
 * coloured from.
 *
 * `selection.q` is deliberately NOT applied. The loaded rows already ARE the server's answer for
 * that text — `text` is the one filter the read performs, over every string column and both
 * body columns — and the client holds only `argsHead`, so a second pass here could only drop
 * rows the server matched inside a result it never shipped. It would also narrow the PREVIOUS
 * answer by a needle it was never read for while the next read is in flight, which reads as the
 * list emptying as you type.
 */
export function facetRows(rows: AuditWindowRow[], selection: AuditSelection): AuditWindowRow[] {
  return rows.filter((row) => matchesFilters(row, selection));
}

/** The selection: the facet set inside the brush. What all three views read. */
export function selectedRows(rows: AuditWindowRow[], selection: AuditSelection): AuditWindowRow[] {
  return facetRows(rows, selection).filter((row) => inBrush(row, selection));
}

/* ---------------------------------------------------------- the facet rail ---- */

/**
 * One group of the rail. `total` is how many distinct values the group HAS (what **Show all N**
 * names), `max` the busiest count (what a proportional bar is drawn against), and `values` is
 * every one of them, busiest first — the view slices it, so expanding a group in place is a
 * render and not a recount.
 */
export type FacetGroup = {
  field: FacetField;
  values: { value: string; count: number; on: boolean }[];
  total: number;
  max: number;
};

/**
 * Every group's values with their counts, each group counted under every OTHER group's filters
 * plus the window and the search — never its own (`matchesFilters`' `except`).
 *
 * One pass per group over the rows, five groups: O(n) in the design load's 5,000 rows, which is
 * why this is a plain loop and not a generic groupBy over a filtered copy per value.
 */
export function facetGroups(rows: AuditWindowRow[], selection: AuditSelection): FacetGroup[] {
  const groups: FacetGroup[] = [];
  for (const field of FACET_FIELDS) {
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (!inBrush(row, selection)) continue;
      if (!matchesFilters(row, selection, field)) continue;
      const value = filterValueOf(row, field);
      if (value === null) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    if (counts.size === 0) continue;
    const values = [...counts]
      .sort((left, right) => right[1] - left[1])
      .map(([value, count]) => ({
        value,
        count,
        on: selection.filters.some((each) => each.field === field && each.value === value),
      }));
    groups.push({ field, values, total: values.length, max: values[0]?.count ?? 1 });
  }
  return groups;
}

/* ----------------------------------------------------------- the lane strip ---- */

/** A cell's colour: an outcome class, `not-loaded` for an hour the ceiling cut off, or null for
 *  an hour in which nothing matched. Never "empty" where the page simply has no rows. */
export type LaneCell = OutcomeClass | "not-loaded" | null;

/** One lane. `of` is the principals it stands for — one, or every principal past the sixth. */
export type Lane = { name: string; title: string; of: string[]; cells: LaneCell[] };

/** Principals by how much they did, busiest first. The lane order, and the page passes it from
 *  the LOADED rows so a facet never reshuffles the strip under the reader. */
export function principalsByBusiest(rows: AuditWindowRow[]): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.principal, (counts.get(row.principal) ?? 0) + 1);
  return [...counts].sort((left, right) => right[1] - left[1]).map(([principal]) => principal);
}

/** At most this many named lanes; the rest fold into one. Six is what fits above the axis
 *  without the strip becoming the page. */
const LANE_CAP = 6;

/**
 * The strip: one lane per principal, one cell per hour, each cell the WORST outcome in it.
 *
 * `rows` is the facet set — the strip is coloured under the facets and the search, and the
 * brush is drawn ON it rather than removing anything from it.
 */
export function lanesOf(
  rows: AuditWindowRow[],
  opts: {
    /** The window's start, epoch ms — cell 0's left edge. */
    start: number;
    /** How many cells, one per hour of the retention window. */
    hours: number;
    /**
     * The instant before which the page holds NO rows: the oldest loaded row's `ts` when the
     * read hit the ceiling, and the window's own `start` otherwise. Every hour before it draws
     * hatched, because an empty cell would claim nothing happened there.
     */
    oldestLoaded: number;
    /** The lane order, from the loaded rows. Defaults to `rows`' own. */
    principals?: string[];
    /** How many lanes are NAMED before the fold. Defaults to six; the phone passes four,
     *  because a 375px strip divided six ways is a band nobody can read. */
    cap?: number;
  },
): Lane[] {
  const cap = opts.cap ?? LANE_CAP;
  const order = opts.principals ?? principalsByBusiest(rows);
  const named = order.slice(0, cap);
  const rest = order.slice(cap);
  const lanes: Lane[] = named.map((principal) => ({
    name: principal,
    title: principal,
    of: [principal],
    cells: Array.from({ length: opts.hours }, () => null as LaneCell),
  }));
  if (rest.length > 0) {
    lanes.push({
      name: `${rest.length} other${rest.length > 1 ? "s" : ""}`,
      title: rest.join(", "),
      of: rest,
      cells: Array.from({ length: opts.hours }, () => null as LaneCell),
    });
  }

  const laneOf = new Map<string, Lane>();
  for (const lane of lanes) for (const principal of lane.of) laneOf.set(principal, lane);
  // One pass over the rows, each landing in one cell: O(n), which is what keeps the strip
  // affordable at the design load rather than a scan per cell.
  for (const row of rows) {
    const lane = laneOf.get(row.principal);
    if (lane === undefined) continue;
    const hour = Math.floor((row.ts - opts.start) / HOUR_MS);
    if (hour < 0 || hour >= opts.hours) continue;
    const held = lane.cells[hour];
    const cls = outcomeClass(row.outcome);
    if (held === null || held === undefined || rankOf(cls) > rankOf(held)) lane.cells[hour] = cls;
  }

  const notLoadedBefore = Math.max(0, Math.floor((opts.oldestLoaded - opts.start) / HOUR_MS));
  for (const lane of lanes) {
    for (let hour = 0; hour < notLoadedBefore && hour < opts.hours; hour += 1) lane.cells[hour] = "not-loaded";
  }
  return lanes;
}

function rankOf(cell: LaneCell): number {
  return cell === null || cell === "not-loaded" ? -1 : OUTCOME_CLASSES.indexOf(cell);
}

/* ---------------------------------------------------------------- the merge ---- */

/**
 * One row of the Events view: a single event, an approval CHAIN, or a ×N run.
 *
 * `head` is what the row is titled by; `group` is every event it stands for, so the drawer and
 * the chain sentence read one list. `state` is the outcome the row WEARS — a chain's is its
 * last event's, not its head's, because "asked → approved → ran ok" ends ok.
 */
export type MergedRow = {
  kind: "one" | "chain";
  head: AuditWindowRow;
  group: AuditWindowRow[];
  /** How many events the row collapses. 1 unless it is a ×N run. */
  runs: number;
  state: OutcomeClass;
};

/**
 * WHEN a merged row happened — the instant the list is ordered by, and therefore the one the
 * When column must print.
 *
 * A chain is the case this exists for. `mergeEvents` walks newest first, so a chain lands where
 * its NEWEST member was met; but its head is the `approval.requested` row, which is its OLDEST.
 * Printing `head.ts` put an old stamp at a new row's position, and one chain between two plain
 * rows was enough to make a newest-first column read as shuffled (owner, from the searching
 * screenshot). The head still titles the row and is still the record the row opens — only the
 * time changes.
 *
 * A run needs nothing: its head IS the first row met, so already its newest member.
 */
export function whenOf(row: MergedRow): number {
  if (row.kind !== "chain") return row.head.ts;
  return row.group[row.group.length - 1]?.ts ?? row.head.ts;
}

/** Ordering within a chain and a session: by time, then by id. The tiebreaker is not
 *  decoration — a refused `tools/call` and the `approval.requested` it provoked routinely
 *  share a millisecond, and without the id the chain's order would be the reader's luck. */
function byTsThenId(left: AuditWindowRow, right: AuditWindowRow): number {
  return left.ts - right.ts || left.id - right.id;
}

/**
 * Related events as one row, repeats as one row.
 *
 * Two passes, in this order and not the other: rows sharing a `detail.approvalId` (§1) become
 * one chain first, and only then do CONSECUTIVE un-chained rows with the same signature
 * collapse. A chain therefore never joins a run — a run is "the same thing happened again",
 * and one of those things having been approved makes it a different event.
 *
 * `rows` arrive in display order (newest first for Events); the chain's own members are
 * re-sorted oldest first, which is the order its sentence is read in.
 */
export function mergeEvents(rows: AuditWindowRow[]): MergedRow[] {
  const byApproval = new Map<string, AuditWindowRow[]>();
  for (const row of rows) {
    const id = approvalIdOf(row);
    if (id === null) continue;
    const held = byApproval.get(id);
    if (held === undefined) byApproval.set(id, [row]);
    else held.push(row);
  }

  const used = new Set<number>();
  const merged: MergedRow[] = [];
  for (const row of rows) {
    if (used.has(row.id)) continue;
    const id = approvalIdOf(row);
    const siblings = id === null ? undefined : byApproval.get(id);
    if (siblings !== undefined && siblings.length > 1) {
      const group = [...siblings].sort(byTsThenId);
      for (const each of group) used.add(each.id);
      const head = group.find((each) => each.event === "approval.requested") ?? group[0]!;
      merged.push({ kind: "chain", head, group, runs: 1, state: outcomeClass(group[group.length - 1]!.outcome) });
      continue;
    }
    merged.push({ kind: "one", head: row, group: [row], runs: 1, state: outcomeClass(row.outcome) });
  }

  const collapsed: MergedRow[] = [];
  for (const row of merged) {
    const last = collapsed[collapsed.length - 1];
    if (row.kind === "one" && last !== undefined && last.kind === "one" && signatureOf(last.head) === signatureOf(row.head)) {
      last.runs += 1;
      last.group.push(row.head);
      continue;
    }
    collapsed.push(row);
  }
  return collapsed;
}

/** The chain key §1 adds to both call rows. Read defensively: `detail` is a small JSON summary
 *  written by many call sites, so its shape is not guaranteed by a type here. */
function approvalIdOf(row: AuditWindowRow): string | null {
  const id = row.detail?.approvalId;
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * What makes two rows "the same thing happening again" (§3's seven fields). `failureClass` is
 * among them because two `-32000`s with different causes are two different facts, and so is
 * `argsHead`: a run is the SAME CALL repeated, and without the arguments five searches for five
 * different things collapsed under the newest one's preview — a row claiming one thing happened
 * five times while showing one call's arguments (postmortem 2026-09-21). A repeated refusal
 * records no arguments at all, so the field is absent on both sides and ×N still collapses it,
 * which is the case ×N was for.
 *
 * ponytail: `argsHead` is only the first `AUDIT_ARGS_HEAD_CHARS` characters, so two calls that
 * differ only past character 160 still collapse into one run. Accepted — the run is now a
 * disclosure, so its members are listed and each one's record shows the whole arguments. Lift it
 * by hashing the full `args` server-side into the slim row if it ever misleads anyone.
 */
function signatureOf(row: AuditWindowRow): string {
  const failure = row.detail?.failureClass;
  return [
    row.event,
    row.app,
    row.tool,
    row.principal,
    row.outcome,
    typeof failure === "string" ? failure : "",
    row.argsHead ?? "",
  ].join("|");
}

/**
 * What a ×N row says about its members, under the title: how many, and the span they cover.
 *
 * The end is dated only when it falls on another day — "Aug 23 22:00 → 11:30" would read as
 * running backwards — which is the session header's rule, for the same reason.
 */
export function runLine(group: AuditWindowRow[]): string {
  const times = group.map((row) => row.ts);
  const first = Math.min(...times);
  const last = Math.max(...times);
  const end = sameUtcDay(first, last) ? fmtClock(last) : fmtDayTime(last);
  return `${fmtCount(group.length)} identical events · ${fmtDayTime(first)} → ${end}`;
}

/**
 * The words a chain row says, oldest first.
 *
 * The refused `tools/call` is dropped, and that is the rule this function exists for: it is
 * THE ASK, not a step before it — "refused → asked → approved → ran" would report the gate
 * twice and read as a failure that somehow also succeeded.
 */
export function chainWords(group: AuditWindowRow[]): string[] {
  return group
    .filter((row) => !(row.event === "tools/call" && row.outcome === "-32003"))
    .map((row) => {
      if (row.event === "approval.requested") return "asked for approval";
      if (row.event === "approval.approved") return `you approved ${fmtClock(row.ts)}`;
      if (row.event === "approval.rejected") return `you rejected ${fmtClock(row.ts)}`;
      if (row.event === "approval.expired") return "expired unanswered";
      const ran = `ran ${outcomeClass(row.outcome)}`;
      return row.durationMs === undefined ? ran : `${ran} ${fmtDuration(row.durationMs)}`;
    });
}

/** How many characters of a row's third line survive. Long enough to recognise a call by its
 *  arguments, short enough that a row stays one line. */
export const PREVIEW_CHARS = 110;

/**
 * A row's third line: the stored args head, clipped — or, when the whole body was replaced, the
 * stub's own placeholder rather than its JSON. Falling back to the first three `detail` pairs,
 * because a config change has no args and an empty line reads as missing data.
 */
export function previewOf(row: AuditWindowRow): string | null {
  if (row.argsHead !== undefined) {
    const stub = stubOf(row.argsHead);
    return stub === null ? row.argsHead.slice(0, PREVIEW_CHARS) : stubLabel(stub);
  }
  if (row.detail === undefined) return null;
  const pairs = Object.entries(row.detail)
    .slice(0, 3)
    .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join(" ");
  return pairs === "" ? null : pairs.slice(0, PREVIEW_CHARS);
}

/** An args head that is itself a whole-body stub. `argsHead` is a PREFIX of stored JSON, so a
 *  parse failure is the ordinary case and never an error. */
function stubOf(head: string): BodyStub | null {
  try {
    const parsed: unknown = JSON.parse(head);
    return isBodyStub(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- the sessions ---- */

/**
 * One consumer session. Rows carrying no `client.sessionId` group under their principal — one
 * bucket per principal, named so the reader can see it is not a session rather than finding a
 * row missing from the view.
 */
export type Session = {
  /** The session id, or `<principal> · no session`. */
  id: string;
  noSession: boolean;
  principal: string;
  client?: AuditWindowRow["client"];
  first: number;
  last: number;
  events: AuditWindowRow[];
  counts: Partial<Record<OutcomeClass, number>>;
  /** The worst class in the session — the swatch on its header. */
  worst: OutcomeClass;
};

/** Sessions over the selection, newest last-activity first. */
export function sessionsOf(rows: AuditWindowRow[]): Session[] {
  const byId = new Map<string, Session>();
  for (const row of rows) {
    const sessionId = row.client?.sessionId;
    const id = sessionId ?? `${row.principal} · no session`;
    const held = byId.get(id);
    if (held === undefined) {
      byId.set(id, {
        id,
        noSession: sessionId === undefined,
        principal: row.principal,
        ...(row.client === undefined ? {} : { client: row.client }),
        first: row.ts,
        last: row.ts,
        events: [row],
        counts: {},
        worst: "ok",
      });
      continue;
    }
    held.first = Math.min(held.first, row.ts);
    held.last = Math.max(held.last, row.ts);
    held.events.push(row);
  }
  const sessions = [...byId.values()];
  for (const session of sessions) {
    for (const row of session.events) {
      const cls = outcomeClass(row.outcome);
      session.counts[cls] = (session.counts[cls] ?? 0) + 1;
    }
    session.worst =
      [...OUTCOME_CLASSES].reverse().find((cls) => session.counts[cls] !== undefined) ?? "ok";
  }
  return sessions.sort((left, right) => right.last - left.last);
}

/** One line of a session's waterfall: an event, or a folded run of ok calls. */
export type WaterfallRow =
  | { kind: "event"; row: AuditWindowRow }
  | { kind: "fold"; n: number; from: number; to: number; apps: string[] };

/** More than this many consecutive ok calls fold to one line. TWO stays two: folding a pair
 *  hides as much as it saves, and the reader loses both timestamps to save one row. */
const FOLD_OVER = 2;

/**
 * Salience: what a session did, with the routine collapsed. A run of more than two ok
 * `tools/call` rows becomes one line; a refusal, an approval and a config change each keep
 * their own, because those are the lines somebody opened the session to find.
 */
export function waterfallOf(session: Session): WaterfallRow[] {
  const out: WaterfallRow[] = [];
  /** The run being accumulated — flushed the moment an un-foldable row or the end arrives. */
  let run: AuditWindowRow[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    if (run.length > FOLD_OVER) {
      out.push({
        kind: "fold",
        n: run.length,
        from: run[0]!.ts,
        to: run[run.length - 1]!.ts,
        apps: [...new Set(run.map((row) => row.app).filter((app): app is string => app !== undefined))],
      });
    } else {
      for (const row of run) out.push({ kind: "event", row });
    }
    run = [];
  };
  for (const row of [...session.events].sort(byTsThenId)) {
    if (row.event === "tools/call" && row.outcome === "ok") {
      run.push(row);
      continue;
    }
    flush();
    out.push({ kind: "event", row });
  }
  flush();
  return out;
}

/* -------------------------------------------------------------- the summary ---- */

/** Summary's three tiles. `median`/`p95` are milliseconds over OK CALLS alone — a refusal's
 *  3 ms is not a latency — and null where no matching row carried a duration. */
export type Summary = {
  events: number;
  calls: number;
  /** Refused or waiting: denied, approval and archived together. */
  refused: number;
  median: number | null;
  p95: number | null;
};

const REFUSED_CLASSES: readonly OutcomeClass[] = ["denied", "approval", "archived"];

export function isRefused(row: AuditWindowRow): boolean {
  return REFUSED_CLASSES.includes(outcomeClass(row.outcome));
}

export function summaryOf(rows: AuditWindowRow[]): Summary {
  const calls = rows.filter((row) => row.event === "tools/call");
  const ran = calls
    .filter((row) => row.outcome === "ok" && row.durationMs !== undefined)
    .map((row) => row.durationMs as number)
    .sort((left, right) => left - right);
  const quantile = (share: number): number | null =>
    ran.length === 0 ? null : (ran[Math.min(ran.length - 1, Math.floor(share * ran.length))] ?? null);
  return {
    events: rows.length,
    calls: calls.length,
    refused: rows.filter(isRefused).length,
    median: quantile(0.5),
    p95: quantile(0.95),
  };
}

/** One top-N bar chart. `max` is what every bar is drawn against, so two charts side by side
 *  are each read against their own busiest row rather than against the page. */
export type TopN = { rows: { value: string; count: number }[]; max: number };

export function topOf(rows: AuditWindowRow[], field: FilterField, n: number): TopN {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = filterValueOf(row, field);
    if (value === null) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const top = [...counts]
    .sort((left, right) => right[1] - left[1])
    .slice(0, n)
    .map(([value, count]) => ({ value, count }));
  return { rows: top, max: top[0]?.count ?? 1 };
}

/** Summary's Refusals panel: who was refused reaching what, busiest first. Keyed on the pair,
 *  and the filter it applies is the PRINCIPAL alone — the target half may be an event name,
 *  which is not a `tool` value. */
export function refusalPairsOf(rows: AuditWindowRow[], n: number): { principal: string; target: string; count: number; max: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows.filter(isRefused)) {
    counts.set(`${row.principal}|${targetOf(row) ?? row.event}`, (counts.get(`${row.principal}|${targetOf(row) ?? row.event}`) ?? 0) + 1);
  }
  const top = [...counts].sort((left, right) => right[1] - left[1]).slice(0, n);
  const max = top[0]?.[1] ?? 1;
  return top.map(([key, count]) => {
    const at = key.indexOf("|");
    return { principal: key.slice(0, at), target: key.slice(at + 1), count, max };
  });
}

/* ------------------------------------------------------------- worth a look ---- */

/** A sentence in runs, so the view renders emphasis and mono spans without parsing a string
 *  and the test can read the whole sentence by joining them. */
export type InsightPart = { text: string; style: "plain" | "strong" | "mono" };

/** One hand-written rule that fired. `filters` is what its **show me** applies. */
export type Insight = { parts: InsightPart[]; filters: Filter[] };

/** A refused pair is only worth a sentence past this many. Five is the line between "it
 *  happened" and "something is wrong". */
const REFUSAL_THRESHOLD = 5;

/** How far back "recently" reaches for the first-seen rule. */
const FRESH_MS = 2 * 24 * HOUR_MS;

/** Every row that changed the SETUP rather than used it, in the order given — which is newest
 *  first, as the window read answers. Summary lists the newest few; the third insight counts
 *  them all. */
export function changesOf(rows: AuditWindowRow[]): AuditWindowRow[] {
  return rows.filter((row) => row.event.startsWith("admin.") || row.event.startsWith("upstream."));
}

/**
 * The three hand-written rules of §3, in order. Hand-written on purpose: an owner needs the
 * three questions this page is opened with answered, not a ranked anomaly feed.
 *
 * `selected` is the current selection — the refusal and config rules are about what is on
 * screen. `loaded` is the whole loaded window, and the first-seen rule reads THAT: whether a
 * tool is new is a fact about the window, and narrowing the brush must not make a year-old
 * tool look new.
 *
 * `wholeWindow` says whether the loaded rows ARE the window — nothing cut off by the ceiling
 * and no search text narrowing them. The first-seen rule is suppressed without it, because
 * "called for the first time" is then unknowable rather than merely uncertain: on a busy
 * ledger a day and a half past the ceiling makes every tool look new, and under a search the
 * first MATCHING call is not the first call.
 *
 * The first sentence ends at the outcome class. The ledger records no *reason* for a refusal
 * (§15), so anything after the class would be invented.
 */
export function insightsOf(
  selected: AuditWindowRow[],
  loaded: AuditWindowRow[],
  now: number,
  scope: { wholeWindow: boolean },
): Insight[] {
  const out: Insight[] = [];

  const pairs = new Map<string, number>();
  for (const row of selected.filter(isRefused)) {
    const key = `${row.principal}|${targetOf(row) ?? row.event}|${outcomeClass(row.outcome)}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  const worst = [...pairs].sort((left, right) => right[1] - left[1])[0];
  if (worst !== undefined && worst[1] > REFUSAL_THRESHOLD) {
    const [principal = "", target = "", cls = ""] = worst[0].split("|");
    out.push({
      parts: [
        { text: `${principal} was refused ${fmtCount(worst[1])} times`, style: "strong" },
        { text: " calling ", style: "plain" },
        { text: target, style: "mono" },
        { text: ` — ${cls}.`, style: "plain" },
      ],
      filters: [
        { field: "principal", value: principal },
        { field: "tool", value: target },
      ],
    });
  }

  const firstSeen = new Map<string, AuditWindowRow>();
  for (const row of [...loaded].sort(byTsThenId)) {
    const target = row.tool === undefined ? null : targetOf(row);
    if (target === null || firstSeen.has(target)) continue;
    firstSeen.set(target, row);
  }
  const fresh = scope.wholeWindow ? [...firstSeen].filter(([, row]) => row.ts > now - FRESH_MS) : [];
  if (fresh.length > 0) {
    const named = fresh.slice(0, 3).map(([target]) => target);
    out.push({
      parts: [
        { text: `${fmtCount(fresh.length)} tool${fresh.length > 1 ? "s were" : " was"} called for the first time`, style: "strong" },
        { text: " in the last two days: ", style: "plain" },
        ...joined(named),
        { text: ".", style: "plain" },
      ],
      filters: [{ field: "tool", value: fresh[0]![0] }],
    });
  }

  const changes = changesOf(selected);
  if (changes.length > 0) {
    const names = [...new Set(changes.map((row) => row.event))];
    out.push({
      parts: [
        { text: `${fmtCount(changes.length)} change${changes.length > 1 ? "s" : ""} to your setup`, style: "strong" },
        { text: ": ", style: "plain" },
        ...joined(names.slice(0, 3)),
        { text: ".", style: "plain" },
      ],
      // EVERY distinct change event, which is one group and therefore OR-ed: the sentence
      // counted all of them, so "show me" has to open all of them. One event name would open a
      // list of one under a sentence that said ten.
      filters: names.map((value) => ({ field: "event", value })),
    });
  }
  return out;
}

/** Mono runs with plain commas between them — a list the view can style per item. */
function joined(names: string[]): InsightPart[] {
  const parts: InsightPart[] = [];
  names.forEach((name, index) => {
    if (index > 0) parts.push({ text: ", ", style: "plain" });
    parts.push({ text: name, style: "mono" });
  });
  return parts;
}

/* ------------------------------------------------------------------ bodies ---- */

/**
 * §13's three sentences, verbatim. Which one applies is the SERVER's answer (`noBodies` on the
 * row): the three causes are indistinguishable from the client's side, and telling an owner
 * the wrong one is worse than saying nothing. Inherited from `pages/audit.tsx` with the page.
 */
export const NO_BODIES_SENTENCE: Record<NoBodiesReason, string> = {
  off: "Call bodies aren't recorded for this app (body logging is off).",
  refused: "Refused before the call was made, so there are no bodies to show.",
  unrecorded: "No bodies were recorded for this call.",
};

export function isBodyStub(value: unknown): value is BodyStub {
  if (typeof value !== "object" || value === null || !("stub" in value) || !("bytes" in value)) return false;
  return value.stub === "blob" || value.stub === "oversize";
}

/** The literal a redacted leaf holds — written by the gateway's masking, rendered as a chip
 *  rather than as a quoted string so it cannot be mistaken for the value. */
export const REDACTED_LEAF = "‹redacted›";

/** A stub as §13 spells it: KB under a megabyte, MB with one decimal above, never the bytes. A
 *  20 KB body reading "0.0 MB" is a size nobody can act on, which is the whole rule. */
export function stubLabel(stub: BodyStub): string {
  return stub.stub === "blob"
    ? `‹blob ${stub.contentType ?? "unknown"} · ${fmtSize(stub.bytes)}›`
    : `‹oversize · ${fmtSize(stub.bytes)}›`;
}

/**
 * How many levels of a recorded body are open before anybody clicks.
 *
 * TWO, not one. The things the record exists to show sit at depth two by construction — a
 * `‹redacted›` leaf is at `arguments.credentials.token`, a blob stub is an element of
 * `result.content` — so one level opens a record that answers nothing and has to be clicked
 * twice. Bodies are capped at 16 KB (§15), so drawing two levels costs nothing.
 */
export const TREE_OPEN_DEPTH = 2;

/**
 * Where a record's search found something, and what has to be OPEN for it to be on screen.
 *
 * `ancestors` is every collapsible path on the way to a match, including the root: a tree that
 * highlighted a match inside a collapsed subtree would report a hit the reader cannot see, which
 * is worse than reporting none. `matches` is how many leaves or keys matched, so the drawer can
 * say "No matches in this record." instead of going quietly blank.
 *
 * A STUB is matched on the label it RENDERS as — `‹blob image/png · 4.2 MB›` — and not on its
 * recorded `bytes`: the reader searches for what is on the screen, and `4404019` never is.
 */
export function treeSearch(value: unknown, root: string, needle: string): { ancestors: Set<string>; matches: number } {
  const ancestors = new Set<string>();
  const trimmed = needle.trim().toLowerCase();
  if (trimmed === "") return { ancestors, matches: 0 };
  let matches = 0;

  /** Walks one node, remembering the path taken to it; a hit marks that whole path open. */
  const walk = (node: unknown, name: string, path: string, trail: string[]): void => {
    const hit = (): void => {
      matches += 1;
      for (const each of trail) ancestors.add(each);
    };
    if (name.toLowerCase().includes(trimmed)) hit();
    if (isBodyStub(node)) {
      if (stubLabel(node).toLowerCase().includes(trimmed)) hit();
      return;
    }
    if (node === null || typeof node !== "object") {
      if (String(node).toLowerCase().includes(trimmed)) hit();
      return;
    }
    const entries: [string, unknown][] = Array.isArray(node)
      ? node.map((each, index) => [`[${index}]`, each])
      : Object.entries(node);
    for (const [key, child] of entries) walk(child, key, `${path}.${key}`, [...trail, path]);
  };

  walk(value, root, root, [root]);
  // The root's own name matching would otherwise open nothing, there being nothing above it.
  if (matches > 0) ancestors.add(root);
  return { ancestors, matches };
}

/**
 * The over-ceiling notice, as a TEMPLATE over the read's own two numbers.
 *
 * `ceiling` comes from the response and never from a second literal of `AUDIT_EXPLORER_ROWS`:
 * the page may not state a constant the server owns, for the reason the Password pane's "At
 * least 12 characters." follows.
 */
export function ceilingNotice(ceiling: number, total: number): string {
  return `Showing the newest ${fmtCount(ceiling)} of ${fmtCount(total)} events — narrow the search, or export JSONL for all of them.`;
}

/* --------------------------------------------------------------- spellings ---- */

/**
 * The page's own number, time and size spellings.
 *
 * Here rather than in `lib/format.ts` because that file is an EXACT copy of the server's
 * formatter and says so: /approvals and /settings still read the original, and adding this
 * page's spellings there would break the claim that the two cannot drift. Everything below is
 * UTC — the subtitle says so, and a screenshot must render identically wherever it was taken.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** "12,481" — a count the eye can read at a glance, in the one locale the product ships. */
export function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** "14:47" UTC — a stamp inside a day the row's own line already names. */
export function fmtClock(ms: number): string {
  const at = new Date(ms);
  return `${pad2(at.getUTCHours())}:${pad2(at.getUTCMinutes())}`;
}

/** "Aug 24 14:47" UTC — the strip's ends and the header's range. */
export function fmtDayTime(ms: number): string {
  const at = new Date(ms);
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()} ${fmtClock(ms)}`;
}

/** "Aug 24" UTC — the axis. */
export function fmtDay(ms: number): string {
  const at = new Date(ms);
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`;
}

/** Whether two instants fall on the same UTC day. A session's end prints as a clock inside its
 *  own day and as a full stamp when it crossed midnight: "Aug 23 23:40 → 02:10" reads as
 *  running backwards. */
export function sameUtcDay(left: number, right: number): boolean {
  return new Date(left).toISOString().slice(0, 10) === new Date(right).toISOString().slice(0, 10);
}

/** "Aug 24 14:47:03" UTC — an event row's own stamp, where the second distinguishes two calls. */
export function fmtStamp(ms: number): string {
  return `${fmtDayTime(ms)}:${pad2(new Date(ms).getUTCSeconds())}`;
}

/** "3 ms" / "1.2 s" — milliseconds under a second, seconds with one decimal above. A duration
 *  the ledger never measured reads the dash, not "0 ms". */
export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function fmtSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ------------------------------------------------------------- odds and ends ---- */

/** One value of a search key, or null — the bag holds a repeated key as an array. */
function one(search: SearchBag, key: string): string | null {
  const held = search[key];
  if (held === undefined) return null;
  return Array.isArray(held) ? (held[0] ?? null) : held;
}

/** Every value of a search key, blanks dropped. */
function many(search: SearchBag, key: string): string[] {
  const held = search[key];
  if (held === undefined) return [];
  return (Array.isArray(held) ? held : [held]).filter((value) => value !== "");
}

/** An epoch-ms string, or null where it is not one. A `?since=yesterday` is a stale link, and
 *  the answer to it is the whole window rather than NaN. */
function msOf(raw: string | null): number | null {
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Every row carrying one approval's id, oldest first — the record drawer's sibling timeline. */
export function siblingsOf(rows: AuditWindowRow[], approvalId: string): AuditWindowRow[] {
  return rows.filter((row) => approvalIdOf(row) === approvalId).sort(byTsThenId);
}
