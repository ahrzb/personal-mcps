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
  previewIsEvidence,
  previewOf,
  runLine,
  titleOfMerged,
  whenOf,
} from "./derive";
import type { MergedRow } from "./derive";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { HOVER_RING, MORE, NOTE, OutcomeBadge, Titled } from "./parts";

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
    <Card size="flush">
      <Table size="dense">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[152px]">When</TableHead>
            <TableHead className="w-[128px]">Who</TableHead>
            <TableHead>What happened</TableHead>
            <TableHead className="w-[128px]">Outcome</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
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
        </TableBody>
      </Table>
      <div className={MORE}>
        {merged.length > rows.length ? (
          <Button variant="outline" size="sm" className="max-md:flex-1" onClick={onShowMore}>
            Load more
          </Button>
        ) : null}
        <span className={NOTE}>
          {fmtCount(rows.length)} rows from {fmtCount(events)} events — related events merged, repeats collapsed.
          {merged.length > rows.length
            ? ` ${fmtCount(merged.length)} rows in all, ${EVENTS_PAGE} at a time.`
            : ""}
        </span>
      </div>
    </Card>
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
    <TableRow data-state={selected ? "selected" : undefined} className={ROW}>
      {/* The two fixed columns never wrap: an un-chained row is then one line, and the table
          reads as the dense 32px tier rather than as a mix of 32 and 48. On the phone the row
          is a two-line card: time · principal · outcome, then the title and what follows it. */}
      <TableCell className="font-mono whitespace-nowrap text-muted-foreground max-md:order-1">{fmtStamp(whenOf(row))}</TableCell>
      <TableCell className="font-mono font-semibold whitespace-nowrap max-md:order-2">{head.principal}</TableCell>
      {/* An identifier has no spaces to break at, and a 300-character tool name in an
          auto-layout table sets the table's own width. `anywhere` rather than `break-word`,
          because only `anywhere` also shrinks the cell's MIN-CONTENT width, which is what the
          table measures. `min-w-0` lets the card's cell, and the clipped preview in it, be
          narrower than its content. */}
      <TableCell className="wrap-anywhere max-md:order-4 max-md:min-w-0 max-md:flex-[0_0_100%]">
        <div className="flex flex-wrap items-baseline gap-2">
            {/* The title is a REAL BUTTON stretched over the whole row by its `::after` — the
                agents and apps lists' own row grammar. A `<tr onClick>` would open the record
                under the pointer and be unreachable from the keyboard, and, being unfocusable,
                would have nowhere to give focus back to when the drawer closes.

                A chain row is titled by the call it is the story of; everything else by the
                general rule. `titleOfMerged` is what knows the difference. */}
            <button
              type="button"
              className={ROW_LINK}
              onClick={(event) => onOpenRecord(head, event.currentTarget)}
            >
              <Titled of={titleOfMerged(row)} />
            </button>
            {/* The badge sits ABOVE the stretched title (`RUN_TOGGLE` is raised), so it takes
                its own click rather than the row's — the same trick the apps list uses to keep a
                row control clickable inside a row-wide link. */}
          {isRun ? (
            <Badge
              render={<button type="button" />}
              variant="outline"
              className={RUN_TOGGLE}
              aria-expanded={open}
              // Only while there is something to point AT: an IDREF to an element that does not
              // exist is invalid, and a collapsed run has no member list.
              {...(open ? { "aria-controls": membersId } : {})}
              onClick={onToggleRun}
            >
              ×{fmtCount(row.runs)} runs
              <Chevron open={open} />
            </Badge>
          ) : null}
          {row.kind === "chain" ? <Badge>{row.group.length} events</Badge> : null}
        </div>
        {/* What the run covers, under the title: the slot the chain sentence uses, so a row says
            what it stands for in one place whichever kind it is. */}
        {isRun ? <div className={`${NOTE} mt-0.5`}>{runLine(row.group)}</div> : null}
        {words.length === 0 ? null : (
          <div className="mt-0.5 flex flex-wrap items-baseline gap-1.5 text-2xs text-muted-foreground">
            {words.map((word, index) => (
              <span key={index}>
                {index > 0 ? <span className="text-ring">→ </span> : null}
                <b className="font-medium text-foreground">{word}</b>
              </span>
            ))}
          </div>
        )}
        {preview === null ? null : (
          // The preview STAYS on the phone, as one clipped line, when it is the row's own
          // EVIDENCE: the run signature splits on `argsHead`, so without it five
          // `news/search_news` cards read as the same card five times. A spill of whatever else
          // `detail` held is not the line that tells one card from the next, so that one goes.
          <div className={previewIsEvidence(head) ? PREVIEW : `${PREVIEW} max-md:hidden`}>
            {preview}
          </div>
        )}
        {/* The members hang INSIDE this cell, under the run line and behind a hairline — the
            board's shape. A band across all four columns would put them under WHEN, which is
            not the column any of them belongs to. */}
        {open ? (
          <div className="mt-2 flex flex-col gap-px border-t border-row-border pt-2" id={membersId}>
            {row.group.slice(0, shownMembers).map((member) => (
              <button
                type="button"
                key={member.id}
                className={expandedId === String(member.id) ? `${MEMBER} bg-muted` : `${MEMBER} bg-transparent`}
                onClick={(event) => onOpenRecord(member, event.currentTarget)}
              >
                {/* Wide enough for a whole stamp on one line: a member is identified by WHEN it
                    happened, the rest of its row being identical by construction. */}
                <span className="w-[132px] flex-none font-mono whitespace-nowrap text-muted-foreground">{fmtStamp(member.ts)}</span>
                <span className="w-[72px] flex-none text-muted-foreground tabular-nums max-md:ml-auto">
                  {fmtDuration(member.durationMs)}
                </span>
                <OutcomeBadge cls={outcomeClass(member.outcome)} />
              </button>
            ))}
            <div className="flex flex-wrap items-center gap-2 pt-1.5">
              {row.group.length > shownMembers ? (
                <Button variant="outline" size="sm" onClick={onMoreMembers}>
                  Show more
                </Button>
              ) : null}
              <Button variant="outline" size="sm" onClick={onToggleRun}>
                Hide
              </Button>
              <span className={NOTE}>
                {fmtCount(Math.min(shownMembers, row.group.length))} of {fmtCount(row.group.length)} · each line opens
                its own record.
              </span>
            </div>
          </div>
        ) : null}
      </TableCell>
      <TableCell className="max-md:order-3 max-md:ml-auto">
        <OutcomeBadge cls={row.state} />
      </TableCell>
    </TableRow>
  );
}

