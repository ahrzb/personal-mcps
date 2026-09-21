import { keys } from "@/lib/queries";
import type { AuditEventRow, AuditWindowResponse, AuditWindowRow } from "@/lib/types";
import type { Seed } from "../seed";
import { mergeEvents } from "@/features/audit/derive";
import { RECORDS, WEEK, WEEK_NOW, WEEK_RETENTION_DAYS } from "./audit-week";

/**
 * `/audit` — every state §13 names, over the SAME fixture week the design boards are captured
 * from (`design/concepts/AuditDemo.data.js`, via `web/scripts/audit-week.mts`).
 *
 * That shared week is the point: these screenshots are read beside the boards, and two different
 * ledgers would make every difference between them unreadable. So nothing here invents rows
 * except the `longData` ones, which exist to break the layout on purpose and have no
 * counterpart in a real ledger.
 *
 * The seeds split three ways:
 *   - the READS, which are the window (one entry per search text, because `q` is the only thing
 *     that refetches) and the record (one entry per id the drawer opens);
 *   - the URL, which carries the view, the brush, the facets, the open record and the open
 *     session — everything the page's state is;
 *   - `hanging`, for the two states that are a read in flight rather than an answer.
 */

/** The whole week, as the window read answers it. `ceiling` is `AUDIT_EXPLORER_ROWS`, above the
 *  week's own rows, so nothing is cut off and no cell is hatched. */
const WINDOW: AuditWindowResponse = {
  rows: WEEK,
  total: WEEK.length,
  since: WEEK_NOW - WEEK_RETENTION_DAYS * 864e5,
  until: WEEK_NOW,
  retentionDays: WEEK_RETENTION_DAYS,
  ceiling: 5000,
};

/**
 * The last six hours of the fixture week, as a brush.
 *
 * Every state that lands on Events or Sessions carries it, and the reason is the BASELINE
 * rather than the design: a page of 120 merged rows is six thousand pixels tall, and a full-page
 * screenshot of that is megabytes of PNG per state. The 120-row page size is product behaviour
 * and is unchanged — only the seeded selection is narrower, which is also the selection somebody
 * actually reading the ledger would be in.
 */
const RECENT = { since: String(WEEK_NOW - 6 * 36e5), until: String(WEEK_NOW) };

/** One state: the window read, the URL, and whatever else it needs. */
function seed(over: { search?: Record<string, string | string[]>; window?: Partial<AuditWindowResponse>; records?: number[]; hanging?: string[] } = {}): Seed {
  return {
    path: "/audit",
    ...(over.search === undefined ? {} : { search: over.search }),
    ...(over.hanging === undefined ? {} : { hanging: over.hanging }),
    queries: [
      // Keyed on the search TEXT, so a state with a `?q=` has to seed the answer for that text —
      // which is what the real page would ask for.
      { key: keys.auditWindow((over.search?.q as string | undefined) ?? ""), data: { ...WINDOW, ...over.window } },
      ...(over.records ?? []).map((id) => ({ key: keys.auditRecord(String(id)), data: { row: RECORDS[id] } })),
    ],
  };
}

/**
 * A state whose record is open: the window, the record's own read, and `?expand=`.
 *
 * Over SUMMARY unless a state says otherwise. The record is a drawer over whatever view is
 * open, so the view behind it is not what the state is about — and Events draws 120 merged rows,
 * which makes a full-page baseline six thousand pixels tall for a screen whose subject is a
 * 620px panel.
 */
function record(id: number, over: { search?: Record<string, string>; records?: number[] } = {}): Seed {
  return seed({
    search: { expand: String(id), ...over.search },
    records: over.records ?? [id],
  });
}

/* ------------------------- which record each state opens ------------------------- */

/**
 * The record seeds name their rows by SHAPE, never by id.
 *
 * `web/scripts/audit-week.mts` picks the records by rule — whichever row now carries a stub,
 * whichever now has each no-bodies reason — so every id moves when the week is regenerated. A
 * hardcoded one would quietly seed `undefined` and the state would render an empty drawer, which
 * is exactly the kind of silent fixture rot the gallery exists to catch rather than commit.
 *
 * A shape the week no longer holds THROWS at module load: a seed that cannot be built is a
 * broken gallery, and the index failing loudly is the point.
 */
const RECORD_ROWS = Object.values(RECORDS);

function pick(what: string, match: (row: AuditEventRow) => boolean): number {
  const found = RECORD_ROWS.find(match);
  if (found === undefined) {
    throw new Error(`pmcp: the fixture week holds no record that is ${what} — regenerate audit-week.ts`);
  }
  return found.id;
}

const hasStub = (row: AuditEventRow, kind: "blob" | "oversize"): boolean =>
  JSON.stringify([row.args, row.result]).includes(`"stub":"${kind}"`);

