import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * §13's "Panes behind a rail", as the one shell both paned pages render — a port of
 * `pages/layout.tsx`'s `PaneRail` / `PanePills` / `LevelHeader`, drawn in utilities since
 * pass 2's P2b (it was legacy.css's `.rail`, `.pill-row` and `.level-header`, class for class).
 *
 * THE RAIL IS ALWAYS THE FRAMED ONE. Every paned page puts it in the one framed box
 * (`chrome/Page`'s `Workspace`, legacy.css's `.paned--framed`), so its framed shape — the
 * sunken 200px column, 28px entries a pixel apart — is its only shape, and the free-standing
 * rail legacy.css also describes is drawn by no page.
 *
 * NARROW LEVELS are read off the nearest `data-level` ancestor (the page's `<main>`, see
 * `chrome/Page`), as arbitrary variants on the attribute: below 1024px a page with levels
 * shows the rail only at level 1, as a touch-height list; a page without them (/settings)
 * hides the rail below 768px and shows the pill row instead.
 *
 * TWO navigations on every render at every width: the rail and the pill row, the second
 * hidden by CSS above the breakpoint rather than left out of the tree. Each carries its own
 * accessible name, because two navigations on one page that share their destinations are
 * otherwise indistinguishable to anyone listing the page's landmarks.
 *
 * The active entry stays a LINK carrying `aria-current="page"`: dropping it to a `<div>`
 * would leave the rail with one fewer thing to tab to and no way to say which pane you are
 * on.
 */
export type PaneEntry = {
  /** The pane's own URL — a client route, so every entry is a `<Link>`. */
  href: string;
  label: string;
  /** What the narrow pill draws. Equal to `label` on both paned pages; the column exists
   *  because /settings shortens exactly one, and the shell is shared. */
  short: string;
  marker: PaneMarker;
  current: boolean;
  /** The rail heading this entry sits under — `null` is §13's ungrouped tail. It rides the
   *  entry rather than a parallel table because the shell owns the grouping rule and a page
   *  that kept the heading elsewhere would have to be indexed in lockstep. */
  group: string | null;
};

/**
 * An entry's at-a-glance marker (§13's rail table). `null` is the table's `none` cell — no
 * marker element at all, which is what makes its absence readable. `dot` is the one marker
 * that is a STATUS rather than a count: the coloured dot is decoration, and `text` is the
 * state said in words, because a colour alone is a state only a sighted reader has. `dim`
 * is §13's "renders dimmed" — the whole entry recedes, label included, and it stays a link.
 */
export type PaneMarker = { text: string; dot?: "on" | "off" | "warn"; dim?: boolean } | null;

/** A rail group: a heading and its entries, or a headless run for the ungrouped tail the
 *  danger zone sits in. */
export type PaneGroup = { heading: string | null; entries: PaneEntry[] };

/**
 * The rail's grouping, once, for both paned pages: entries fall under their own `group`,
 * and the headings come out in the order the entries first name them — which is §13's table
 * order, so neither page states an order of its own that could drift from the order its
 * panes are actually listed in.
 */
export function paneGroups(entries: PaneEntry[]): PaneGroup[] {
  const groups: PaneGroup[] = [];
  for (const entry of entries) {
    const group = groups.find((made) => made.heading === entry.group);
    if (group === undefined) groups.push({ heading: entry.group, entries: [entry] });
    else group.entries.push(entry);
  }
  return groups;
}

/** The rail: `groups` (from `paneGroups`) as headed runs of links, named `label` for anyone
 *  listing the page's landmarks. */
