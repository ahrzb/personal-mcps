import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
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

/** The class name is ALWAYS printed beside the colour (§13), so this is never rendered alone —
 *  it is the mark beside a word, not the word. */
export function Swatch({ cls }: { cls: OutcomeClass | "nl" }): ReactNode {
  return <span className={`a-sw a-sw--${cls}`} aria-hidden="true" />;
}

/** Which shared badge modifier an outcome class wears: green for the one that ran, red for the
 *  two that failed, amber for the two the owner can still act on. */
const BADGE_OF: Record<OutcomeClass, string> = {
  ok: "badge badge--success",
  approval: "badge badge--warning",
  archived: "badge badge--warning",
  denied: "badge badge--danger",
  error: "badge badge--danger",
};

/** An outcome as a chip: the class NAME, in the class's colour. Never the colour alone, and
 *  never the raw code — the record's field table is where the code is said. */
export function OutcomeBadge({ cls, count }: { cls: OutcomeClass; count?: number }): ReactNode {
  return (
    <span className={BADGE_OF[cls]}>
      {cls}
      {count === undefined ? null : ` ${fmtCount(count)}`}
    </span>
  );
}

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
      {of.secondary === null ? null : <span className="a-sub2"> {of.secondary}</span>}
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
    <div className="a-search">
      <SearchIcon />
      <input
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
        <span className="note a-searching" role="status">
          Searching…
        </span>
      ) : null}
    </div>
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

/** A block of the right height while a read is in flight. The page's own, not `chrome/States`'
 *  Tailwind one, because these stand in for a strip and a rail rather than for table rows. */
export function SkelBar({ width, height }: { width: string; height?: number }): ReactNode {
  return <span className="a-skel" style={{ width, ...(height === undefined ? {} : { height }) }} />;
}

/** The narrow breakpoint, spelled once. A media query cannot read a custom property, so
 *  `styles.css` names 767 in prose and every rule writes it — including this one. */
const NARROW = "(max-width: 767px)";

/**
 * Whether the viewport is the phone's.
 *
 * A hook rather than a CSS rule because one decision genuinely cannot be made in CSS: the
 * strip names FOUR principals at narrow and six at wide, and the folded lane's label counts
 * the rest — so hiding two lanes with `display: none` would leave "2 others" beside four
 * hidden ones. Everything else about the phone is in the stylesheet.
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
