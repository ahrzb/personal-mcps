import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { cn } from "@/lib/cn";
import { Note } from "@/chrome/Text";
import { fmtCount } from "./derive";
import type { OutcomeClass } from "./derive";

/**
 * The explorer's own smallest views, and the two hooks its layout needs.
 *
 * A NINTH file beside the eight §3 names, and the reason is a dependency cycle rather than a
 * preference: the swatch, the outcome chip and the search box are used by the strip, the rail,
 * all three views and the record, so putting them in `AuditPage.tsx` — which imports every one
 * of those — would make the page and its parts import each other. They are leaves, so they
 * live at the bottom.
 */

/** A box's hover outline, drawn inside it so the row it sits in does not move. */
export const HOVER_RING = "hover:shadow-[inset_0_0_0_1px_var(--color-border)]";

/**
 * A bar-backed row, as a toggle or a link: the facet rail's values and the summary's changes. It
 * sets no height, since the two differ. Its bar is `absolute` and painted over whatever is not
 * positioned, so every label in it says `relative`.
 */
export const FROW = `relative flex w-full cursor-pointer items-center gap-[7px] rounded-[5px] border-0 bg-transparent px-[5px] py-0 text-left text-xs text-inherit aria-pressed:bg-border aria-pressed:font-semibold ${HOVER_RING}`;

/** A bar-backed row's value, in mono, clipped to the row. */
export const FROW_VALUE = "relative truncate font-mono";

/** A bar-backed row's figure — a count, a time — muted at 11px against the row's end. */
export const FROW_FIGURE = "relative ml-auto pl-1.5 text-2xs text-muted-foreground";

/** A timeline line's clock: a 52px mono column, so the lines' words start level. */
export const CLOCK = "w-[52px] flex-none font-mono text-muted-foreground";

/** A list card's foot: Load more and what the list holds. The foot wraps on the phone rather
 *  than pushing the card wider on its one long sentence. */
export const MORE = "flex items-center gap-2.5 border-t px-3.5 py-2.5 max-md:flex-wrap";

/** The record's head and the Filters level's: a bar over the body, which on the phone is the
 *  level header, with `‹ Audit` on a line of its own above the title. */
export const LEVEL_HEAD =
  "flex items-center gap-2.5 border-b px-4 py-3 max-md:flex-wrap max-md:gap-y-0.5 max-md:pt-1 max-md:pb-2.5";

/** `‹ Audit`, the way back out of a level: a 44px line of its own on the phone. It sets no
 *  display: the record shows it on the phone only, the Filters level at every width. */
export const BACK =
  "cursor-pointer items-center border-0 bg-transparent p-0 text-base font-medium text-muted-foreground max-md:h-control-touch max-md:flex-[1_1_100%]";

/** The hatch that means "not loaded": an hour the ceiling cut off, which must never read as an
 *  hour in which nothing happened. A background IMAGE with no colour under it. */
export const HATCH =
  "bg-[repeating-linear-gradient(45deg,var(--color-dim-fg)_0_2px,var(--color-sunken)_2px_4px)]";

/** Each outcome's fill, and the hatch's. One class per key, so a mark never wears two fills. */
export const FILL: Record<OutcomeClass | "nl", string> = {
  ok: "bg-o-ok",
  approval: "bg-o-approval",
  archived: "bg-o-archived",
  denied: "bg-o-denied",
  error: "bg-o-error",
  nl: HATCH,
};

/** The class name is ALWAYS printed beside the colour (§13), so this is never rendered alone —
 *  it is the mark beside a word, not the word. `className` is its row's: a bar-backed row
 *  raises it over the bar. */
export function Swatch({ cls, className }: { cls: OutcomeClass | "nl"; className?: string }): ReactNode {
  return (
    <span className={cn("inline-block size-[9px] flex-none rounded-[2px]", FILL[cls], className)} aria-hidden="true" />
  );
}

/** Which badge tone an outcome class wears: green for the one that ran, red for the two that
 *  failed, amber for the two the owner can still act on. */
const BADGE_OF = {
  ok: "success",
  approval: "warning",
  archived: "warning",
  denied: "danger",
  error: "danger",
} as const satisfies Record<OutcomeClass, string>;

/** An outcome as a chip: the class NAME, in the class's colour. Never the colour alone, and
 *  never the raw code — the record's field table is where the code is said. */
export function OutcomeBadge({ cls, count }: { cls: OutcomeClass; count?: number }): ReactNode {
  return (
    <Badge variant={BADGE_OF[cls]}>
      {cls}
      {count === undefined ? null : ` ${fmtCount(count)}`}
    </Badge>
  );
}

/** What a title is about, beside it: dim, and never bold even inside a bold title. */
export const SECONDARY = "font-normal text-muted-foreground";

/**
 * A title with what the row is ABOUT beside it, dim — the rendering of `derive.titleOf` and
 * `derive.titleOfMerged`, which are what decide the two strings.
 *
 * One component, so the page cannot spell a title two ways: the Events table, the waterfall,
 * the record head and the approval timeline all draw this.
 */
export function Titled({ of }: { of: { title: string; secondary: string | null } }): ReactNode {
  return (
    <>
      <span>{of.title}</span>
      {of.secondary === null ? null : <span className={SECONDARY}> {of.secondary}</span>}
    </>
  );
}

