import { Dialog } from "@base-ui/react/dialog";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Shell, useDocumentTitle } from "@/chrome/Shell";
import { useApi } from "@/lib/api-context";
import { paths } from "@/lib/paths";
import { auditWindowQuery } from "@/lib/queries";
import type { AuditWindowResponse, AuditWindowRow } from "@/lib/types";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  exportHref,
  facetGroups,
  facetRows,
  fmtCount,
  fmtDayTime,
  inBrush,
  insightsOf,
  lanesOf,
  mergeEvents,
  principalsByBusiest,
  searchOf,
  selectionOf,
  sessionsOf,
  toggleFilter,
} from "./derive";
import type { AuditSelection, AuditView, FacetField, Filter, SearchBag } from "./derive";
import { FacetRail, FacetRailSkeleton } from "./FacetRail";
import { LaneStrip, LaneStripSkeleton } from "./LaneStrip";
import { EVENTS_PAGE, EventsView } from "./EventsView";
import { RecordDrawer } from "./RecordDrawer";
import { SESSIONS_PAGE, SessionsView } from "./SessionsView";
import { SummaryView } from "./SummaryView";
import { SearchBox, SkelBar, useDebounced, useNarrow, useSlashFocus } from "./parts";

/**
 * `/audit` — the audit ledger as an explorer: three readings of one filtered set, a per-principal
 * lane strip with a brush, a facet rail with live counts, related events merged into one row, and
 * the record as a request inspector (§13 decision 36).
 *
 * ONE READ, and everything else is arithmetic. The page asks for the whole retention window of
 * slim rows once and then computes the facets, the brush, the views, the merging and the sessions
 * over the rows it holds — so a facet click, a view switch and a brush drag never touch the
 * network. The search box is the one control that refetches, debounced, because `text` is a
 * `LIKE` over columns no index covers and the client cannot do it as well as SQLite can.
 *
 * URL IS THE STATE. Every view, facet, brush, search, open record and open session round-trips
 * through the query string, which is what makes a shared link reproduce the screen and what lets
 * the preview gallery show a state at all. The two things NOT in the URL are how many rows a
 * "Load more" has revealed and which facet groups are expanded: those are how far the reader has
 * scrolled, not what they are looking at, and a URL that grew on every click would be a URL
 * nobody could share.
 */
export function AuditPage(): ReactNode {
  useDocumentTitle("Audit log");
  const api = useApi();
  const search = useSearch({ strict: false }) as SearchBag;

  // The one refetching control. The URL takes every keystroke — the state lives there — and only
  // the query key waits, so the box is never laggy and the server sees one read per pause.
  const typed = oneOf(search, "q");
  const window = useQuery(auditWindowQuery(api, useDebounced(typed, SEARCH_DEBOUNCE_MS)));

  return (
    <Shell active="audit">
      <main className="page--workspace audit">
        {window.isPending ? (
          <LoadingExplorer search={search} />
        ) : window.isError ? (
          <FailedExplorer message={window.error.message} onRetry={() => void window.refetch()} />
        ) : (
          <Explorer data={window.data} search={search} refetching={window.isFetching} />
        )}
      </main>
    </Shell>
  );
}

/** How long the search box settles before the window is re-read. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * The loaded page. Split from `AuditPage` so every hook below can take the window as a fact
 * rather than as a maybe: the selection is read against the window the SERVER echoed, and a
 * component that had to cope with not having one yet would compute a clock of its own.
 */
