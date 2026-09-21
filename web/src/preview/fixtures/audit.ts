import { keys } from "@/lib/queries";
import type { AuditEventRow, AuditWindowResponse, AuditWindowRow } from "@/lib/types";
import type { Seed } from "../seed";
import { RECORDS, WEEK, WEEK_NOW, WEEK_RETENTION_DAYS } from "./audit-week";

/**
 * `/audit` — every state §13 names, over the SAME fixture week the design boards are captured
 * from (`design/concepts/AuditDemo.data.js`, via `web/scripts/audit-week.mts`).
 *
 * That shared week is the point: these screenshots are read beside the boards, and two different
 * ledgers would make every difference between them unreadable. So nothing here invents rows
 * except the three `longData` ones, which exist to break the layout on purpose and have no
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
 *  week's own 1,395 rows, so nothing is cut off and no cell is hatched. */
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

  /** Sessions with one session open on its waterfall, where the ok runs fold. */
  sessionsOpen: seed({ search: { view: "sessions", ...RECENT, open: "a3f9c2d1" } }),

  /** A call with bodies: a `‹redacted›` leaf in the arguments, a structured result. */
  record: record(41_362),

  /** One `blob` stub, as a single element of `content`. */
  recordStubs: record(41_363),

  /** An `oversize` stub, which replaces a WHOLE section rather than one block. */
  recordOversize: record(41_034),

  /** A chain record, headed by its `approval.requested` row: the timeline of all four events, and
   *  the title rule's exception visible behind it in the Events row. */
  recordChain: record(41_352, {
    search: { view: "events", ...RECENT },
    records: [41_352, 41_353, 41_354, 41_355],
  }),

  /** A search inside the record, which has OPENED the subtree its match sits in — `token` is at
   *  `arguments.credentials.token`, two levels down and collapsed by nothing. */
  recordSearch: {
    ...record(41_362),
    transient: { recordSearch: "token" },
  },

  /** A `-32000` that recorded a `failureClass` — the one outcome whose sentence gains a
   *  "Cause: …", and the only place the page prints a raw code at all. */
  recordUnavailable: record(41_159),

  /** The three no-bodies sentences, one state each. */
  recordNoBodiesOff: record(41_337),
  recordNoBodiesRefused: record(41_353),
  recordNoBodiesUnrecorded: record(41_349),

  /** The record's own read in flight: the field table is already drawn from the slim row, the body
   *  sections are skeletons. */
  recordLoading: seed({ search: { expand: "41362" }, hanging: ["/audit/41362"] }),

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
