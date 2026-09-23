import type { ReactNode } from "react";
import type { AuditWindowRow } from "@/lib/types";
import {
  OUTCOME_CLASSES,
  fmtClock,
  fmtCount,
  fmtDayTime,
  fmtDuration,
  outcomeClass,
  causeWords,
  outcomeLabel,
  sameUtcDay,
  titleOf,
  waterfallOf,
} from "./derive";
import type { Session } from "./derive";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FILL, HOVER_RING, MORE, NOTE, OutcomeBadge, Swatch, Titled } from "./parts";

/** One page of sessions, and the step **Load more** takes. Fewer than Events' page because a
 *  session header is three lines' worth of metadata, not one row. */
export const SESSIONS_PAGE = 40;

/**
 * Sessions — the same rows grouped by the consumer that made them, which is the reading that
 * answers "what was Claude Code doing at four o'clock".
 *
 * Opening one draws the salience waterfall: the routine folds and the exceptions keep their
 * lines. A session of two hundred ok calls and one refusal is otherwise two hundred and one
 * rows in which the refusal is invisible.
 */
export function SessionsView({
  sessions,
  shown,
  openId,
  onToggleSession,
  onOpenRecord,
  onShowMore,
}: {
  sessions: Session[];
  shown: number;
  /** `?open=`, the session whose waterfall is drawn. */
  openId: string | null;
  onToggleSession: (id: string | null) => void;
  onOpenRecord: (row: AuditWindowRow, opener: HTMLElement) => void;
  onShowMore: () => void;
}): ReactNode {
  const drawn = sessions.slice(0, shown);
  return (
    <Card size="flush">
      <div className="flex flex-wrap items-center gap-2.5 border-b px-3.5 py-3">
        <b className="font-semibold">{fmtCount(sessions.length)} sessions</b>
        <span className={NOTE}>newest first · runs of ok fold away inside</span>
      </div>
      {drawn.map((session) => {
        const open = openId === session.id;
        return (
          <div className="border-b border-row-border" key={session.id}>
            <button
              type="button"
              className={open ? `${SESSION_HEAD} bg-muted` : `${SESSION_HEAD} bg-transparent hover:bg-sunken`}
              aria-expanded={open}
              onClick={() => onToggleSession(open ? null : session.id)}
            >
              <Swatch cls={session.worst} />
              <span className="text-sm font-semibold">{session.principal}</span>
              <span className={`${META} font-mono`}>
                {session.client?.name ?? "no client"} {session.client?.version ?? ""} ·{" "}
                {session.noSession ? "no session" : session.id.slice(0, 8)}
              </span>
              <span className={META}>
                {/* The end reads as a clock inside the same day and as a full stamp when the
                    session crossed midnight — a bare "02:10" after "Aug 23 23:40" would read as
                    running backwards. */}
                {fmtDayTime(session.first)} →{" "}
                {sameUtcDay(session.first, session.last) ? fmtClock(session.last) : fmtDayTime(session.last)} ·{" "}
                {session.events.length} events ·{" "}
                {[...new Set(session.events.map((row) => row.app).filter(Boolean))].slice(0, 3).join(", ")}
              </span>
              <span className="ml-auto flex flex-wrap justify-end gap-[5px] max-md:ml-0 max-md:flex-[1_1_100%] max-md:justify-start">
                {OUTCOME_CLASSES.filter((cls) => session.counts[cls] !== undefined).map((cls) => (
                  <OutcomeBadge key={cls} cls={cls} count={session.counts[cls]} />
                ))}
              </span>
            </button>
            {open ? <Waterfall session={session} onOpenRecord={onOpenRecord} /> : null}
          </div>
        );
      })}
      <div className={MORE}>
        {sessions.length > drawn.length ? (
          <>
            <Button variant="outline" size="sm" className="max-md:flex-1" onClick={onShowMore}>
              Load more
            </Button>
            <span className={NOTE}>
              {fmtCount(drawn.length)} of {fmtCount(sessions.length)} sessions — {SESSIONS_PAGE} at a time.
            </span>
          </>
        ) : (
          <span className={NOTE}>All {fmtCount(sessions.length)} sessions in this window.</span>
        )}
      </div>
    </Card>
  );
}

/** A session's head: the toggle that opens its waterfall. On the phone it wraps, the meta and
 *  the counts each taking a line. */
const SESSION_HEAD =
  "flex min-h-control-sm w-full cursor-pointer items-center gap-2.5 border-0 px-3.5 py-2 text-left [font:inherit] text-inherit max-md:min-h-control-touch max-md:flex-wrap max-md:py-2.5";

const META = "text-xs text-muted-foreground max-md:flex-[1_1_100%]";

