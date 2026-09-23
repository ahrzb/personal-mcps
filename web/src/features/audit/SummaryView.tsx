import type { ReactNode } from "react";
import type { AuditWindowRow } from "@/lib/types";
import { changesOf, fmtCount, fmtDayTime, fmtDuration, refusalPairsOf, summaryOf, topOf } from "./derive";
import type { FilterField, Filter, Insight } from "./derive";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { Eyebrow, Note } from "@/chrome/Text";
import { FROW, FROW_FIGURE, FROW_VALUE, HOVER_RING, SECONDARY } from "./parts";

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
    <Card size="flush" className={SUMMARY}>
      <div className={GRID3}>
        <div>
          <div className={STAT}>{fmtCount(stats.events)}</div>
          <div className={STAT_LABEL}>events · {fmtCount(stats.calls)} tool calls</div>
        </div>
        <div>
          <div className={stats.refused > 0 ? `${STAT} text-danger-fg` : STAT}>{fmtCount(stats.refused)}</div>
          <div className={STAT_LABEL}>refused or waiting on you</div>
        </div>
        <div>
          <div className={STAT}>{fmtDuration(stats.median ?? undefined)}</div>
          <div className={STAT_LABEL}>median call · p95 {fmtDuration(stats.p95 ?? undefined)}</div>
        </div>
      </div>

      {insights.length === 0 ? null : (
        <div className="rounded-lg border border-warning-border bg-warning-bg px-3.5 py-3">
          <Eyebrow render={<p />} className="mb-1 text-warning">Worth a look</Eyebrow>
          <ul className="m-0 list-disc pl-[18px]">
            {insights.map((insight, index) => (
              <li key={index} className="text-sm leading-[1.75] max-md:leading-[1.9]">
                {insight.parts.map((part, at) =>
                  part.style === "strong" ? (
                    <b key={at}>{part.text}</b>
                  ) : part.style === "mono" ? (
                    <span className="font-mono" key={at}>
                      {part.text}
                    </span>
                  ) : (
                    <span key={at}>{part.text}</span>
                  ),
                )}{" "}
                <button
                  type="button"
                  className="cursor-pointer border-0 bg-transparent p-0 [font:inherit] text-inherit underline underline-offset-2"
                  onClick={() => onDrillTo(insight.filters)}
                >
                  show me
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={GRID3}>
        <Bars label="Agents" rows={rows} field="principal" onPick={onToggleFilter} />
        <Bars label="Apps" rows={rows} field="app" onPick={onToggleFilter} />
        <Bars label="Tools" rows={rows} field="tool" onPick={onToggleFilter} />
      </div>

      <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-3 md:max-lg:grid-cols-2 max-md:grid-cols-1">
        <div>
          <Eyebrow render={<p />}>Refusals</Eyebrow>
          <Refusals rows={rows} onPick={onToggleFilter} />
        </div>
        <div>
          <Eyebrow render={<p />}>Changes you made</Eyebrow>
          {changes.length === 0 ? (
            <Note>None this window.</Note>
          ) : (
            <div className="flex flex-col gap-0.5">
              {changes.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className={cn(FROW, "h-auto py-[3px]")}
                  onClick={(event) => onOpenRecord(row, event.currentTarget)}
                >
                  <span className={FROW_VALUE}>{row.event}</span>
                  <span className={FROW_FIGURE}>{fmtDayTime(row.ts)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2.5 border-t pt-3">
        <Note render={<span />}>The log itself is a click away — this page is the answer, not the record.</Note>
        <Button size="sm" className="ml-auto" onClick={onShowEvents}>
          All {fmtCount(stats.events)} events →
        </Button>
      </div>
    </Card>
  );
}

/** The summary's card: a column of panels 14px apart, 16px in. The loading page draws the same
 *  card, so it lands in place. */
export const SUMMARY = "flex flex-col gap-3.5 p-4";

/** Three panels side by side; two at the regular tier, one on the phone. */
export const GRID3 = "grid grid-cols-3 gap-3 md:max-lg:grid-cols-2 max-md:grid-cols-1";

/** A tile's number, and what it counts. */
const STAT = "text-2xl leading-[1.2] font-semibold tracking-[-0.01em]";
const STAT_LABEL = "text-xs text-muted-foreground";

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
      <Eyebrow render={<p />}>{label}</Eyebrow>
      <div className={TOPN}>
        {top.rows.length === 0 ? <Note>None.</Note> : null}
        {top.rows.map((bar) => (
          <button
            key={bar.value}
            type="button"
            className={TOPN_ROW}
            title={bar.value}
            onClick={() => onPick({ field, value: bar.value })}
          >
            <span className={TOPN_BAR} style={{ width: `${(bar.count / top.max) * 100}%` }} />
            <span className={FROW_VALUE}>{bar.value}</span>
            <span className={TOPN_COUNT}>{fmtCount(bar.count)}</span>
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
  if (pairs.length === 0) return <Note>None.</Note>;
  return (
    <div className={TOPN}>
      {pairs.map((pair) => (
        <button
          key={`${pair.principal}|${pair.target}|${pair.cause ?? ""}`}
          type="button"
          className={TOPN_ROW}
          title={`${pair.principal} → ${pair.target}${pair.cause === null ? "" : ` — ${pair.cause}`}`}
          onClick={() => onPick({ field: "principal", value: pair.principal })}
        >
          <span className={TOPN_BAR} style={{ width: `${(pair.count / pair.max) * 100}%` }} />
          <span className={FROW_VALUE}>
            {pair.principal} → {pair.target}
            {/* Why, in the same short words the list rows use — dim, because the pair is what
                the line is about and the cause is what it adds. */}
            {pair.cause === null ? null : <span className={`${SECONDARY} relative`}> — {pair.cause}</span>}
          </span>
          <span className={TOPN_COUNT}>{fmtCount(pair.count)}</span>
        </button>
      ))}
    </div>
  );
}

/** A column of top-N bars. */
const TOPN = "flex flex-col gap-0.5";

/** One bar: a 24px row (the touch height on the phone) with its bar behind the labels. */
const TOPN_ROW = `relative flex h-control-xs w-full cursor-pointer items-center gap-2 rounded-[5px] border-0 bg-transparent px-[5px] py-0 text-left font-[family-name:inherit] text-xs text-inherit max-md:h-control-touch ${HOVER_RING}`;

/** One step quieter than the rail's bar: three of these panels sit side by side, and the rail's
 *  fill at that repetition reads as a shaded block rather than as three charts. */
const TOPN_BAR = "absolute inset-y-px left-0 rounded-[4px] bg-a-bar-soft";

const TOPN_COUNT = "relative ml-auto pl-1.5 text-muted-foreground tabular-nums";