/** A plain call with bodies and no stub — the one whose args carry the `‹redacted›` leaf. */
const PLAIN = pick(
  "a plain call with bodies",
  (row) => row.args !== undefined && row.result !== undefined && !hasStub(row, "blob") && !hasStub(row, "oversize"),
);
const BLOB = pick("a blob stub", (row) => hasStub(row, "blob"));
const OVERSIZE = pick("an oversize stub", (row) => hasStub(row, "oversize"));
const UNAVAILABLE = pick("a -32000 with a failureClass", (row) => row.outcome === "-32000");
const NO_BODIES = {
  off: pick("a row whose app has logging off", (row) => row.noBodies === "off"),
  refused: pick("a refused row", (row) => row.noBodies === "refused"),
  unrecorded: pick("a row recorded before logging was on", (row) => row.noBodies === "unrecorded"),
};

/** Every record of the one complete chain, oldest first — the approval the timeline draws. */
const CHAIN = (() => {
  const id = RECORD_ROWS.find((row) => typeof row.detail?.approvalId === "string")?.detail?.approvalId;
  const group = RECORD_ROWS.filter((row) => row.detail?.approvalId === id).sort((left, right) => left.ts - right.ts);
  if (group.length < 4) throw new Error("pmcp: the fixture week holds no complete approval chain");
  return { head: group.find((row) => row.event === "approval.requested")?.id ?? group[0]!.id, ids: group.map((row) => row.id) };
})();

/**
 * The week's longest ×N run, and a window around it — derived for the same reason the records
 * are: the state exists to show a run UNFOLDED, not to show one particular row, and both the id
 * and the instants move when the week is regenerated.
 */
const RUN = (() => {
  const biggest = mergeEvents(WEEK)
    .filter((row) => row.runs > 1)
    .sort((left, right) => right.runs - left.runs)[0];
  if (biggest === undefined) throw new Error("pmcp: the fixture week holds no ×N run to unfold");
  const times = biggest.group.map((row) => row.ts);
  // Half an hour either side, so the run sits among ordinary rows rather than alone.
  return {
    head: biggest.head.id,
    since: String(Math.min(...times) - 30 * 60_000),
    until: String(Math.max(...times) + 30 * 60_000),
  };
})();

/* ---------------------------- the long-data rows ---------------------------- */

/**
 * The three overflows §5 asks for, and the ONLY invented rows here: a 300-character tool name, a
 * 40-key arguments object and a 64-character session id. The real week's longest tool name is 15
 * characters, so nothing in it would find a clipped title, an unwrapped mono string or a field
 * table that pushes its own value off the drawer.
 */
const LONG_TOOL = `generate_${"quarterly_consolidated_revenue_attribution_".repeat(6)}report`.slice(0, 300);
const LONG_SESSION = "f".repeat(32) + "0123456789abcdef".repeat(2);
const LONG_ARGS: Record<string, unknown> = Object.fromEntries(
  Array.from({ length: 40 }, (_, index) => [`parameter_number_${index + 1}`, `value ${index + 1}`]),
);

const longSlim: AuditWindowRow = {
  id: 99_001,
  ts: WEEK_NOW - 60_000,
  principal: "agent:reporting-pipeline-nightly",
  event: "tools/call",
  app: "analytics",
  tool: LONG_TOOL,
  outcome: "ok",
  durationMs: 41_200,
  client: { name: "pmcp-cli", version: "0.9.2", sessionId: LONG_SESSION },
  argsHead: JSON.stringify(LONG_ARGS).slice(0, 160),
  hasResult: true,
};

const longFull: AuditEventRow = {
  ...longSlim,
  args: LONG_ARGS,
  result: { structuredContent: { rows: 182_004, note: "x".repeat(220) } },
};

/** The long rows beside a slice of the real week, so the layout is stressed inside a page that is
 *  otherwise the ordinary one. */
const LONG_WINDOW: Partial<AuditWindowResponse> = {
  rows: [longSlim, ...WEEK.slice(0, 40)],
  total: 41,
};

/**
 * One page of the window read, answered from the fixture week — what `searchLive`'s responder
 * serves.
 *
 * The match is a substring of the whole serialized row rather than the server's column-by-column
 * `LIKE`: this is a fixture whose job is to answer DIFFERENTLY for different text and to take a
 * moment doing it, and a second implementation of §1's escaping grammar here would be a second
 * thing to keep true.
 */
function windowFor(path: string): AuditWindowResponse {
  const params = new URLSearchParams(path.slice(path.indexOf("?") + 1));
  const text = (params.get("text") ?? "").trim().toLowerCase();
  const offset = Number(params.get("offset") ?? 0);
  const matched = text === "" ? WEEK : WEEK.filter((row) => JSON.stringify(row).toLowerCase().includes(text));
  return { ...WINDOW, rows: matched.slice(offset, offset + 1000), total: matched.length };
}

/* --------------------------------- the states -------------------------------- */

