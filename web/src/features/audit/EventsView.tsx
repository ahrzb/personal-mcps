import type { ReactNode } from "react";
import type { AuditWindowRow } from "@/lib/types";
import { chainWords, fmtCount, fmtStamp, previewOf, titleOfMerged } from "./derive";
import type { MergedRow } from "./derive";
import { OutcomeBadge, Titled } from "./parts";

/** One page of rows, and the step **Load more** takes. 120 because that is roughly four
 *  screens of a dense 32px row — far enough to scroll for a while, short enough that the DOM
 *  stays a few hundred nodes at the 5,000-row design load. */
export const EVENTS_PAGE = 120;

/**
 * Events — the ledger itself, with the noise merged out.
 *
 * Two merges, and both exist because the raw ledger reads as an alarm going off: a call, the
 * approval it provoked and the dispatch that followed are ONE row with the story on its second
 * line, and a cron agent refused every half hour for a week is one row wearing ×336.
 *
 * Every row opens its record. The `opener` handed up with the click is what focus returns to
 * when the drawer closes — a reader who opened row 40 with the keyboard must not land back at
 * the top of the table.
 */
export function EventsView({
  merged,
  /** How many of the merged rows are drawn. */
  shown,
  /** Events in the selection, for the foot's "N rows from M events". */
  events,
  expandedId,
  onOpenRecord,
  onShowMore,
}: {
  merged: MergedRow[];
  shown: number;
  events: number;
  expandedId: string | null;
  onOpenRecord: (row: AuditWindowRow, opener: HTMLElement) => void;
  onShowMore: () => void;
}): ReactNode {
  const rows = merged.slice(0, shown);
  return (
    <div className="card">
      <table className="a-etab">
        <thead>
          <tr>
            <th className="a-th-when">When</th>
            <th className="a-th-who">Who</th>
            <th>What happened</th>
            <th className="a-th-out">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <EventRow
              key={row.head.id}
              row={row}
              selected={expandedId === String(row.head.id)}
              onOpenRecord={onOpenRecord}
            />
          ))}
        </tbody>
      </table>
      <div className="a-more">
        {merged.length > rows.length ? (
          <button type="button" className="btn btn--outline btn--sm" onClick={onShowMore}>
            Load more
          </button>
        ) : null}
        <span className="note">
          {fmtCount(rows.length)} rows from {fmtCount(events)} events — related events merged, repeats collapsed.
          {merged.length > rows.length
            ? ` ${fmtCount(merged.length)} rows in all, ${EVENTS_PAGE} at a time.`
            : ""}
        </span>
      </div>
    </div>
  );
}

function EventRow({
  row,
  selected,
  onOpenRecord,
}: {
  row: MergedRow;
  selected: boolean;
  onOpenRecord: (row: AuditWindowRow, opener: HTMLElement) => void;
}): ReactNode {
  const head = row.head;
  const words = row.kind === "chain" ? chainWords(row.group) : [];
  const preview = previewOf(head);

  return (
    <tr className={selected ? "a-ev a-ev--sel" : "a-ev"}>
      <td className="a-when a-dim a-tmono">{fmtStamp(head.ts)}</td>
      <td className="a-who a-tmono">{head.principal}</td>
      <td className="a-what">
        <div className="a-rowline">
          {/* The title is a REAL BUTTON stretched over the whole row by its `::after` — the
              agents and apps lists' own row grammar. A `<tr onClick>` would open the record
              under the pointer and be unreachable from the keyboard, and, being unfocusable,
              would have nowhere to give focus back to when the drawer closes.

              A chain row is titled by the call it is the story of; everything else by the
              general rule. `titleOfMerged` is what knows the difference. */}
          <button
            type="button"
            className="a-rowlink a-tmono a-title"
            onClick={(event) => onOpenRecord(head, event.currentTarget)}
          >
            <Titled of={titleOfMerged(row)} />
          </button>
          {row.runs > 1 ? <span className="badge">×{fmtCount(row.runs)} runs</span> : null}
          {row.kind === "chain" ? <span className="badge">{row.group.length} events</span> : null}
        </div>
        {words.length === 0 ? null : (
          <div className="a-chain">
            {words.map((word, index) => (
              <span key={index}>
                {index > 0 ? <span className="a-chain-arrow">→ </span> : null}
                <b>{word}</b>
              </span>
            ))}
          </div>
        )}
        {preview === null ? null : <div className="note a-tmono a-prev">{preview}</div>}
      </td>
      <td className="a-out">
        <OutcomeBadge cls={row.state} />
      </td>
    </tr>
  );
}
