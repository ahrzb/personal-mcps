import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  OUTCOME_CLASSES,
  ceilingNotice,
  fmtCount,
  fmtDay,
  fmtDayTime,
  outcomeLabel,
} from "./derive";
import type { AuditSelection, Lane, OutcomeClass } from "./derive";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FILL, NOTE, SkelBar, Swatch, WarnIcon } from "./parts";

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
     is also why the brush is not drawn below 768px. */
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
    <Card size="flush" className={STRIP}>
      <div className="flex flex-wrap items-center gap-2.5 max-md:gap-x-2 max-md:gap-y-1.5 max-md:text-xs">
        <span className="text-sm font-semibold max-md:text-xs max-md:whitespace-nowrap">
          {fmtDayTime(selection.since)} → {fmtDayTime(selection.until)}
        </span>
        {/* On the phone the presets pull right onto the window text's own row, at their own
            width rather than stretched to fill it. */}
        <div className="inline-flex gap-1 max-md:ml-auto max-md:flex-[0_0_auto]">
          <Preset on={selection.until - selection.since <= HOUR} label="1h" onPick={() => back(1)} />
          <Preset on={selection.until - selection.since === 24 * HOUR} label="24h" onPick={() => back(24)} />
          <Preset on={!selection.brushed} label={`${retentionDays}d`} onPick={() => onBrush(null)} />
        </div>
        <span className={`${NOTE} max-md:hidden`}>
          an hour per cell, coloured by the worst outcome in it — drag to select
        </span>
        {selection.brushed ? (
          <Button variant="outline" size="xs" className="ml-auto" onClick={() => onBrush(null)}>
            Whole window
          </Button>
        ) : (
          <span className="ml-auto max-md:hidden" />
        )}
        <Badge className="max-md:hidden">{fmtCount(selected)} events selected</Badge>
      </div>

      {total > ceiling ? (
        <Alert variant="warning" size="compact" role="status">
          <WarnIcon />
          <span>{ceilingNotice(ceiling, total)}</span>
        </Alert>
      ) : null}

      {/* `--gut` is the lane-name column, and the brush is positioned against it: the cells
          start where the names end, so a percentage of the strip is not a percentage of the
          window. The phone sets it to 0, names sitting above their cells, and draws no brush:
          a drag there is a scroll, so the presets and the axis are the controls. */}
      <div
        className="relative flex cursor-crosshair flex-col gap-[3px] select-none [--gut:114px] max-md:cursor-default max-md:gap-0.5 max-md:[--gut:0px]"
        ref={lanesRef}
        tabIndex={0}
        role="group"
        aria-label="Activity by principal and hour. Arrow keys move the selected window, Shift with an arrow resizes it."
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
      >
        {lanes.map((lane) => (
          <div className={LANE} key={lane.name}>
            <span
              className="w-[104px] flex-none truncate font-mono text-2xs text-fg-subtle max-md:w-full max-md:flex-[1_1_100%] max-md:leading-[13px]"
              title={lane.title}
            >
              {lane.name}
            </span>
            <span className={CELLS} aria-hidden="true">
              {lane.cells.map((cell, hour) => (
                <span
                  key={hour}
                  className={`flex-1 rounded-[1px] ${cell === null ? "bg-muted" : FILL[cell === "not-loaded" ? "nl" : cell]}`}
                />
              ))}
            </span>
          </div>
        ))}
        {selection.brushed ? (
          <div
            className="pointer-events-none absolute -top-[3px] -bottom-[3px] rounded-[2px] border-x-2 border-primary bg-[rgba(24,24,27,0.07)] max-md:hidden"
            style={{
              // Against `--gut`, because the cells begin where the lane names end: a plain
              // percentage of the strip would place the brush an entire name column early.
              left: `calc(var(--gut) + (100% - var(--gut)) * ${(selection.since - window.start) / span})`,
              width: `calc((100% - var(--gut)) * ${(selection.until - selection.since) / span})`,
            }}
          />
        ) : null}
      </div>

      <div className="ml-[114px] flex text-2xs text-muted-foreground max-md:ml-0 max-md:gap-0.5">
        {Array.from({ length: retentionDays }, (_, index) => (
          <button
            key={index}
            type="button"
            className="flex-1 cursor-pointer rounded-[4px] border-0 bg-transparent px-0 py-0.5 text-left font-[family-name:inherit] text-2xs text-muted-foreground hover:bg-muted hover:text-foreground aria-pressed:bg-muted aria-pressed:font-medium aria-pressed:text-foreground max-md:min-h-control-touch max-md:text-center"
            aria-pressed={dayOn(index)}
            onClick={() => onBrush({ since: dayAt(index), until: dayAt(index) + DAY })}
          >
            {fmtDay(dayAt(index))}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-2xs text-muted-foreground max-md:gap-x-2.5 max-md:gap-y-1 max-md:leading-4">
        <span className={`${LEGEND_ITEM} font-medium text-fg-subtle max-md:hidden`}>Worst outcome in the hour:</span>
        {/* At wide the legend says what each colour MEANS, in the hub's own words; the class
            name alone is what fits at 375. Never the raw codes: a `-32001` beside a swatch is
            a number to go and look up, and the record is the one place that prints one. */}
        {OUTCOME_CLASSES.map((cls) => (
          <span className={LEGEND_ITEM} key={cls}>
            <Swatch cls={cls} />
            <span className="hidden max-md:inline">{cls}</span>
            <span className="max-md:hidden">{LEGEND_WORDS[cls]}</span>
          </span>
        ))}
        {anyNotLoaded ? (
          <span className={LEGEND_ITEM}>
            <Swatch cls="nl" />
            not loaded
          </span>
        ) : null}
      </div>
    </Card>
  );

  /** A preset window, ending where the LOADED window ends — not at the browser's clock, which
   *  would disagree with the read by however long the page has been open. */
  function back(count: number): void {
    onBrush({ since: window.end - count * HOUR, until: window.end });
  }
}

/** A preset: a 24px control in the dense strip, the touch height on the phone. */
function Preset({ on, label, onPick }: { on: boolean; label: string; onPick: () => void }): ReactNode {
  return (
    <Button
      variant={on ? "default" : "outline"}
      size="xs"
      className="max-md:h-control-touch max-md:px-[11px] max-md:text-xs"
      aria-pressed={on}
      onClick={onPick}
    >
      {label}
    </Button>
  );
}

/** The strip while the window is still loading: the lanes' shape, so the page does not jump
 *  when the rows land. */
export function LaneStripSkeleton(): ReactNode {
  return (
    <Card size="flush" className={STRIP} aria-busy="true">
      <span className="sr-only">Loading the audit window…</span>
      <SkelBar width="280px" height={14} />
      {Array.from({ length: 5 }, (_, index) => (
        <div className={LANE} key={index}>
          <SkelBar width="104px" />
          <span className={CELLS}>
            <SkelBar width="100%" height={16} />
          </span>
        </div>
      ))}
    </Card>
  );
}

/** The strip's card: a column of its rows, tighter on the phone. */
const STRIP = "flex flex-col gap-1.5 px-3.5 py-3 max-md:gap-1 max-md:px-3 max-md:py-2";

/** One principal: its name, then its hours; on the phone the name sits on a line above them. */
const LANE = "flex items-center gap-2.5 max-md:flex-wrap max-md:gap-0.5";

/** A lane's hours, one cell each: 16px tall, and 10px and touching on the phone. */
const CELLS = "flex h-4 min-w-0 flex-1 gap-px max-md:h-2.5 max-md:flex-[1_1_100%] max-md:gap-0";

const LEGEND_ITEM = "inline-flex items-center gap-[5px]";

/**
 * What each colour means, in words, at the wide tier.
 *
 * A CLASS is the page's grouping and `denied` folds two codes, so its entry names both halves:
 * the reader has to know that one red cell can be either refusal, and neither the class name
 * nor a pair of numbers would tell them. `derive.outcomeLabel` owns the per-code wording and
 * these are built from it, so the legend cannot drift from the record.
 */
const LEGEND_WORDS: Record<OutcomeClass, string> = {
  ok: outcomeLabel("ok"),
  approval: outcomeLabel("-32003"),
  archived: outcomeLabel("-32002"),
  denied: `denied — ${outcomeLabel("-32001")} or ${outcomeLabel("-32000").replace("app ", "")}`,
  error: outcomeLabel("error"),
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