export const auditSeeds: Record<string, Seed> = {
  /** Summary over the whole window — the landing, and the board `Audit`. */
  summary: seed(),

  /** The ledger itself: merged rows, a chain and a ×N run among them. */
  events: seed({ search: { view: "events", ...RECENT } }),

  /** Events under a brush and two facet chips — the board `AuditViews`. */
  eventsFiltered: seed({
    search: { view: "events", ...RECENT, principal: "agent:claude", outcome: "ok" },
  }),

  /**
   * A ×N run UNFOLDED — the disclosure the run row shipped without.
   *
   * The window is the eight hours around the fixture week's longest run (a cron agent refused
   * every half hour), because a board that draws a collapsed row has to draw its expanded form
   * too: "how do I see what is inside" is part of the row's contract, and the one time it was
   * not drawn the members turned out to be unreachable (postmortem 2026-09-21).
   */
  eventsRunOpen: {
    ...seed({ search: { view: "events", since: RUN.since, until: RUN.until } }),
    transient: { openRun: RUN.head },
  },

  /**
   * The search box with a LIVE read behind it — the one state a seeded cache cannot express,
   * and the state whose absence let the search bug ship.
   *
   * `respond` answers `/audit/window` late instead of throwing, so typing actually refetches
   * here: the explorer stays mounted over the previous rows, the box keeps its focus and caret
   * and says "Searching…", and `web/scripts/audit-search-check.mts` walks exactly this.
   */
  searchLive: {
    ...seed(),
    respond: (path) => (path.startsWith("/audit/window") ? { delayMs: 250, data: windowFor(path) } : null),
  },

  /** Sessions with one session open on its waterfall, where the ok runs fold. */
  sessionsOpen: seed({ search: { view: "sessions", ...RECENT, open: "a3f9c2d1" } }),

  /** A call with bodies: a `‹redacted›` leaf in the arguments, a structured result. */
  record: record(PLAIN),

  /** One `blob` stub, as a single element of `content`. */
  recordStubs: record(BLOB),

  /** An `oversize` stub, which replaces a WHOLE section rather than one block. */
  recordOversize: record(OVERSIZE),

  /** A chain record, headed by its `approval.requested` row: the timeline of all four events, and
   *  the title rule's exception visible behind it in the Events row. */
  recordChain: record(CHAIN.head, { search: { view: "events", ...RECENT }, records: CHAIN.ids }),

  /** A search inside the record, which has OPENED the subtree its match sits in — `token` is at
   *  `arguments.credentials.token`, two levels down and collapsed by nothing. */
  recordSearch: {
    ...record(PLAIN),
    transient: { recordSearch: "token" },
  },

  /** A `-32000` that recorded a `failureClass` — the one outcome whose sentence gains a
   *  "Cause: …", and the only place the page prints a raw code at all. */
  recordUnavailable: record(UNAVAILABLE),

  /** The three no-bodies sentences, one state each. */
  recordNoBodiesOff: record(NO_BODIES.off),
  recordNoBodiesRefused: record(NO_BODIES.refused),
  recordNoBodiesUnrecorded: record(NO_BODIES.unrecorded),

  /** The record's own read in flight: the field table is already drawn from the slim row, the body
   *  sections are skeletons. */
  recordLoading: seed({ search: { expand: String(PLAIN) }, hanging: [`/audit/${PLAIN}`] }),

  /** An id outside retention — the one refusal the record read can make. */
  recordMissing: {
    path: "/audit",
    search: { expand: "41988" },
    queries: [
      { key: keys.auditWindow(""), data: WINDOW },
      { key: keys.auditRecord("41988"), error: { status: 404, body: { reason: "No such audit record." } } },
    ],
  },

  /** The window read in flight: the strip, the rail and the pane as skeletons. */
  loading: seed({ hanging: ["/audit/window"] }),

  /** The window read refused. The whole page is one read, so there is nothing to draw around it. */
  failed: {
    path: "/audit",
    queries: [
      { key: keys.auditWindow(""), error: { status: 500, body: { reason: "The audit read failed." } } },
    ],
  },

  /** A namespace that has recorded nothing yet. */
  empty: seed({ window: { rows: [], total: 0 } }),

  /** Facets that match nothing: `app=news` AND a tool of another app. Groups AND, so the
   *  selection is empty while both values are real — which is the mistake this state exists for. */
  nothingMatches: seed({ search: { view: "events", ...RECENT, app: "news", tool: "notion/search" } }),

  /**
   * Over the ceiling: the newest 900 of 12,481, so the notice renders from the response's own two
   * numbers and every hour before the oldest loaded row draws hatched rather than empty.
   */
  ceiling: seed({
    window: { rows: WEEK.slice(0, 900), total: 12_481, ceiling: 900 },
  }),

  /** A 300-character tool name, a 40-key arguments object and a 64-character session id, in the
   *  record that has to hold all three. */
  longData: {
    path: "/audit",
    search: { view: "events", ...RECENT, expand: "99001" },
    queries: [
      { key: keys.auditWindow(""), data: { ...WINDOW, ...LONG_WINDOW } },
      { key: keys.auditRecord("99001"), data: { row: longFull } },
    ],
  },
};