/** A row is the control, with no handler of its own: its title button's `::after` covers it,
 *  measured against the row's `relative`. */
const ROW =
  "relative cursor-pointer hover:bg-sunken max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-2 max-md:gap-y-1.5";

/**
 * The row's title: a real button stretched over the whole row by its `::after`. Its focus ring
 * is the ROW's, drawn on that `::after`, not the title's: the button is the row, so a ring
 * around four words in the middle of it would point at the wrong thing.
 */
const ROW_LINK =
  "cursor-pointer border-0 bg-transparent p-0 text-left font-mono text-xs leading-[inherit] font-semibold text-inherit after:absolute after:inset-0 focus-visible:shadow-none focus-visible:outline-none focus-visible:after:rounded-sm focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring";

/**
 * The ×N badge is the run's DISCLOSURE, so a real button, raised above the title's row-wide
 * `::after` or the row would swallow its click and open a record instead of unfolding. A badge
 * is 20px on the phone too, so the 44px it owes touch is an invisible `::before` around it
 * rather than a slab that would be the only 44px thing on a line of 20px ones.
 */
const RUN_TOGGLE =
  "relative z-1 cursor-pointer py-0 font-[family-name:inherit] leading-[inherit] before:absolute before:-inset-x-1.5 before:-inset-y-3 hover:bg-muted aria-expanded:border-primary aria-expanded:bg-primary aria-expanded:text-primary-foreground";

/** The arguments preview: one clipped mono line. */
const PREVIEW = `${NOTE} mt-px truncate font-mono`;

/** A member of an unfolded run: a row-button of its own, whose record — and so whose bodies —
 *  is one click away. On the phone it takes the touch height rather than being hidden. */
const MEMBER = `flex min-h-control-xs cursor-pointer items-center gap-2.5 rounded-[5px] border-0 px-1.5 py-0 text-left font-[family-name:inherit] text-xs leading-[inherit] text-inherit hover:bg-background ${HOVER_RING} max-md:min-h-control-touch max-md:text-sm`;

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
