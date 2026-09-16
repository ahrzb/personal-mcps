/**
 * /audit — read-only view over audit.query's exact filters (§13): a filter bar,
 * four summary tiles, an events-over-time chart, the newest-first event table
 * with an addressable expanded-row detail (recorded bodies, BodyStub
 * placeholders, client/session metadata), Export JSONL, and paging — desktop
 * numbered range + arrows, mobile "Load more". One template: narrow-only /
 * wide-only pairs are the two presentations of the same props, never two
 * datasets (model.ts).
 *
 * Pure `(props) => JSX`: every string shown is derived from AuditProps and
 * `paths`; nothing here fetches, reads a cookie, or calls Date.now().
 */

import type { FC } from "hono/jsx";
import { paths } from "./model";
import type { AuditEventRow, AuditFilters, AuditLinkQuery, AuditProps } from "./model";
import { Layout } from "./layout";

/* ------------------------------------------------------------------ *
 * Formatting — pure functions over the epoch-ms/number values in props.
 * UTC throughout, so a fixture renders byte-identically regardless of host
 * timezone.
 * ------------------------------------------------------------------ */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number): string => String(n).padStart(2, "0");

function fmtMonthDay(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  return `${fmtMonthDay(ms)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

function fmtDateTimeShort(ms: number): string {
  const d = new Date(ms);
  return `${fmtMonthDay(ms)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** The histogram caption's unit — minutes under an hour, hours above, one decimal at most:
 *  150 000 ms → "2.5-minute", 6 h → "6-hour". Nearly every custom span is fractional. */
function fmtBucket(ms: number): string {
  const trim = (n: number): string => String(Number(n.toFixed(1)));
  return ms < 3_600_000 ? `${trim(ms / 60_000)}-minute` : `${trim(ms / 3_600_000)}-hour`;
}

function fmtDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const fmtNumber = (n: number): string => NUMBER_FORMAT.format(n);

function fmtSignedPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n}%`;
}

/** A stub's size as §13 spells it: KB under a megabyte, MB with one decimal above. A
 *  20 KB body reading "0.0 MB" is a size nobody can act on, which is the whole point of
 *  showing one instead of the bytes. */
function fmtSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function rangeNoun(range: AuditFilters["range"]): string {
  switch (range) {
    case "1h":
      return "previous hour";
    case "24h":
      return "previous 24 hours";
    case "7d":
      return "previous 7 days";
    case "30d":
      return "previous 30 days";
    default:
      return "previous period";
  }
}

/** One representative epoch-ms per distinct UTC calendar day among the buckets,
 *  in order — the day axis under the bars (independent of how many buckets fall
 *  on a given day). */
function uniqueDays(buckets: { start: string }[]): number[] {
  const seen = new Set<string>();
  const days: number[] = [];
  for (const bucket of buckets) {
    const ms = Date.parse(bucket.start);
    const key = new Date(ms).toISOString().slice(0, 10);
    if (!seen.has(key)) {
      seen.add(key);
      days.push(ms);
    }
  }
  return days;
}

/* ------------------------------------------------------------------ *
 * Recorded bodies — a masked JSON object or a whole-body stand-in, rendered as
 * a typed size placeholder and never as bytes (§15).
 * ------------------------------------------------------------------ */

type BodyStubLike = { stub: "blob" | "oversize"; contentType?: string; bytes: number };

function isBodyStub(v: unknown): v is BodyStubLike {
  if (typeof v !== "object" || v === null || !("stub" in v) || !("bytes" in v)) return false;
  const stub = (v as { stub: unknown }).stub;
  return stub === "blob" || stub === "oversize";
}

function stubLabel(s: BodyStubLike): string {
  return s.stub === "blob"
    ? `‹blob ${s.contentType ?? "unknown"} · ${fmtSize(s.bytes)}›`
    : `‹oversize · ${fmtSize(s.bytes)}›`;
}

/** A recorded body (or a small `detail` object) as one compact line, with any
 *  embedded BodyStub swapped for its typed placeholder. */
function renderBody(body: Record<string, unknown> | BodyStubLike | undefined): string | null {
  if (body === undefined) return null;
  if (isBodyStub(body)) return stubLabel(body);
  return JSON.stringify(body, (_key, value) => (isBodyStub(value) ? stubLabel(value) : value));
}

/* ------------------------------------------------------------------ *
 * Outcome vocabulary → badge. "ok" is neutral; -32003 (approval required) and
 * -32002 (refused because archived) read as warnings; -32001/-32000 (denied)
 * and "error" read as danger — matching the two coded refusals the artboard
 * actually shows (Audit.dc.html).
 * ------------------------------------------------------------------ */

function outcomeInfo(outcome: string): { label: string; variant: "outline" | "warning" | "danger" } {
  switch (outcome) {
    case "ok":
      return { label: "ok", variant: "outline" };
    case "-32003":
      return { label: "approval", variant: "warning" };
    case "-32002":
      return { label: "archived", variant: "warning" };
    case "-32001":
    case "-32000":
      return { label: "denied", variant: "danger" };
    case "error":
      return { label: "error", variant: "danger" };
    default:
      return { label: outcome, variant: "outline" };
  }
}

const OutcomeBadge: FC<{ outcome: string }> = ({ outcome }) => {
  const info = outcomeInfo(outcome);
  return <span class={`badge badge--${info.variant}`}>{info.label}</span>;
};

/* ------------------------------------------------------------------ *
 * Icons — inline, matching the artboards' stroke icons exactly.
 * ------------------------------------------------------------------ */

const IconSearch: FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7"></circle>
    <path d="m21 21-4.3-4.3"></path>
  </svg>
);

const IconDownload: FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
    <path d="m7 10 5 5 5-5"></path>
    <path d="M12 15V3"></path>
  </svg>
);

const IconChevronDown: FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m6 9 6 6 6-6"></path>
  </svg>
);

const IconChevronLeft: FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m15 18-6-6 6-6"></path>
  </svg>
);

const IconChevronRight: FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m9 18 6-6-6-6"></path>
  </svg>
);

/* ------------------------------------------------------------------ *
 * Links — every href on this page is `paths.auditWith`/`auditExport` applied
 * to the current filters plus a narrow override; never a hand-built string.
 * ------------------------------------------------------------------ */

/** Exactly the AuditQuery-shaped fields of the current filters — the base every
 *  link (a range preset, the pager, the session link, the export) starts from. */
function baseQuery(filters: AuditFilters): AuditLinkQuery {
  return {
    principal: filters.principal,
    app: filters.app,
    event: filters.event,
    tool: filters.tool,
    session: filters.session,
    since: filters.since,
    until: filters.until,
    limit: filters.limit,
    offset: filters.offset,
  };
}

function auditLink(filters: AuditFilters, overrides: Partial<AuditLinkQuery>): string {
  return paths.auditWith({ ...baseQuery(filters), ...overrides });
}

const RANGE_MS: Record<"1h" | "24h" | "7d" | "30d", number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const RangeSegment: FC<{ filters: AuditFilters; now: string }> = ({ filters, now }) => {
  const nowMs = Date.parse(now);
  return (
    <div class="segmented">
      {(Object.keys(RANGE_MS) as (keyof typeof RANGE_MS)[]).map((key) => (
        <a
          href={auditLink(filters, { since: nowMs - RANGE_MS[key], until: nowMs, offset: 0 })}
          aria-current={filters.range === key ? "page" : undefined}
        >
          {key}
        </a>
      ))}
    </div>
  );
};

/* ------------------------------------------------------------------ *
 * One event row — a summary <tr> (desktop columns, hidden narrow; a compact
 * `.cell-summary` cell, hidden wide) plus, only when this row is `expandedId`,
 * a sibling `.row-detail` <tr> with the EVENT DETAIL panel (§13). Both <tr>s
 * come back from one component as a Fragment, which flattens into the table.
 * ------------------------------------------------------------------ */

function hasDetail(row: AuditEventRow): boolean {
  return Boolean(row.client || row.detail || row.args || row.result || row.noBodies);
}

/** §13's one sentence per reason a call row carries no bodies, so no panel is ever blank.
 *  Prose, not a body — hence `.detail-meta` beside the client line rather than the
 *  monospace `.detail-body` the recorded JSON gets. Exported because the agent page's
 *  Activity pane draws the same audit row and owes the reader the same three sentences;
 *  two copies would be two answers to "why is this blank". */
export const NO_BODIES_SENTENCE: Record<NonNullable<AuditEventRow["noBodies"]>, string> = {
  off: "Call bodies aren't recorded for this app (body logging is off).",
  refused: "Refused before the call was made, so there are no bodies to show.",
  unrecorded: "No bodies were recorded for this call.",
};

/** The chevron IS the expand control (G1, 2026-09-03): with no script on the page,
 *  opening a row is a reload of this same view with `?expand=<id>` — the filters ride
 *  along, and the open row's chevron links back without it. One icon for both states:
 *  `.row-open` rotates it, so the script below can flip a row without redrawing markup. */
const ExpandLink: FC<{ row: AuditEventRow; filters: AuditFilters; open: boolean }> = ({ row, filters, open }) => (
  <a
    class="row-toggle"
    aria-label={open ? "Hide detail" : "Show detail"}
    aria-expanded={open ? "true" : "false"}
    href={auditLink(filters, { expand: open ? undefined : row.id })}
  >
    <IconChevronDown />
  </a>
);

/**
 * Opening a row in place (2026-09-03): every expandable row's detail is already in the
 * page, hidden, so a click only flips `hidden` on the sibling detail row — no request, no
 * reload — closes whichever row was open (the server model is one open row), and mirrors
 * the state into the address with the chevron's own href, so a refresh or a shared link
 * reproduces it. The href, label and aria-expanded of the flipped rows are rewritten to
 * what the server would have rendered for that state. Scripting off: the href navigates.
 */
const TOGGLE_SCRIPT = `document.addEventListener("click",function(e){
var a=e.target.closest?e.target.closest("a.row-toggle"):null;if(!a)return;
var detail=a.closest("tr").nextElementSibling;
if(!detail||!detail.classList.contains("row-detail"))return;
e.preventDefault();
var to=a.href,opening=detail.hidden;
document.querySelectorAll("tr.row-detail:not([hidden])").forEach(function(d){set(d,false)});
if(opening)set(detail,true);
history.replaceState(null,"",to);
function set(d,open){d.hidden=!open;var row=d.previousElementSibling;row.classList.toggle("row-open",open);
var id=d.id.slice("detail-".length);
row.querySelectorAll("a.row-toggle").forEach(function(l){var u=new URL(l.href);
if(open){u.searchParams.delete("expand");u.hash=""}else{u.searchParams.set("expand",id);u.hash="#event-"+id}
l.href=u.toString();l.setAttribute("aria-expanded",open?"true":"false");l.setAttribute("aria-label",open?"Hide detail":"Show detail")})}
});`;

function mobileMeta(row: AuditEventRow): string {
  const parts = [fmtDateTimeShort(row.ts), row.principal];
  if (row.app) parts.push(row.app);
  if (row.durationMs !== undefined) parts.push(fmtDuration(row.durationMs));
  return parts.join(" · ");
}

const EventDetail: FC<{ row: AuditEventRow; filters: AuditFilters }> = ({ row, filters }) => {
  const summaryLine = renderBody(row.detail);
  const argsLine = renderBody(row.args);
  const resultLine = renderBody(row.result);
  const client = row.client;
  const clientLabel = client?.name ? (client.version ? `${client.name} ${client.version}` : client.name) : null;
  return (
    <div class="detail">
      <div class="eyebrow">Event detail</div>
      {summaryLine !== null && <div class="detail-body">{summaryLine}</div>}
      {argsLine !== null && <div class="detail-body">Arguments: {argsLine}</div>}
      {resultLine !== null && <div class="detail-body">Result: {resultLine}</div>}
      {row.noBodies && <div class="detail-meta">{NO_BODIES_SENTENCE[row.noBodies]}</div>}
      {client && (clientLabel || client.sessionId) && (
        <div class="detail-meta">
          Client: {clientLabel ?? "unknown"}
          {client.sessionId && (
            <>
              {" "}
              · session{" "}
              <a href={auditLink(filters, { session: client.sessionId, offset: 0 })}>{client.sessionId}</a>
            </>
          )}
        </div>
      )}
    </div>
  );
};

const EventRow: FC<{ row: AuditEventRow; filters: AuditFilters; expandedId: number | null }> = ({
  row,
  filters,
  expandedId,
}) => {
  const isOpen = row.id === expandedId;
  const expandable = hasDetail(row);
  return (
    <>
      {/* The anchor an opening chevron's `#event-<id>` names, so the scripting-off reload
          lands on the row it opened (§13). */}
      <tr class={isOpen ? "row-open" : undefined} id={`event-${row.id}`}>
        <td class="wide-only cell-time">{fmtDateTime(row.ts)}</td>
        <td class="wide-only cell-mono">{row.principal}</td>
        <td class="wide-only">{row.event}</td>
        <td class="wide-only">{row.app ?? <span class="cell-muted">—</span>}</td>
        <td class="wide-only cell-mono">{row.tool ?? "—"}</td>
        <td class="wide-only cell-num">{row.durationMs !== undefined ? fmtDuration(row.durationMs) : "—"}</td>
        <td class="wide-only">
          {expandable ? (
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
              <OutcomeBadge outcome={row.outcome} />
              <ExpandLink row={row} filters={filters} open={isOpen} />
            </div>
          ) : (
            <OutcomeBadge outcome={row.outcome} />
          )}
        </td>
        <td class="cell-summary">
          <div>
            <div class={row.tool ? "cell-strong mono" : "cell-strong"}>{row.tool ?? row.event}</div>
            <div class="muted">{mobileMeta(row)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
            <OutcomeBadge outcome={row.outcome} />
            {expandable && <ExpandLink row={row} filters={filters} open={isOpen} />}
          </div>
        </td>
      </tr>
      {/* Every expandable row's detail rides the page, hidden unless addressed, so the
          toggle script can open it without a request. ponytail: worst case 50 rows × two
          16 KB bodies of hidden HTML; fetch the detail per row if pages get heavy. */}
      {expandable && (
        <tr class="row-detail" id={`detail-${row.id}`} hidden={isOpen ? undefined : true}>
          <td colspan={7}>
            <EventDetail row={row} filters={filters} />
          </td>
        </tr>
      )}
    </>
  );
};

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export const AuditPage: FC<AuditProps> = (props) => {
  const {
    now,
    username,
    pendingApprovals,
    filters,
    options,
    rows,
    paging,
    stats,
    histogram,
    expandedId,
    retentionDays,
    scanCeiling,
  } = props;
  // §13/G22: the same constant that bounds the tiles/histogram also caps the scan the
  // three filter selects are read from, so one note covers both — empty once the window
  // is small enough for `stats`/`histogram`/`options` to already be exact.
  const scanNote = scanCeiling !== null ? ` · over the newest ${fmtNumber(scanCeiling)}` : "";
  const currentQuery = baseQuery(filters);
  const rangeStart = paging.total === 0 ? 0 : paging.offset + 1;
  const rangeEnd = Math.min(paging.offset + paging.limit, paging.total);
  const hasPrev = paging.offset > 0;
  const hasNext = paging.offset + paging.limit < paging.total;
  const loadMoreLimit = Math.min(paging.total, paging.offset + paging.limit * 2);
  const peak = histogram.peak;
  // The two carriers of the window: a typed pair of days when the window is custom, a
  // hidden preset key otherwise — so a select's onchange, the pager and an untouched
  // Apply hand the preset back anchored to now, exactly as its segment's link would.
  const custom = filters.range === "custom";
  const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

  return (
    <Layout title="Audit log · personal-mcps" active="audit" username={username} pendingApprovals={pendingApprovals}>
      <main class="page">
        <div class="page-head">
          <div>
            <h1 class="page-title">Audit log</h1>
            <p class="page-subtitle wide-only">
              Tool calls, admin changes, and auth events. Kept for {retentionDays} days — export JSONL to archive.
            </p>
            <p class="page-subtitle narrow-only">
              {fmtNumber(paging.total)} events · kept for {retentionDays} days
            </p>
          </div>
          <a class="btn btn--outline btn--sm wide-only" href={paths.auditExport(currentQuery)}>
            <IconDownload />
            <span>Export JSONL</span>
          </a>
        </div>

        <form id="audit-filters" class="section" method="get" action={paths.audit}>
          {filters.session && <input type="hidden" name="session" value={filters.session} />}
          <input type="hidden" name="offset" value="0" />
          {!custom && <input type="hidden" name="range" value={filters.range} />}

          {/* .filter-group ties these two rows together so the narrow breakpoint can
              flatten (`.filters{display:contents}`) and reorder them as one sequence —
              MobileAudit.dc.html's control order doesn't match either row on its own
              (the tool search box moves after the selects; agents/apps pair up). */}
          <div class="filter-group">
            <div class="filters">
              <RangeSegment filters={filters} now={now} />
              {/* The window the owner can type: whole UTC days, the only two controls
                  named since/until (a hidden pair of the same names would be the values
                  the loader read). Empty on a preset — the segment is its indicator. */}
              <div class="filter-pair">
                <input type="date" name="since" aria-label="From" value={custom ? isoDay(filters.since) : ""} />
                <input type="date" name="until" aria-label="To" value={custom ? isoDay(filters.until) : ""} />
              </div>
              <div class="spacer wide-only"></div>
              <div class="input-group filter-tool">
                <IconSearch />
                <input type="search" name="tool" placeholder="Filter by tool…" value={filters.tool ?? ""} />
              </div>
            </div>

            <div class="filters">
              <div class="filter-pair">
                <select name="principal" onchange="this.form.submit()">
                  <option value="">All agents</option>
                  {options.principals.map((p) => (
                    <option value={p} selected={p === filters.principal ? true : undefined}>
                      {p}
                    </option>
                  ))}
                </select>
                <select name="app" onchange="this.form.submit()">
                  <option value="">All apps</option>
                  {options.apps.map((s) => (
                    <option value={s} selected={s === filters.app ? true : undefined}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <select name="event" onchange="this.form.submit()">
                <option value="">All events</option>
                {options.events.map((e) => (
                  <option value={e} selected={e === filters.event ? true : undefined}>
                    {e}
                  </option>
                ))}
              </select>
              <div class="spacer wide-only"></div>
              <div class="wide-only" style="display:flex;align-items:center;gap:12px">
                <span class="note">{fmtNumber(paging.total)} events match</span>
                <a class="btn btn--ghost btn--sm" href={paths.audit}>
                  Clear filters
                </a>
              </div>
              {/* The one way to apply the typed fields with scripting off (§9 rule 4(b)),
                  and what makes Return submit a form with three text fields. A direct
                  child of this row, never inside the wide-only block: that block is
                  display:none at the narrow breakpoint, where the control is needed most. */}
              <button type="submit" class="btn btn--outline btn--sm">
                Apply
              </button>
            </div>
          </div>

          {filters.session && (
            <p class="note">
              Filtered to session <span class="mono">{filters.session}</span> ·{" "}
              <a href={auditLink(filters, { session: undefined, offset: 0 })}>Clear session filter</a>
            </p>
          )}

          <a class="btn btn--outline btn--block narrow-only" href={paths.auditExport(currentQuery)}>
            <IconDownload />
            <span>Export JSONL</span>
          </a>
        </form>

        <div class="stat-grid">
          <div class="stat">
            <div class="stat-label">Events</div>
            <div class="stat-value">{fmtNumber(stats.events)}</div>
            <div class="stat-hint">
              {stats.eventsDeltaPct !== null
                ? `${fmtSignedPct(stats.eventsDeltaPct)} vs ${rangeNoun(filters.range)}`
                : "No comparison available"}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">Tool calls</div>
            <div class="stat-value">{fmtNumber(stats.toolCalls)}</div>
            <div class="stat-hint">
              {stats.events > 0 ? `${Math.round((stats.toolCalls / stats.events) * 100)}% of all events${scanNote}` : "—"}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">Denied</div>
            <div class="stat-value stat-value--danger">{fmtNumber(stats.denied)}</div>
            <div class="stat-hint">
              {stats.events > 0 ? `${((stats.denied / stats.events) * 100).toFixed(1)}% deny rate${scanNote}` : "—"}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">Median latency</div>
            <div class="stat-value">{stats.medianDurationMs !== null ? fmtDuration(stats.medianDurationMs) : "—"}</div>
            <div class="stat-hint">
              {stats.p95DurationMs !== null ? `p95 ${fmtDuration(stats.p95DurationMs)}${scanNote}` : `No timed calls${scanNote}`}
            </div>
          </div>
        </div>

        <div class="card card--pad">
          <div class="chart">
            <div class="chart-head">
              <span class="chart-title wide-only">Events over time</span>
              <span class="muted wide-only">{fmtBucket(histogram.bucketMs)} buckets{scanNote}</span>
              <span class="chart-title narrow-only">Events per day{scanNote}</span>
            </div>
            <div class="chart-bars">
              {histogram.buckets.length === 0 ? (
                <div class="note center" style="width:100%">
                  No events in this window.
                </div>
              ) : (
                histogram.buckets.map((bucket) => (
                  <div
                    class={peak > 0 && bucket.count === peak ? "chart-bar chart-bar--peak" : "chart-bar"}
                    style={`height:${peak > 0 ? (bucket.count / peak) * 100 : 0}%`}
                    title={`${fmtDateTime(Date.parse(bucket.start))} · ${fmtNumber(bucket.count)} events`}
                  ></div>
                ))
              )}
            </div>
            {histogram.buckets.length > 0 && (
              <div class="chart-axis">
                {uniqueDays(histogram.buckets).map((day) => (
                  <div style="text-align:center">
                    <span class="wide-only">{fmtMonthDay(day)}</span>
                    <span class="narrow-only">{new Date(day).getUTCDate()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {rows.length > 0 ? (
          <div class="card">
            <div class="narrow-only">
              <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border)">
                <span class="muted" style="font-weight:500">Latest events</span>
                <span class="note">newest first</span>
              </div>
            </div>
            <table class="table table--fixed">
              <colgroup>
                <col style="width:150px" />
                <col style="width:130px" />
                <col style="width:160px" />
                <col style="width:100px" />
                <col style="width:150px" />
                <col style="width:80px" />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th class="wide-only">Time</th>
                  <th class="wide-only">Principal</th>
                  <th class="wide-only">Event</th>
                  <th class="wide-only">App</th>
                  <th class="wide-only">Tool</th>
                  <th class="wide-only" style="text-align:right">
                    Duration
                  </th>
                  <th class="wide-only">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <EventRow row={row} filters={filters} expandedId={expandedId} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div class="empty">
            <div class="empty-title">No events in this range</div>
            <div class="empty-text">
              Try a wider time range or clear the filters. A fresh namespace fills up once an agent calls a tool.
            </div>
            <a class="btn btn--ghost" href={paths.audit}>
              Clear filters
            </a>
          </div>
        )}

        {rows.length > 0 && (
          <div class="pager wide-only">
            <div class="pager-group">
              <span class="muted">Rows per page</span>
              <select name="limit" form="audit-filters" onchange="this.form.submit()">
                {[25, 50, 100].map((n) => (
                  <option value={n} selected={n === filters.limit ? true : undefined}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div class="pager-group">
              <span class="pager-info">
                {fmtNumber(rangeStart)}–{fmtNumber(rangeEnd)} of {fmtNumber(paging.total)}
              </span>
              <div class="actions">
                {hasPrev ? (
                  <a class="btn-icon" href={auditLink(filters, { offset: Math.max(0, paging.offset - paging.limit) })}>
                    <IconChevronLeft />
                  </a>
                ) : (
                  <span class="btn-icon" aria-disabled="true">
                    <IconChevronLeft />
                  </span>
                )}
                {hasNext ? (
                  <a class="btn-icon" href={auditLink(filters, { offset: paging.offset + paging.limit })}>
                    <IconChevronRight />
                  </a>
                ) : (
                  <span class="btn-icon" aria-disabled="true">
                    <IconChevronRight />
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {rows.length > 0 && (
          <div class="narrow-only">
            <div style="display:flex;flex-direction:column;gap:8px">
              {hasNext && (
                <a class="btn btn--outline btn--block" href={auditLink(filters, { limit: loadMoreLimit, offset: 0 })}>
                  Load more
                </a>
              )}
              <p class="note center">
                Showing {fmtNumber(rangeEnd)} of {fmtNumber(paging.total)} · entries prune after {retentionDays} days
              </p>
            </div>
          </div>
        )}
        {rows.length > 0 && <script dangerouslySetInnerHTML={{ __html: TOGGLE_SCRIPT }} />}
      </main>
    </Layout>
  );
};

export default AuditPage;