/**
 * One session's waterfall. The bars are positioned as a share of the session's own span, so a
 * three-second session and a three-hour one read the same way.
 *
 * A row with no duration is drawn a minute wide (`SPANLESS_MS`): an approval or a config change
 * is an instant, and a zero-width bar would be invisible on the one line somebody opened the
 * session to find.
 */
function Waterfall({
  session,
  onOpenRecord,
}: {
  session: Session;
  onOpenRecord: (row: AuditWindowRow, opener: HTMLElement) => void;
}): ReactNode {
  // At least a minute, so a session of three calls in one second is not divided by zero.
  const span = Math.max(60_000, session.last - session.first);
  return (
    <div className="flex flex-col gap-0.5 bg-sunken px-3.5 pt-2 pb-3.5">
      {waterfallOf(session).map((line, index) => {
        if (line.kind === "fold") {
          const left = ((line.from - session.first) / span) * 100;
          const width = Math.max(2, ((line.to - line.from) / span) * 100);
          return (
            <div className={LINE} key={index}>
              <span className={TIME} />
              <span className={`${LABEL} text-muted-foreground italic`}>
                {line.n} ok calls — {line.apps.join(", ")}
              </span>
              <span className={TRACK}>
                {/* A folded run has no single duration to draw, so its band is a hatch across
                    the span it covered rather than a solid bar that would claim one. */}
                <span
                  className={`${BAR} bg-[repeating-linear-gradient(90deg,var(--color-border)_0_5px,transparent_5px_9px)]`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              </span>
              <span className={SAYS} />
            </div>
          );
        }
        const row = line.row;
        const cls = outcomeClass(row.outcome);
        const left = ((row.ts - session.first) / span) * 100;
        const width = Math.max(1.5, ((row.durationMs ?? SPANLESS_MS) / span) * 100);
        const cause = causeWords(row);
        return (
          <button
            type="button"
            className={`${LINE} cursor-pointer hover:bg-background ${HOVER_RING}`}
            key={row.id}
            onClick={(event) => onOpenRecord(row, event.currentTarget)}
          >
            <span className={TIME}>{fmtClock(row.ts)}</span>
            {/* An exception keeps its line, and says so in weight. */}
            <span className={cls === "ok" ? LABEL : `${LABEL} font-semibold`}>
              <Titled of={titleOf(row)} />
            </span>
            <span className={TRACK}>
              <span
                className={`${BAR} ${FILL[cls]}`}
                style={{ left: `${Math.min(97, left)}%`, width: `${Math.min(width, 100 - left)}%` }}
              />
            </span>
            {/* What the line SAYS it was: a duration when it ran, otherwise the outcome in
                words with its recorded cause after it — `not permitted · no grant reaches it`,
                `app unavailable · timeout`. Never `denied · -32001`: a bare code here is a
                number nobody can read, and the record is the one place that prints one. */}
            <span className={SAYS}>
              {cls === "ok"
                ? fmtDuration(row.durationMs)
                : cause === null
                  ? outcomeLabel(row.outcome)
                  : `${outcomeLabel(row.outcome)} · ${cause}`}
            </span>
          </button>
        );
      })}
      <p className={NOTE}>Any line opens its record. Folded runs are ok calls only.</p>
    </div>
  );
}

/** One waterfall line, a fold or a row. On the phone each label sits above its own bar, so a
 *  230px mono name does not squeeze the track to nothing. */
const LINE =
  "flex min-h-control-xs w-full items-center gap-2.5 rounded-[5px] border-0 bg-transparent px-1 py-0 text-left font-[family-name:inherit] text-xs text-inherit max-md:flex-wrap max-md:gap-x-2.5 max-md:gap-y-0.5 max-md:py-1.5";

const TIME = "w-[52px] flex-none font-mono text-muted-foreground max-md:order-1";

const LABEL = "w-[230px] flex-none truncate font-mono max-md:order-2 max-md:w-auto max-md:flex-[1_1_auto]";

/** Where the bar is drawn: the session's span, 40px at least beside the label. */
const TRACK = "relative h-3 min-w-10 flex-1 max-md:order-4 max-md:min-w-0 max-md:flex-[1_1_100%]";

const BAR = "absolute top-px h-2.5 min-w-[3px] rounded-[3px]";

/** Wide enough for the longest label-plus-cause on one line ("not permitted · op withheld from
 *  this credential"); the track keeps its own 40px floor beside it. */
const SAYS = "w-60 flex-none text-right text-2xs text-muted-foreground max-md:order-3 max-md:ml-auto max-md:w-auto";

/** How wide a row with no measured duration is drawn. One minute — enough to see, small enough
 *  that it does not claim a length the ledger never recorded. */
const SPANLESS_MS = 60_000;