export function PaneRail({ label, groups }: { label: string; groups: PaneGroup[] }): ReactNode {
  return (
    <nav className={RAIL} aria-label={label}>
      {groups.map((group, index) => (
        /* The headless run is the danger zone: no heading, and in the frame no rule either —
           the 10px above it is what separates it from the groups. */
        <div key={group.heading ?? `tail-${index}`} className={cn("flex flex-col gap-px", group.heading === null && "pt-2.5")}>
          {group.heading === null ? null : (
            <div className="mb-1 px-2 text-2xs font-medium tracking-[0.08em] text-ring uppercase">{group.heading}</div>
          )}
          {group.entries.map((entry) => (
            <Link
              key={entry.href}
              className={cn(
                RAIL_LINK,
                entry.marker?.dim === true ? "text-ring" : "text-muted-foreground",
                // The agent page's grant entry is the small one, at every width.
                entry.href.endsWith("/grant") ? "mt-0.5 text-xs" : "[[data-level]_&]:max-lg:text-md",
              )}
              to={entry.href}
              activeOptions={CURRENT_ONLY}
              aria-current={entry.current ? "page" : undefined}
            >
              <span title={entry.label} className="min-w-0 truncate">
                {entry.label}
              </span>
              {entry.marker === null ? null : (
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center text-2xs group-aria-[current=page]/rail-link:text-muted-foreground [[data-level]_&]:max-lg:ml-auto [[data-level]_&]:max-lg:pr-2",
                    entry.marker.dim === true ? "text-dim-fg" : "text-ring",
                  )}
                >
                  {entry.marker.dot === undefined ? (
                    entry.marker.text
                  ) : (
                    <>
                      <span className={cn("size-1.5 rounded-full", DOT[entry.marker.dot])} aria-hidden="true" />
                      <span className="sr-only">{entry.marker.text}</span>
                    </>
                  )}
                </span>
              )}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}

/**
 * The rail: the frame's sunken left column. Below 1024px the frame is gone, so the column
 * loses its ground, rule and padding; below 768px a page without levels hides it for the pill
 * row. A page with levels hides it at levels 2 and 3 and draws it at level 1 as the level
 * itself — `[data-level="1"]` outranks the 768px `hidden` by specificity, as legacy.css's did.
 */
const RAIL =
  "flex w-rail shrink-0 flex-col gap-2.5 overflow-auto border-r bg-sunken px-2 py-3 max-lg:border-r-0 max-lg:bg-transparent max-lg:p-0 max-md:hidden " +
  "[[data-level='2']_&]:max-lg:hidden [[data-level='3']_&]:max-lg:hidden " +
  "[[data-level='1']_&]:max-lg:flex [[data-level='1']_&]:max-lg:w-auto [[data-level='1']_&]:max-lg:py-3";

/**
 * One rail entry, whose colour (muted, or `--ring` when dimmed) and size the caller adds. The
 * current entry lifts off the sunken ground as a white chip. Below 1024px on a page with
 * levels, the entries are a touch-height list, each ending in a drawn chevron, and the current
 * one needs no chip on a level that IS the list.
 */
const RAIL_LINK =
  "group/rail-link flex h-rail-row items-center justify-between gap-1.5 rounded-sm px-2 text-sm no-underline " +
  "hover:bg-muted hover:text-foreground aria-[current=page]:bg-background aria-[current=page]:font-medium aria-[current=page]:text-foreground aria-[current=page]:shadow-xs " +
  "[[data-level]_&]:max-lg:h-control-touch [[data-level]_&]:max-lg:rounded-lg " +
  "[[data-level]_&]:max-lg:after:text-[18px] [[data-level]_&]:max-lg:after:leading-none [[data-level]_&]:max-lg:after:text-ring [[data-level]_&]:max-lg:after:content-['›'] " +
  "[[data-level]_&]:max-lg:aria-[current=page]:bg-transparent [[data-level]_&]:max-lg:aria-[current=page]:shadow-none";

/** A status marker's dot: on, off, or asking first. */
const DOT: Record<"on" | "off" | "warn", string> = {
  on: "bg-success",
  off: "bg-border",
  warn: "bg-warning",
};

/** The same panes below the breakpoint: a horizontally scrolling pill row under the page
 *  title — label only, no markers (§13's Mobile rule). Shown below 768px only. */
export function PanePills({ label, entries }: { label: string; entries: PaneEntry[] }): ReactNode {
  return (
    <nav
      className="hidden gap-2 overflow-x-auto [scrollbar-width:none] max-md:flex [&::-webkit-scrollbar]:hidden"
      aria-label={label}
    >
      {entries.map((entry) => (
        <Link
          key={entry.href}
          className="flex h-control-sm shrink-0 items-center rounded-full border bg-background px-3 text-sm font-medium whitespace-nowrap text-muted-foreground no-underline shadow-xs aria-[current=page]:border-primary aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground"
          to={entry.href}
          activeOptions={CURRENT_ONLY}
          aria-current={entry.current ? "page" : undefined}
        >
          <span>{entry.short}</span>
        </Link>
      ))}
    </nav>
  );
}

/**
 * `entry.current` is the ONE authority on which entry is marked. TanStack's `Link` also
 * stamps `aria-current="page"` on any link it judges active, and by default that is a PREFIX
 * match: `/settings` would read as current on every settings pane, and the Password entry
 * would draw as selected beside the real one. Matching the exact path only (the query being
 * a pane's own state, `?kind=` and `?sel=` alike) makes the router's judgement agree with
 * `current` rather than add to it.
 */
const CURRENT_ONLY = { exact: true, includeSearch: false } as const;

/** What the narrow level header says: the way up, and where you are. */
export type LevelHeaderModel = { backHref: string; backLabel: string; title: string };

/**
 * The narrow level header the two paned pages render (§13's level tables) — one row: the way
 * up on the left, where you are in the middle. In the tree on every render at every width
 * and shown only below the breakpoint, where it stands in for the title line and the rail at
 * once.
 *
 * The trailing span is the counterweight that centres the title against the back link; it
 * carries nothing, which is why it is hidden from anyone reading the page's contents.
 *
 * Full-bleed: it negates the page's own top padding and gutter through the `--pad-top` and
 * `--gutter` properties the page's `<main>` declares (`chrome/Page`, and legacy.css's
 * `.page--*` until every page is one).
 */
export function LevelHeader({ header }: { header: LevelHeaderModel }): ReactNode {
  return (
    <div className="hidden max-lg:-mx-(--gutter) max-lg:-mt-(--pad-top) max-lg:mb-0 max-lg:flex max-lg:h-level-header max-lg:items-center max-lg:gap-2 max-lg:border-b max-lg:px-2">
      <Link
        className="inline-flex h-control max-w-[150px] items-center truncate rounded-md px-1.5 font-medium whitespace-nowrap text-muted-foreground no-underline hover:bg-muted hover:text-foreground"
        to={header.backHref}
      >
        ‹ {header.backLabel}
      </Link>
      <span className="min-w-0 flex-1 truncate text-center text-md font-semibold">{header.title}</span>
      <span className="w-20 shrink-0" aria-hidden="true" />
    </div>
  );
}
