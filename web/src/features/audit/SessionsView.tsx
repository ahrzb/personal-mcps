import type { ReactNode } from "react";
import type { AuditWindowRow } from "@/lib/types";
import {
  OUTCOME_CLASSES,
  fmtClock,
  fmtCount,
  fmtDayTime,
  fmtDuration,
  outcomeClass,
  sameUtcDay,
  titleOf,
  waterfallOf,
} from "./derive";
import type { Session } from "./derive";
import { OutcomeBadge, Swatch, Titled } from "./parts";

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
    <div className="card">
      <div className="a-listhead">
        <b>{fmtCount(sessions.length)} sessions</b>
        <span className="note">newest first · runs of ok fold away inside</span>
      </div>
      {drawn.map((session) => {
        const open = openId === session.id;
        return (
          <div className={open ? "a-sess a-sess--open" : "a-sess"} key={session.id}>
            <button
              type="button"
              className="a-shead"
              aria-expanded={open}
              onClick={() => onToggleSession(open ? null : session.id)}
            >
              <Swatch cls={session.worst} />
              <span className="a-who">{session.principal}</span>
              <span className="a-meta mono">
                {session.client?.name ?? "no client"} {session.client?.version ?? ""} ·{" "}
                {session.noSession ? "no session" : session.id.slice(0, 8)}
              </span>
              <span className="a-meta">
                {/* The end reads as a clock inside the same day and as a full stamp when the
                    session crossed midnight — a bare "02:10" after "Aug 23 23:40" would read as
                    running backwards. */}
                {fmtDayTime(session.first)} →{" "}
                {sameUtcDay(session.first, session.last) ? fmtClock(session.last) : fmtDayTime(session.last)} ·{" "}
                {session.events.length} events ·{" "}
                {[...new Set(session.events.map((row) => row.app).filter(Boolean))].slice(0, 3).join(", ")}
              </span>
              <span className="a-counts">
                {OUTCOME_CLASSES.filter((cls) => session.counts[cls] !== undefined).map((cls) => (
                  <OutcomeBadge key={cls} cls={cls} count={session.counts[cls]} />
                ))}
              </span>
            </button>
            {open ? <Waterfall session={session} onOpenRecord={onOpenRecord} /> : null}
          </div>
        );
      })}
      <div className="a-more">
        {sessions.length > drawn.length ? (
          <>
            <button type="button" className="btn btn--outline btn--sm" onClick={onShowMore}>
              Load more
            </button>
            <span className="note">
              {fmtCount(drawn.length)} of {fmtCount(sessions.length)} sessions — {SESSIONS_PAGE} at a time.
            </span>
          </>
        ) : (
          <span className="note">All {fmtCount(sessions.length)} sessions in this window.</span>
        )}
      </div>
    </div>
  );
}

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
    <div className="a-wf">
      {waterfallOf(session).map((line, index) => {
        if (line.kind === "fold") {
          const left = ((line.from - session.first) / span) * 100;
          const width = Math.max(2, ((line.to - line.from) / span) * 100);
          return (
            <div className="a-wfr" key={index}>
              <span className="a-wft" />
              <span className="a-wflbl a-wffold">
                {line.n} ok calls — {line.apps.join(", ")}
              </span>
              <span className="a-wftrack">
                <span className="a-wfbar a-wfbar--fold" style={{ left: `${left}%`, width: `${width}%` }} />
              </span>
              <span className="a-wfrt" />
            </div>
          );
        }
        const row = line.row;
        const cls = outcomeClass(row.outcome);
        const left = ((row.ts - session.first) / span) * 100;
        const width = Math.max(1.5, ((row.durationMs ?? SPANLESS_MS) / span) * 100);
        const failure = row.detail?.failureClass;
        return (
          <button
            type="button"
            className={cls === "ok" ? "a-wfr" : "a-wfr a-wfr--keep"}
            key={row.id}
            onClick={(event) => onOpenRecord(row, event.currentTarget)}
          >
            <span className="a-wft">{fmtClock(row.ts)}</span>
            <span className="a-wflbl">
              <Titled of={titleOf(row)} />
            </span>
            <span className="a-wftrack">
              <span
                className={`a-wfbar a-wfbar--${cls}`}
                style={{ left: `${Math.min(97, left)}%`, width: `${Math.min(width, 100 - left)}%` }}
              />
            </span>
            <span className="a-wfrt">
              {cls === "ok"
                ? fmtDuration(row.durationMs)
                : `${cls} · ${typeof failure === "string" ? failure : row.outcome}`}
            </span>
          </button>
        );
      })}
      <p className="note">Any line opens its record. Folded runs are ok calls only.</p>
    </div>
  );
}

/** How wide a row with no measured duration is drawn. One minute — enough to see, small enough
 *  that it does not claim a length the ledger never recorded. */
const SPANLESS_MS = 60_000;