function Explorer({
  data,
  search,
  refetching,
}: {
  data: AuditWindowResponse;
  search: SearchBag;
  refetching: boolean;
}): ReactNode {
  const navigate = useNavigate();
  const narrow = useNarrow();
  const searchRef = useRef<HTMLInputElement | null>(null);
  useSlashFocus(searchRef);

  // What focus returns to when the record closes: the row, the bar or the timeline line that
  // opened it. Held in a ref rather than in state because changing it must not re-render.
  const opener = useRef<HTMLElement | null>(null);

  const bounds = { start: data.since, end: data.until };
  const selection = selectionOf(search, bounds);
  /* The memo key. `selectionOf` builds fresh arrays on every render, so a `useMemo` keyed on the
     selection object would recompute every time; the round-tripped search bag is the same state
     as a string, and it changes exactly when the answer would. */
  const key = JSON.stringify(searchOf(selection));

  const [shown, setShown] = useState({ events: EVENTS_PAGE, sessions: SESSIONS_PAGE });
  const [expandedGroups, setExpandedGroups] = useState<Partial<Record<FacetField, boolean>>>({});
  const [filterLevel, setFilterLevel] = useState(false);
  // A changed selection is a different list, so "Load more" starts over: keeping 600 revealed
  // rows across a facet click would hand the reader a page they never scrolled.
  useEffect(() => setShown({ events: EVENTS_PAGE, sessions: SESSIONS_PAGE }), [key]);

  const rows = data.rows;
  const derived = useMemo(() => {
    const shownRows = facetRows(rows, selection);
    const selected = shownRows.filter((row) => inBrush(row, selection));
    return {
      shownRows,
      selected,
      groups: facetGroups(rows, selection),
      inWindow: rows.filter((row) => inBrush(row, selection)).length,
      merged: mergeEvents(selected),
      sessions: sessionsOf(selected),
      /* "First seen" is knowable only when the loaded rows ARE the window: past the ceiling
         there are older rows nobody loaded, and under a search there are only matching ones. */
      insights: insightsOf(selected, rows, data.until, {
        wholeWindow: data.total <= data.ceiling && selection.q.trim() === "",
      }),
      principals: principalsByBusiest(rows),
    };
    // `selection` is derived from `key` and `bounds`, both of which are in the deps below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, key, data.until]);

  /* The oldest instant the page HOLDS rows for. Only meaningful past the ceiling: below it the
     read returned everything, so an hour with no rows is an hour in which nothing happened and
     must draw empty rather than hatched. */
  const over = data.total > data.ceiling;
  const oldestLoaded = over && rows.length > 0 ? (rows[rows.length - 1]?.ts ?? data.since) : data.since;
  const hours = Math.max(1, Math.round((data.until - data.since) / HOUR));
  const lanes = useMemo(
    () =>
      lanesOf(derived.shownRows, {
        start: data.since,
        hours,
        oldestLoaded,
        principals: derived.principals,
        cap: narrow ? NARROW_LANES : undefined,
      }),
    [derived.shownRows, derived.principals, data.since, hours, oldestLoaded, narrow],
  );

  /** Every navigation this page makes: the selection, written back to the URL. Replacing, because
   *  a filter click is a refinement of one screen and the Back button should leave the page
   *  rather than walk a reader back through twelve of their own facet toggles. */
  const go = (next: Partial<AuditSelection>): void => {
    void navigate({ to: paths.audit(), search: searchOf({ ...selection, ...next }), replace: true });
  };
  const openRecord = (row: AuditWindowRow, from: HTMLElement): void => {
    opener.current = from;
    go({ expand: String(row.id) });
  };
  const applyFilters = (filters: Filter[], view?: AuditView): void => {
    let next = selection.filters;
    for (const filter of filters) {
      if (!next.some((held) => held.field === filter.field && held.value === filter.value)) {
        next = [...next, filter];
      }
    }
    go({ filters: next, ...(view === undefined ? {} : { view }) });
  };

  const expanded = selection.expand;
  const expandedRow = expanded === null ? undefined : rows.find((row) => String(row.id) === expanded);

  return (
    <>
      <Header
        subtitle={
          <>
            {fmtCount(derived.selected.length)} events · {fmtDayTime(selection.since)} →{" "}
            {fmtDayTime(selection.until)} UTC · kept for {data.retentionDays} days
            {refetching ? " · searching…" : ""}
          </>
        }
        exportTo={exportHref(selection)}
        view={selection.view}
        onView={(view) => go({ view })}
      />

      <LaneStrip
        lanes={lanes}
        selection={selection}
        window={bounds}
        retentionDays={data.retentionDays}
        hours={hours}
        selected={derived.selected.length}
        ceiling={data.ceiling}
        total={data.total}
        anyNotLoaded={oldestLoaded > data.since}
        onBrush={(next) =>
          go(next === null ? { since: bounds.start, until: bounds.end, brushed: false } : { ...next, brushed: true })
        }
      />

      <div className="a-fbar">
        <button type="button" className="btn btn--outline a-filtersbtn" onClick={() => setFilterLevel(true)}>
          Filters{selection.filters.length > 0 ? ` · ${selection.filters.length}` : ""}
        </button>
        {selection.filters.map((filter) => (
          <span className="a-fchip" key={`${filter.field}:${filter.value}`}>
            <span className="a-fchip-k">{filter.field}</span>
            <span className="a-fchip-v">{filter.value}</span>
            <button
              type="button"
              aria-label={`Remove the ${filter.field} filter ${filter.value}`}
              onClick={() =>
                go({ filters: selection.filters.filter((held) => held !== filter) })
              }
            >
              ×
            </button>
          </span>
        ))}
        <SearchBox
          inputRef={searchRef}
          value={selection.q}
          onChange={(next) => go({ q: next })}
          placeholder="Search events and bodies…  ( / )"
          label="Search events and bodies"
        />
        {selection.filters.length > 0 || selection.q !== "" ? (
          <button type="button" className="btn btn--outline btn--sm" onClick={() => go({ filters: [], q: "" })}>
            Clear
          </button>
        ) : null}
      </div>

      <div className="a-body">
        <aside className="card a-rail">
          <FacetRail
            groups={derived.groups}
            selected={derived.selected.length}
            inWindow={derived.inWindow}
            expanded={expandedGroups}
            onToggleValue={(filter) => go({ filters: toggleFilter(selection.filters, filter.field, filter.value) })}
            onToggleGroup={(field) =>
              setExpandedGroups((held) => ({ ...held, [field]: held[field] !== true }))
            }
          />
        </aside>
        <div className="a-main">
          {rows.length === 0 && selection.filters.length === 0 && selection.q === "" ? (
            <EmptyLedger />
          ) : derived.selected.length === 0 ? (
            <NothingMatches onClear={() => go({ filters: [], q: "" })} />
          ) : selection.view === "summary" ? (
            <SummaryView
              rows={derived.selected}
              insights={derived.insights}
              onDrillTo={(filters) => applyFilters(filters, "events")}
              onToggleFilter={(filter) => go({ filters: toggleFilter(selection.filters, filter.field, filter.value) })}
              onOpenRecord={openRecord}
              onShowEvents={() => go({ view: "events" })}
            />
          ) : selection.view === "sessions" ? (
            <SessionsView
              sessions={derived.sessions}
              shown={shown.sessions}
              openId={selection.open}
              onToggleSession={(id) => go({ open: id })}
              onOpenRecord={openRecord}
              onShowMore={() => setShown((held) => ({ ...held, sessions: held.sessions + SESSIONS_PAGE }))}
            />
          ) : (
            <EventsView
              merged={derived.merged}
              shown={shown.events}
              events={derived.selected.length}
              expandedId={selection.expand}
              onOpenRecord={openRecord}
              onShowMore={() => setShown((held) => ({ ...held, events: held.events + EVENTS_PAGE }))}
            />
          )}
        </div>
      </div>

      {expanded === null ? null : (
        <RecordDrawer
          id={expanded}
          row={expandedRow}
          rows={rows}
          retentionDays={data.retentionDays}
          opener={opener}
          onClose={() => go({ expand: null })}
          onFilter={(filter) =>
            go({ expand: null, filters: toggleFilter(selection.filters, filter.field, filter.value) })
          }
          /* Show this session clears the brush as well as switching view: the session may well
             have started outside the window the reader was looking at, and a control that
             answered with an empty list would be a control that does nothing. */
          onShowSession={(sessionId) =>
            go({
              expand: null,
              view: "sessions",
              open: sessionId,
              since: bounds.start,
              until: bounds.end,
              brushed: false,
            })
          }
          onOpenRecord={(row) => go({ expand: String(row.id) })}
        />
      )}

      {filterLevel ? (
        <FiltersLevel
          onClose={() => setFilterLevel(false)}
          count={derived.selected.length}
          filters={selection.filters.length}
          onClear={() => go({ filters: [], q: "" })}
        >
          <FacetRail
            titled={false}
            groups={derived.groups}
            selected={derived.selected.length}
            inWindow={derived.inWindow}
            expanded={expandedGroups}
            onToggleValue={(filter) => go({ filters: toggleFilter(selection.filters, filter.field, filter.value) })}
            onToggleGroup={(field) =>
              setExpandedGroups((held) => ({ ...held, [field]: held[field] !== true }))
            }
          />
        </FiltersLevel>
      ) : null}
    </>
  );
}

/** Lanes named at narrow. Four, not six: a 375px strip divided six ways is a band nobody can
 *  read, and a fold that says so is better than six illegible rows. */
const NARROW_LANES = 4;

const HOUR = 3_600_000;

/**
 * The header: the title, what the selection amounts to, the export and the view segment.
 *
 * `Export JSONL` is a plain anchor, never a fetch — the route streams the whole match set in
 * chunks and a browser download is the only consumer that makes sense of that. The segment is a
 * `.segmented` with `aria-current` on the chosen arm, which is both the shared sheet's own active
 * style and the state a screen reader needs.
 */
function Header({
  subtitle,
  exportTo,
  view,
  onView,
}: {
  subtitle: ReactNode;
  /** Absent while the window is still loading: there is nothing yet to export a selection of. */
  exportTo?: string;
  view: AuditView;
  onView: (view: AuditView) => void;
}): ReactNode {
  return (
    <div className="a-head">
      <h1 className="page-title a-ttl">Audit log</h1>
      <p className="note a-sub">{subtitle}</p>
      {/* Two labels, one accessible name. At 375px "Export JSONL" is a third of the title row,
          and the format is on the file it downloads — so the visible word shortens and
          `aria-label` keeps the full one for anyone not reading the pixels. */}
      {exportTo === undefined ? null : (
        <a
          className="btn btn--outline btn--sm a-exp"
          href={exportTo}
          download="audit.jsonl"
          aria-label="Export JSONL"
        >
          <span className="wide-only">Export JSONL</span>
          <span className="narrow-only">Export</span>
        </a>
      )}
      <div className="segmented a-views" role="group" aria-label="View">
        {VIEWS.map((each) => (
          <button
            key={each}
            type="button"
            aria-current={each === view ? "page" : undefined}
            onClick={() => onView(each)}
          >
            {each[0]?.toUpperCase()}
            {each.slice(1)}
          </button>
        ))}
      </div>
    </div>
  );
}

const VIEWS: AuditView[] = ["summary", "sessions", "events"];

/** The window in flight. The strip, the rail and the pane keep their shapes so the page does not
 *  jump when the rows land; Export is absent because there is no selection to export yet. */
function LoadingExplorer({ search }: { search: SearchBag }): ReactNode {
  return (
    <>
      <Header
        subtitle={<SkelBar width="280px" />}
        view={(oneOf(search, "view") as AuditView) || "summary"}
        onView={() => undefined}
      />
      <LaneStripSkeleton />
      <div className="a-body">
        <aside className="card a-rail">
          <FacetRailSkeleton />
        </aside>
        <div className="a-main">
          <div className="card a-pad" aria-busy="true">
            <span className="sr-only">Loading the audit log…</span>
            <div className="a-grid3">
              {[0, 1, 2].map((index) => (
                <div key={index}>
                  <SkelBar width="90px" height={26} />
                  <div style={{ marginTop: 8 }}>
                    <SkelBar width="70%" />
                  </div>
                </div>
              ))}
            </div>
            <SkelBar width="100%" height={64} />
            <div className="a-grid3">
              {[0, 1, 2].map((index) => (
                <div key={index}>
                  {[0, 1, 2, 3].map((row) => (
                    <div key={row} style={{ margin: "4px 0" }}>
                      <SkelBar width="100%" />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/** The read failed. The whole page is one read, so there is nothing to draw around the failure —
 *  the strip, the rail and the views are all functions of rows nobody has. */
function FailedExplorer({ message, onRetry }: { message: string; onRetry: () => void }): ReactNode {
  return (
    <>
      <div className="a-head">
        <h1 className="page-title a-ttl">Audit log</h1>
      </div>
      <div className="empty">
        <div className="empty-title">Couldn&apos;t load the audit log</div>
        <div className="empty-text">{message} Nothing was changed.</div>
        <button type="button" className="btn btn--outline btn--sm" onClick={onRetry}>
          Try again
        </button>
      </div>
    </>
  );
}

const EmptyLedger = (): ReactNode => (
  <div className="card">
    <div className="empty empty--inline">
      <div className="empty-title">Nothing recorded yet</div>
      <div className="empty-text">Calls, approvals and config changes will appear here.</div>
    </div>
  </div>
);

const NothingMatches = ({ onClear }: { onClear: () => void }): ReactNode => (
  <div className="card">
    <div className="empty empty--inline">
      <div className="empty-title">Nothing matches</div>
      <div className="empty-text">Widen the window or drop a filter.</div>
      <button type="button" className="btn btn--outline btn--sm" onClick={onClear}>
        Clear
      </button>
    </div>
  </div>
);

/**
 * The phone's Filters level: the rail's own groups on a full screen, headed `‹ Audit`, under a
 * sticky **Show N events**.
 *
 * A Base UI Dialog for the record's reason — focus trapped, Escape closes, the page behind inert —
 * and open state held here rather than in the URL, because it is a way of reaching the filters
 * rather than a filter: a shared link should open the list, not the drawer over it.
 */
function FiltersLevel({
  onClose,
  count,
  filters,
  onClear,
  children,
}: {
  onClose: () => void;
  count: number;
  filters: number;
  onClear: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <Dialog.Root open onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Popup className="audit-level" data-slot="dialog-content">
          <div className="a-lhead">
            <button type="button" className="a-dback" style={{ display: "inline-flex" }} onClick={onClose}>
              ‹ Audit
            </button>
            <Dialog.Title render={<b />} style={{ fontSize: 14 }}>
              Filters
            </Dialog.Title>
            {filters > 0 ? <span className="badge">{filters} on</span> : null}
            <button type="button" className="btn btn--outline btn--sm a-lclear" onClick={onClear}>
              Clear
            </button>
          </div>
          <div className="a-lbody">{children}</div>
          <div className="a-lfoot">
            <button type="button" className="btn btn--primary" onClick={onClose}>
              Show {fmtCount(count)} events
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** One value of a search key, or "" — the bag holds a repeated key as an array. */
function oneOf(search: SearchBag, key: string): string {
  const held = search[key];
  if (held === undefined) return "";
  return (Array.isArray(held) ? held[0] : held) ?? "";
}