/**
 * The page's and the record's search box — a real label for anyone not looking at the
 * magnifier, which is decoration.
 *
 * `inputRef` is the page's: `/` focuses the filter bar's box from anywhere, which needs a
 * handle on the element rather than an id.
 */
/**
 * A search box that owns BOTH its text and its debounce, and tells its page only about settled
 * text.
 *
 * That division is the whole of it (postmortem 2026-09-21). A keystroke is a `setState` on this
 * component and nothing else: no navigation, no re-derivation of five thousand rows, no reset of
 * how far the reader had scrolled. The page's URL and its query key move once per pause, which
 * is also the only moment the server could answer anything different.
 *
 * `initial` is the settled text as the URL holds it. Re-seeding the box from it would otherwise
 * be a race — the page's own echo arrives a render late, so a box that trusted it would snap
 * back to a stale value and eat whatever was typed in between. The guard is `emitted`: what this
 * box last HANDED UP. The URL can only differ from that if something else changed it — Clear, a
 * deep link, a navigation — and only then is the box re-seeded.
 */
export function SearchBox({
  initial,
  onSettled,
  debounceMs = 250,
  placeholder,
  label,
  inputRef,
  busy = false,
  className,
}: {
  /** The settled text, from the URL. */
  initial: string;
  /** Called once per pause, with text that differs from what was last emitted. */
  onSettled: (next: string) => void;
  debounceMs?: number;
  placeholder: string;
  /** What the box searches, for a screen reader — the placeholder is not a label. */
  label: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /** A read for this text is in flight. */
  busy?: boolean;
  /** The box's width and narrow height where it sits: the filter bar's box is 260px at least
   *  and grows to the touch height; the record's is the drawer's width. */
  className?: string;
}): ReactNode {
  const [typed, setTyped] = useState(initial);
  const emitted = useRef(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  // An EXTERNAL change only — one this box did not cause. A pending emit is dropped with it, or
  // Clear would be undone a quarter of a second later by the keystroke that preceded it.
  useEffect(() => {
    if (initial === emitted.current) return;
    clear();
    emitted.current = initial;
    setTyped(initial);
  }, [initial]);

  useEffect(() => clear, []);

  return (
    <InputGroup size="sm" className={className}>
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupInput
        ref={inputRef}
        value={typed}
        placeholder={placeholder}
        aria-label={label}
        onChange={(event) => {
          const next = event.target.value;
          setTyped(next);
          clear();
          timer.current = setTimeout(() => {
            timer.current = null;
            if (next === emitted.current) return;
            emitted.current = next;
            onSettled(next);
          }, debounceMs);
        }}
      />
      {/* Inside the box, because the box is what the reader is looking at while they wait —
          and announced, because the only other sign is rows that have not changed yet. */}
      {busy ? (
        <Note render={<InputGroupAddon role="status" />}>Searching…</Note>
      ) : null}
    </InputGroup>
  );
}

export function SearchIcon(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

export function WarnIcon(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  );
}

/**
 * A still bar of the right height while a read is in flight, shaded muted → bar → muted. The
 * page's own, not `ui/skeleton`, because that one pulses and is a block: this one is an INLINE
 * span, so where its parent is a block rather than a flex row it draws nothing, as it always
 * has. `data-slot="skeleton"` is what `scripts/audit-search-check.mts` watches for.
 */
export function SkelBar({ width, height, className }: { width: string; height?: number; className?: string }): ReactNode {
  return (
    <span
      data-slot="skeleton"
      className={cn(
        "h-3 rounded-sm bg-[linear-gradient(90deg,var(--color-muted),var(--color-a-bar),var(--color-muted))]",
        className,
      )}
      style={{ width, ...(height === undefined ? {} : { height }) }}
    />
  );
}

/** The narrow breakpoint, spelled once: the query every `max-md:` class on this page answers to
 *  (app.css's `--breakpoint-md`, 768px). */
const NARROW = "(max-width: 767px)";

/**
 * Whether the viewport is the phone's.
 *
 * A hook rather than a CSS rule because one decision genuinely cannot be made in CSS: the
 * strip names FOUR principals at narrow and six at wide, and the folded lane's label counts
 * the rest — so hiding two lanes with `display: none` would leave "2 others" beside four
 * hidden ones. Everything else about the phone is in the `max-md:` classes.
 */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = matchMedia(NARROW);
    const update = (): void => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

/**
 * `/` focuses the search box, unless the reader is already typing somewhere.
 *
 * On the document, because the shortcut has to work with focus anywhere on the page — which is
 * also why the guard is here: a `/` typed into a field is a slash, not a command.
 */
export function useSlashFocus(target: React.RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "/") return;
      const at = event.target;
      if (at instanceof HTMLElement && (at.tagName === "INPUT" || at.tagName === "TEXTAREA" || at.isContentEditable)) {
        return;
      }
      event.preventDefault();
      target.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [target]);
}

/** A label that says it was copied, for about two seconds. The whole of this page's write
 *  feedback: nothing here mutates the hub, so a flash banner would be a banner about the
 *  clipboard. */
export function useCopied(): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
  return [
    copied,
    () => {
      setCopied(true);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    },
  ];
}
