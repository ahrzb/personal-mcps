import { useState } from "react";
import type { ReactNode } from "react";
import { usePreviewTransient } from "@/preview/transient";
import type { AuditWindowRow } from "@/lib/types";
import {
  chainWords,
  fmtCount,
  fmtDuration,
  fmtStamp,
  outcomeClass,
  previewOf,
  runLine,
  titleOfMerged,
  whenOf,
} from "./derive";
import type { MergedRow } from "./derive";
import { OutcomeBadge, Titled } from "./parts";

/** One page of rows, and the step **Load more** takes. 120 because that is roughly four
 *  screens of a dense 32px row — far enough to scroll for a while, short enough that the DOM
 *  stays a few hundred nodes at the 5,000-row design load. */
export const EVENTS_PAGE = 120;

/** How many members of one run are listed before **Show more**. A run of 300 refusals is a real
 *  shape (a cron agent, every half hour, for a week), and 50 is enough to see the cadence. */
const RUN_PAGE = 50;

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
  /* Which ×N runs are open, and how many members each shows. COMPONENT state, not URL state:
     this is reading position — where somebody got to inside one row — and a URL that grew a key
     every time a row was unfolded would be a URL nobody could share. */
  const seeded = usePreviewTransient().openRun;
  const [openRuns, setOpenRuns] = useState<Record<number, number>>(() =>
    seeded === undefined ? {} : { [seeded]: RUN_PAGE },
  );
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
              expandedId={expandedId}
              shownMembers={openRuns[row.head.id] ?? 0}
              onToggleRun={() =>
                setOpenRuns((held) => ({ ...held, [row.head.id]: held[row.head.id] === undefined || held[row.head.id] === 0 ? RUN_PAGE : 0 }))
              }
              onMoreMembers={() =>
                setOpenRuns((held) => ({ ...held, [row.head.id]: (held[row.head.id] ?? 0) + RUN_PAGE }))
              }
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

/**
 * One merged row. A ×N run is a DISCLOSURE rather than a summary: the badge opens it and every
 * member is listed, each opening its own record.
 *
 * It shipped as a summary and that was the gap the owner found — "the x5 runs look weird, how
 * can I look at all of them? or look at the bodies?": the row opened only its newest member,
 * and the other N−1 rows could not be reached from the page at all. Collapsing rows is only
 * honest if what was collapsed can be got back.
 */
function EventRow({
  row,
  selected,
  expandedId,
  shownMembers,
  onToggleRun,
  onMoreMembers,
  onOpenRecord,
}: {
  row: MergedRow;
  selected: boolean;
  /** `?expand=`, so a member row can wear the selected state too. */
  expandedId: string | null;
  /** How many members this run lists; 0 is collapsed. */
  shownMembers: number;
  onToggleRun: () => void;
  onMoreMembers: () => void;
  onOpenRecord: (row: AuditWindowRow, opener: HTMLElement) => void;
}): ReactNode {
  const head = row.head;
  const words = row.kind === "chain" ? chainWords(row.group) : [];
  const preview = previewOf(head);
  const isRun = row.runs > 1;
  const open = isRun && shownMembers > 0;
  // Named off the head's id, which is unique in the list, so `aria-controls` points somewhere.
  const membersId = `a-run-${head.id}`;

  return (
    <tr className={selected ? "a-ev a-ev--sel" : "a-ev"}>
      <td className="a-when a-dim a-tmono">{fmtStamp(whenOf(row))}</td>
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
            {/* The badge sits ABOVE the stretched title (`.a-runtoggle` is raised), so it takes
                its own click rather than the row's — the same trick the apps list uses to keep a
                row control clickable inside a row-wide link. */}
          {isRun ? (
            <button
              type="button"
              className="badge a-runtoggle"
              aria-expanded={open}
              // Only while there is something to point AT: an IDREF to an element that does not
              // exist is invalid, and a collapsed run has no member list.
              {...(open ? { "aria-controls": membersId } : {})}
              onClick={onToggleRun}
            >
              ×{fmtCount(row.runs)} runs
              <Chevron open={open} />
            </button>
          ) : null}
          {row.kind === "chain" ? <span className="badge">{row.group.length} events</span> : null}
        </div>
        {isRun ? <div className="note a-runline">{runLine(row.group)}</div> : null}
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
        {/* The members hang INSIDE this cell, under the run line and behind a hairline — the
            board's shape. A band across all four columns would put them under WHEN, which is
            not the column any of them belongs to. */}
        {open ? (
          <div className="a-members" id={membersId}>
            {row.group.slice(0, shownMembers).map((member) => (
              <button
                type="button"
                key={member.id}
                className={expandedId === String(member.id) ? "a-member a-member--sel" : "a-member"}
                onClick={(event) => onOpenRecord(member, event.currentTarget)}
              >
                <span className="a-membertime">{fmtStamp(member.ts)}</span>
                <span className="a-memberdur">{fmtDuration(member.durationMs)}</span>
                <OutcomeBadge cls={outcomeClass(member.outcome)} />
              </button>
            ))}
            <div className="a-memberfoot">
              {row.group.length > shownMembers ? (
                <button type="button" className="btn btn--outline btn--sm" onClick={onMoreMembers}>
                  Show more
                </button>
              ) : null}
              <button type="button" className="btn btn--outline btn--sm" onClick={onToggleRun}>
                Hide
              </button>
              <span className="note">
                {fmtCount(Math.min(shownMembers, row.group.length))} of {fmtCount(row.group.length)} · each line opens
                its own record.
              </span>
            </div>
          </div>
        ) : null}
      </td>
      <td className="a-out">
        <OutcomeBadge cls={row.state} />
      </td>
    </tr>
  );
}

/** The disclosure's own arrow. Decoration beside a badge that already counts, and beside an
 *  `aria-expanded` that already says which way it points. */
function Chevron({ open }: { open: boolean }): ReactNode {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ transform: open ? "rotate(180deg)" : undefined }}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
