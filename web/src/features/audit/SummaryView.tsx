import type { ReactNode } from "react";
import type { AuditWindowRow } from "@/lib/types";
import { changesOf, fmtCount, fmtDayTime, fmtDuration, refusalPairsOf, summaryOf, topOf } from "./derive";
import type { FilterField, Filter, Insight } from "./derive";

/** How many recent changes the panel lists. Five, because it sits beside a four-bar chart and
 *  the point is "what did I change lately", not a second log. */
const CHANGES_SHOWN = 5;

/**
 * Summary — the page as an ANSWER rather than as a record: three numbers, the three things
 * worth looking at, and the shapes of the week.
 *
 * Everything on it is a control. A tile is a fact, but every bar, every "worth a look" line
 * and every change opens the rows behind it, because the question after "214 refusals" is
 * always "which ones".
 */
export function SummaryView({
  rows,
  insights,
  /** Applies a filter and switches to Events — what every **show me** and every bar does. */
  onDrillTo,
  onToggleFilter,
  onOpenRecord,
  onShowEvents,
}: {
  rows: AuditWindowRow[];
  insights: Insight[];
  onDrillTo: (filters: Filter[]) => void;
  onToggleFilter: (filter: Filter) => void;
  onOpenRecord: (row: AuditWindowRow, opener: HTMLElement) => void;
  onShowEvents: () => void;
}): ReactNode {
  const stats = summaryOf(rows);
  // Newest first, because that is the order the rows arrive in — the five most recent changes,
  // not the five oldest. (The prototype sliced from the end and reversed, which was right for
  // its ascending fixture and exactly wrong for the API.)
  const changes = changesOf(rows).slice(0, CHANGES_SHOWN);

  return (
    <div className="card a-pad">
      <div className="a-grid3">
        <div>
          <div className="a-stat-v">{fmtCount(stats.events)}</div>
          <div className="a-stat-l">events · {fmtCount(stats.calls)} tool calls</div>
        </div>
        <div>
          <div className={stats.refused > 0 ? "a-stat-v a-stat-v--bad" : "a-stat-v"}>{fmtCount(stats.refused)}</div>
          <div className="a-stat-l">refused or waiting on you</div>
        </div>
        <div>
          <div className="a-stat-v">{fmtDuration(stats.median ?? undefined)}</div>
          <div className="a-stat-l">median call · p95 {fmtDuration(stats.p95 ?? undefined)}</div>
        </div>
      </div>

      {insights.length === 0 ? null : (
        <div className="a-look">
          <p className="eyebrow">Worth a look</p>
          <ul>
            {insights.map((insight, index) => (
              <li key={index}>
                {insight.parts.map((part, at) =>
                  part.style === "strong" ? (
                    <b key={at}>{part.text}</b>
                  ) : part.style === "mono" ? (
                    <span className="mono" key={at}>
                      {part.text}
                    </span>
                  ) : (
                    <span key={at}>{part.text}</span>
                  ),
                )}{" "}
                <button type="button" onClick={() => onDrillTo(insight.filters)}>
                  show me
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="a-grid3">
        <Bars label="Agents" rows={rows} field="principal" onPick={onToggleFilter} />
        <Bars label="Apps" rows={rows} field="app" onPick={onToggleFilter} />
        <Bars label="Tools" rows={rows} field="tool" onPick={onToggleFilter} />
      </div>

      <div className="a-grid2">
        <div>
          <p className="eyebrow">Refusals</p>
          <Refusals rows={rows} onPick={onToggleFilter} />
        </div>
        <div>
          <p className="eyebrow">Changes you made</p>
          {changes.length === 0 ? (
            <p className="note">None this window.</p>
          ) : (
            <div className="a-changes">
              {changes.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className="a-frow"
                  onClick={(event) => onOpenRecord(row, event.currentTarget)}
                >
                  <span className="a-nm">{row.event}</span>
                  <span className="a-ct">{fmtDayTime(row.ts)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="a-foot">
        <span className="note">The log itself is a click away — this page is the answer, not the record.</span>
        <button type="button" className="btn btn--primary btn--sm" onClick={onShowEvents}>
          All {fmtCount(stats.events)} events →
        </button>
      </div>
    </div>
  );
}

/** How many bars one panel draws. Four, because three panels sit side by side and a fifth row
 *  pushes the panel taller than the tiles above it without answering a new question. */
const BARS = 4;

function Bars({
  label,
  rows,
  field,
  onPick,
}: {
  label: string;
  rows: AuditWindowRow[];
  field: FilterField;
  onPick: (filter: Filter) => void;
}): ReactNode {
  const top = topOf(rows, field, BARS);
  return (
    <div>
      <p className="eyebrow">{label}</p>
      <div className="a-topn">
        {top.rows.length === 0 ? <p className="note">None.</p> : null}
        {top.rows.map((bar) => (
          <button key={bar.value} type="button" title={bar.value} onClick={() => onPick({ field, value: bar.value })}>
            <span className="a-bar" style={{ width: `${(bar.count / top.max) * 100}%` }} />
            <span className="a-nm">{bar.value}</span>
            <span className="a-n">{fmtCount(bar.count)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Who was refused reaching what. The bar filters by the PRINCIPAL alone, deliberately: the
 * right half of the pair may be an event name rather than a tool, and a `tool` filter naming
 * one would match nothing.
 */
function Refusals({ rows, onPick }: { rows: AuditWindowRow[]; onPick: (filter: Filter) => void }): ReactNode {
  const pairs = refusalPairsOf(rows, BARS);
  if (pairs.length === 0) return <p className="note">None.</p>;
  return (
    <div className="a-topn">
      {pairs.map((pair) => (
        <button
          key={`${pair.principal}|${pair.target}`}
          type="button"
          title={`${pair.principal} → ${pair.target}`}
          onClick={() => onPick({ field: "principal", value: pair.principal })}
        >
          <span className="a-bar" style={{ width: `${(pair.count / pair.max) * 100}%` }} />
          <span className="a-nm">
            {pair.principal} → {pair.target}
          </span>
          <span className="a-n">{fmtCount(pair.count)}</span>
        </button>
      ))}
    </div>
  );
}
