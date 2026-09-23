import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Page, PageTitle } from "@/chrome/Page";
import { Shell, useDocumentTitle } from "@/chrome/Shell";
import { Note } from "@/chrome/Text";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { useApi } from "@/lib/api-context";
import { paths } from "@/lib/paths";
import { usePreviewTransient } from "@/preview/transient";
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
import { GRID3, SUMMARY, SummaryView } from "./SummaryView";
import { BACK, LEVEL_HEAD, SearchBox, SkelBar, useNarrow, useSlashFocus } from "./parts";

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

  /**
   * The search text as the URL holds it — SETTLED text, always.
   *
   * This page never sees a keystroke (postmortem 2026-09-21). `SearchBox` owns what is being
   * typed and its own debounce, and hands up one value per pause; so a keystroke re-renders the
   * box and nothing else, where writing the URL per character re-derived five thousand rows and
   * reset how far the reader had scrolled — on a real ledger, still "typing re-renders the whole
   * page".
   */
  const q = oneOf(search, "q");
  const window = useQuery(auditWindowQuery(api, q));

  /* The explorer is rendered whenever there are rows to draw — including the PREVIOUS answer
     while a new search loads, which is what `placeholderData` keeps. Only a first load with
     nothing at all falls through to the skeleton, and a failed refetch keeps the rows it had
     and reports itself inside the page rather than replacing it. */
  const data = window.data;
  return (
    <Shell active="audit">
      {/* The workspace's gutters stand; its cards sit 12px apart, as the demo draws them, not the
          24px free-standing cards get — this page is one instrument, not a stack of panels. */}
      <Page shape="workspace" className="gap-3 pt-5 max-md:gap-1.5 max-md:pt-2.5">
        {data === undefined ? (
          window.isError ? (
            <FailedExplorer message={window.error.message} onRetry={() => void window.refetch()} />
          ) : (
            <LoadingExplorer search={search} />
          )
        ) : (
          <Explorer
            data={data}
            search={search}
            searching={window.isPlaceholderData}
            failure={
              window.isError ? { message: window.error.message, retry: () => void window.refetch() } : null
            }
          />
        )}
      </Page>
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
  searching,
  failure,
}: {
  data: AuditWindowResponse;
  search: SearchBag;
  /** A read for a NEW text is in flight, so `data` is the previous answer. */
  searching: boolean;
  /** The last read failed. The rows below are the ones it had before, not nothing. */
  failure: { message: string; retry: () => void } | null;
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
  const [filterLevel, setFilterLevel] = useState(usePreviewTransient().filtersLevel === true);
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

      {/* The filter bar. `data-slot` is what `scripts/audit-search-check.mts` scopes its Clear
          to, since a Clear under "Nothing matches" can be on screen at the same time. On the
          phone, Filters opens the level the hidden rail's groups move to, and it and the search
          share one row. */}
      <div data-slot="filter-bar" className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          className="hidden max-md:flex max-md:flex-[0_0_auto] max-md:px-3.5"
          onClick={() => setFilterLevel(true)}
        >
          Filters{selection.filters.length > 0 ? ` · ${selection.filters.length}` : ""}
        </Button>
        {/* A held filter: its field dim, its value, and the × that drops it. Not a Badge: a
            24px mono chip that clips its own square remove button, 44px on the phone. */}
        {selection.filters.map((filter) => (
          <span
            className="inline-flex h-control-xs items-center overflow-hidden rounded-[7px] bg-muted font-mono text-xs max-md:h-control-touch max-md:rounded-[9px]"
            key={`${filter.field}:${filter.value}`}
          >
            <span className="pr-1 pl-2.5 text-muted-foreground">{filter.field}</span>
            <span className="pr-1">{filter.value}</span>
            <button
              type="button"
              className="size-control-xs cursor-pointer border-0 bg-transparent p-0 text-ring hover:bg-border hover:text-foreground max-md:size-control-touch"
              aria-label={`Remove the ${filter.field} filter ${filter.value}`}
              onClick={() =>
                go({ filters: selection.filters.filter((held) => held !== filter) })
              }
            >
              ×
            </button>
          </span>
        ))}
        {/* One write per pause. `initial` is the settled text and the box re-seeds from it only
            when something OTHER than the box changed it — Clear, below, is exactly that. */}
        <SearchBox
          inputRef={searchRef}
          initial={selection.q}
          onSettled={(next) => go({ q: next })}
          debounceMs={SEARCH_DEBOUNCE_MS}
          placeholder="Search events and bodies…  ( / )"
          label="Search events and bodies"
          busy={searching}
          className="min-w-[260px] max-md:h-control-touch max-md:min-w-0 max-md:flex-[1_1_120px]"
        />
        {selection.filters.length > 0 || selection.q !== "" ? (
          <Button variant="outline" size="sm" onClick={() => go({ filters: [], q: "" })}>
            Clear
          </Button>
        ) : null}
      </div>

      {/* A failed search REPORTS itself and leaves the rows it had. Replacing the page with an
          error card would throw away an answer that is still on screen and still true. */}
      {failure === null ? null : (
        <Alert variant="danger" role="status">
          {failure.message} The rows below are the last answer.{" "}
          <Button variant="outline" size="sm" onClick={failure.retry}>
            Try again
          </Button>
        </Alert>
      )}

      <div className={BODY}>
        <Card size="flush" render={<aside />} className={RAIL}>
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
        </Card>
        {/* Dimmed while a new search loads, so the rows read as the PREVIOUS answer rather than
            as the one being typed — and still readable, because they are still true. A skeleton
            here is what tore the page down (postmortem 2026-09-21). */}
        <div className={searching ? `${MAIN} opacity-55 [transition:opacity_0.12s]` : MAIN} aria-busy={searching}>
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
 * chunks and a browser download is the only consumer that makes sense of that. The segment is
 * Tabs: three in-page readings of one selection, the current one `aria-selected`.
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
    <div className={HEAD}>
      <PageTitle className="[grid-area:ttl]">Audit log</PageTitle>
      <Note className="[grid-area:sub]">{subtitle}</Note>
      {/* Two labels, one accessible name. At 375px "Export JSONL" is a third of the title row,
          and the format is on the file it downloads — so the visible word shortens and
          `aria-label` keeps the full one for anyone not reading the pixels. */}
      {exportTo === undefined ? null : (
        <a
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "[grid-area:exp] max-md:px-3.5")}
          href={exportTo}
          download="audit.jsonl"
          aria-label="Export JSONL"
        >
          <span className="max-md:hidden">Export JSONL</span>
          <span className="hidden max-md:inline">Export</span>
        </a>
      )}
      <Tabs value={view} onValueChange={(next) => onView(next as AuditView)} className="[grid-area:seg]">
        <TabsList aria-label="View" className="max-md:mt-0.5">
          {VIEWS.map((each) => (
            <TabsTrigger key={each} value={each} className="max-md:flex-1">
              {each[0]?.toUpperCase()}
              {each.slice(1)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}

const VIEWS: AuditView[] = ["summary", "sessions", "events"];

/** The head's two rows of title with the actions beside them, as a grid so the phone can
 *  re-area the same markup rather than reorder it: title and export on one row, the subtitle
 *  under them, the segment full width under that. */
const HEAD =
  "grid grid-cols-[1fr_auto_auto] items-center gap-x-3 [grid-template-areas:'ttl_exp_seg'_'sub_exp_seg'] max-md:grid-cols-[1fr_auto] max-md:gap-y-1 max-md:[grid-template-areas:'ttl_exp'_'sub_sub'_'seg_seg']";

/**
 * The rail beside the main pane. At the regular tier the rail goes above it, and the pane
 * keeps its own content width. On the phone the column STRETCHES, not the wide tier's
 * `flex-start`: that one declaration is the difference between a page that fits and one that
 * scrolls sideways, because a column that sizes each child to its content let the events table
 * take the width of its widest unbreakable line, and the card and the page went with it.
 */
const BODY = "flex items-start gap-3 md:max-lg:flex-col max-md:flex-col max-md:items-stretch";

/** Sticky, because the rail is how the reader narrows a long list and scrolling the list must
 *  not take the controls off screen. Above the pane at the regular tier, a wrapping row of
 *  groups; gone on the phone, where Filters opens its groups as a level. */
const RAIL =
  "sticky top-3 max-h-[calc(100vh-24px)] w-rail flex-none overflow-auto px-2 py-2.5 md:max-lg:static md:max-lg:flex md:max-lg:max-h-none md:max-lg:w-full md:max-lg:flex-wrap md:max-lg:gap-x-6 md:max-lg:gap-y-0 md:max-lg:px-3.5 md:max-lg:py-3 max-md:hidden";

/** The pane the views draw in. */
const MAIN = "flex min-w-0 flex-1 flex-col gap-3";

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
      <div className={BODY}>
        <Card size="flush" render={<aside />} className={RAIL}>
          <FacetRailSkeleton />
        </Card>
        <div className={MAIN}>
          <Card size="flush" className={SUMMARY} aria-busy="true">
            <span className="sr-only">Loading the audit log…</span>
            <div className={GRID3}>
              {[0, 1, 2].map((index) => (
                <div key={index}>
                  <SkelBar width="90px" height={26} />
                  <div className="mt-2">
                    <SkelBar width="70%" />
                  </div>
                </div>
              ))}
            </div>
            <SkelBar width="100%" height={64} />
            <div className={GRID3}>
              {[0, 1, 2].map((index) => (
                <div key={index}>
                  {[0, 1, 2, 3].map((row) => (
                    <div key={row} className="my-1">
                      <SkelBar width="100%" />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </Card>
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
      <div className={HEAD}>
        <PageTitle className="[grid-area:ttl]">Audit log</PageTitle>
      </div>
      <Empty>
        <EmptyTitle>Couldn&apos;t load the audit log</EmptyTitle>
        <EmptyDescription>{message} Nothing was changed.</EmptyDescription>
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      </Empty>
    </>
  );
}

const EmptyLedger = (): ReactNode => (
  <Card size="flush">
    <Empty variant="inline">
      <EmptyTitle>Nothing recorded yet</EmptyTitle>
      <EmptyDescription>Calls, approvals and config changes will appear here.</EmptyDescription>
    </Empty>
  </Card>
);

const NothingMatches = ({ onClear }: { onClear: () => void }): ReactNode => (
  <Card size="flush">
    <Empty variant="inline">
      <EmptyTitle>Nothing matches</EmptyTitle>
      <EmptyDescription>Widen the window or drop a filter.</EmptyDescription>
      <Button variant="outline" size="sm" className="mt-4" onClick={onClear}>
        Clear
      </Button>
    </Empty>
  </Card>
);

/**
 * The phone's Filters level: the rail's own groups on a full screen, headed `‹ Audit`, under a
 * sticky **Show N events**.
 *
 * A Sheet for the record's reason — focus trapped, Escape closes, the page behind inert — and
 * open state held here rather than in the URL, because it is a way of reaching the filters
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
    <Sheet open onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent variant="level">
        <div className={LEVEL_HEAD}>
          {/* A level is always a level, so its way back shows at every width. */}
          <button type="button" className={`${BACK} inline-flex`} onClick={onClose}>
            ‹ Audit
          </button>
          <SheetTitle render={<b />} className="text-base">
            Filters
          </SheetTitle>
          {filters > 0 ? <Badge>{filters} on</Badge> : null}
          <Button variant="outline" size="sm" className="ml-auto" onClick={onClear}>
            Clear
          </Button>
        </div>
        <div className="flex-1 overflow-auto px-2 pt-2 pb-3">{children}</div>
        <div className="sticky bottom-0 flex border-t bg-background px-4 py-3">
          <Button className="h-control-touch flex-1" onClick={onClose}>
            Show {fmtCount(count)} events
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** One value of a search key, or "" — the bag holds a repeated key as an array. */
function oneOf(search: SearchBag, key: string): string {
  const held = search[key];
  if (held === undefined) return "";
  return (Array.isArray(held) ? held[0] : held) ?? "";
}
