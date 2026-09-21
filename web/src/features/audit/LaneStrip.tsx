import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  OUTCOME_CLASSES,
  ceilingNotice,
  fmtCount,
  fmtDay,
  fmtDayTime,
  outcomeCodes,
} from "./derive";
import type { AuditSelection, Lane } from "./derive";
import { SkelBar, Swatch, WarnIcon } from "./parts";

/**
 * The lane strip: what happened, to whom, when — one lane per principal, one cell per hour of
 * the retention window, each cell the WORST outcome in it.
 *
 * It is the page's time control as well as its overview. Four ways to set the window, because
 * the reader arrives with different questions and one mechanism serves none of them: drag for
 * "that spike", the presets for "the last hour", a day on the axis for "Tuesday", and **Whole
 * window** to undo all three. The brush is DRAWN on the strip rather than dimming it — the
 * strip's job is to show where the selection is relative to everything else, which a dimmed
 * strip could not do.
 *
 * No chart library: the cells are divs, as the prototype draws them.
 */
export function LaneStrip({
  lanes,
  selection,
  window,
  retentionDays,
  hours,
  /** How many rows the brush currently selects — the chip beside the presets. */
  selected,
  /** The read's echoed ceiling and total; the notice draws only when total exceeds it. */
  ceiling,
  total,
  /** Whether any cell is hatched, which is the only case the legend names "not loaded". */
  anyNotLoaded,
  onBrush,
}: {
  lanes: Lane[];
  selection: AuditSelection;
  window: { start: number; end: number };
  retentionDays: number;
  hours: number;
  selected: number;
  ceiling: number;
  total: number;
  anyNotLoaded: boolean;
  /** `null` clears the brush back to the whole window. */
  onBrush: (next: { since: number; until: number } | null) => void;
}): ReactNode {
  const lanesRef = useRef<HTMLDivElement | null>(null);
  const dragFrom = useRef<number | null>(null);
  const span = window.end - window.start;

  /** Where a client x lands in time. Reads `--gut` off the element rather than assuming 114:
   *  the phone sets it to 0, and the cells start where the lane names end. */
  const timeAt = (clientX: number): number => {
    const element = lanesRef.current;
    if (element === null) return window.start;
    const box = element.getBoundingClientRect();
    const gutter = Number.parseFloat(getComputedStyle(element).getPropertyValue("--gut")) || 0;
    const left = box.left + gutter;
    const usable = box.width - gutter;
    if (usable <= 0) return window.start;
    return window.start + Math.max(0, Math.min(1, (clientX - left) / usable)) * span;
  };

  /* Pointer events, and MOUSE or PEN only. A touch drag on a strip this short is the reader
     trying to scroll the page, so on touch the presets and the axis are the controls — which
     is also why the narrow stylesheet hides the brush. */
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === "touch") return;
    dragFrom.current = timeAt(event.clientX);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (from === null) return;
    const to = timeAt(event.clientX);
    // A drag shorter than an hour is a click, and a click sets nothing: the cells are an hour
    // wide, so a sub-hour window would select a slice of one cell.
    if (Math.abs(to - from) < HOUR) return;
    onBrush({ since: Math.min(from, to), until: Math.max(from, to) });
  };

  /* The strip is operable from the keyboard, which the drag alone is not: ←/→ move the window
     by an hour, Shift+←/→ resize it from its end. Clamped to the loaded window, so neither
     arm can walk the brush off the strip. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.key === "ArrowLeft" ? -HOUR : HOUR;
    if (event.shiftKey) {
      onBrush({
        since: selection.since,
        until: Math.max(selection.since + HOUR, Math.min(window.end, selection.until + step)),
      });
      return;
    }
    const width = selection.until - selection.since;
    const since = Math.max(window.start, Math.min(window.end - width, selection.since + step));
    onBrush({ since, until: since + width });
  };

  const dayAt = (index: number): number => window.start + index * DAY;
  const dayOn = (index: number): boolean =>
    selection.since <= dayAt(index) + DAY - 1 && selection.until >= dayAt(index);

  return (
    <div className="card a-strip">
      <div className="a-striphead">
        <span className="a-striprange">
          {fmtDayTime(selection.since)} → {fmtDayTime(selection.until)}
        </span>
        <div className="a-presets">
          <Preset on={selection.until - selection.since <= HOUR} label="1h" onPick={() => back(1)} />
          <Preset on={selection.until - selection.since === 24 * HOUR} label="24h" onPick={() => back(24)} />
          <Preset on={!selection.brushed} label={`${retentionDays}d`} onPick={() => onBrush(null)} />
        </div>
        <span className="note wide-only">
          an hour per cell, coloured by the worst outcome in it — drag to select
        </span>
        {selection.brushed ? (
          <button type="button" className="btn btn--outline btn--sm btn--mini a-stripend" onClick={() => onBrush(null)}>
            Whole window
          </button>
        ) : (
          <span className="a-stripend wide-only" />
        )}
        <span className="badge wide-only">{fmtCount(selected)} events selected</span>
      </div>

      {total > ceiling ? (
        <div className="a-ceiling" role="status">
          <WarnIcon />
          <span>{ceilingNotice(ceiling, total)}</span>
        </div>
      ) : null}

      <div
        className="a-lanes"
        ref={lanesRef}
        tabIndex={0}
        role="group"
        aria-label="Activity by principal and hour. Arrow keys move the selected window, Shift with an arrow resizes it."
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
      >
        {lanes.map((lane) => (
          <div className="a-lane" key={lane.name}>
            <span className="a-lane-nm" title={lane.title}>
              {lane.name}
            </span>
            <span className="a-cells" aria-hidden="true">
              {lane.cells.map((cell, hour) => (
                <span key={hour} className={cell === null ? "a-c" : `a-c a-c--${cell === "not-loaded" ? "nl" : cell}`} />
              ))}
            </span>
          </div>
        ))}
        {selection.brushed ? (
          <div
            className="a-brush"
            style={{
              // Against `--gut`, because the cells begin where the lane names end: a plain
              // percentage of the strip would place the brush an entire name column early.
              left: `calc(var(--gut) + (100% - var(--gut)) * ${(selection.since - window.start) / span})`,
              width: `calc((100% - var(--gut)) * ${(selection.until - selection.since) / span})`,
            }}
          />
        ) : null}
      </div>

      <div className="a-axis">
        {Array.from({ length: retentionDays }, (_, index) => (
          <button
            key={index}
            type="button"
            aria-pressed={dayOn(index)}
            onClick={() => onBrush({ since: dayAt(index), until: dayAt(index) + DAY })}
          >
            {fmtDay(dayAt(index))}
          </button>
        ))}
      </div>

      <div className="a-legend">
        <span className="a-legend-i a-legend-lbl wide-only">Worst outcome in the hour:</span>
        {OUTCOME_CLASSES.map((cls) => (
          <span className="a-legend-i" key={cls}>
            <Swatch cls={cls} />
            {cls}
            {/* The raw codes, where they differ from the class name — wide only, because at
                375px they double the legend's height to say what the record already says. */}
            {cls === "ok" || cls === "error" ? null : (
              <span className="a-legend-code wide-only">{outcomeCodes(cls).join(" · ")}</span>
            )}
          </span>
        ))}
        {anyNotLoaded ? (
          <span className="a-legend-i">
            <Swatch cls="nl" />
            not loaded
          </span>
        ) : null}
      </div>
    </div>
  );

  /** A preset window, ending where the LOADED window ends — not at the browser's clock, which
   *  would disagree with the read by however long the page has been open. */
  function back(count: number): void {
    onBrush({ since: window.end - count * HOUR, until: window.end });
  }
}

function Preset({ on, label, onPick }: { on: boolean; label: string; onPick: () => void }): ReactNode {
  return (
    <button
      type="button"
      className={`btn btn--sm btn--mini ${on ? "btn--primary" : "btn--outline"}`}
      aria-pressed={on}
      onClick={onPick}
    >
      {label}
    </button>
  );
}

/** The strip while the window is still loading: the lanes' shape, so the page does not jump
 *  when the rows land. */
export function LaneStripSkeleton(): ReactNode {
  return (
    <div className="card a-strip" aria-busy="true">
      <span className="sr-only">Loading the audit window…</span>
      <SkelBar width="280px" height={14} />
      {Array.from({ length: 5 }, (_, index) => (
        <div className="a-lane" key={index}>
          <SkelBar width="104px" />
          <span className="a-cells">
            <SkelBar width="100%" height={16} />
          </span>
        </div>
      ))}
    </div>
  );
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
