import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

/**
 * §13's "Panes behind a rail", as the one shell both paned pages render — a port of
 * `pages/layout.tsx`'s `PaneRail` / `PanePills` / `LevelHeader`, class for class.
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

export function PaneRail({ label, groups }: { label: string; groups: PaneGroup[] }): ReactNode {
  return (
    <nav className="rail" aria-label={label}>
      {groups.map((group, index) => (
        /* The headless run is the danger zone: no heading, but a rule above it, which is how
           the board separates it from the groups without a third heading. */
        <div key={group.heading ?? `tail-${index}`} className={group.heading === null ? "rail-group rail-group--tail" : "rail-group"}>
          {group.heading === null ? null : <div className="rail-heading">{group.heading}</div>}
          {group.entries.map((entry) => (
            <Link
              key={entry.href}
              className={entry.marker?.dim === true ? "rail-link rail-link--dim" : "rail-link"}
              to={entry.href}
              activeOptions={CURRENT_ONLY}
              aria-current={entry.current ? "page" : undefined}
            >
              <span title={entry.label}>{entry.label}</span>
              {entry.marker === null ? null : (
                <span className="rail-marker">
                  {entry.marker.dot === undefined ? (
                    entry.marker.text
                  ) : (
                    <>
                      <span className={`rail-dot rail-dot--${entry.marker.dot}`} aria-hidden="true" />
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

/** The same panes below the breakpoint: a horizontally scrolling pill row under the page
 *  title — label only, no markers (§13's Mobile rule). */
export function PanePills({ label, entries }: { label: string; entries: PaneEntry[] }): ReactNode {
  return (
    <nav className="pill-row" aria-label={label}>
      {entries.map((entry) => (
        <Link
          key={entry.href}
          className="pill"
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
 */
export function LevelHeader({ header }: { header: LevelHeaderModel }): ReactNode {
  return (
    <div className="level-header">
      <Link className="level-back" to={header.backHref}>
        ‹ {header.backLabel}
      </Link>
      <span className="level-title">{header.title}</span>
      <span className="level-end" aria-hidden="true" />
    </div>
  );
}
