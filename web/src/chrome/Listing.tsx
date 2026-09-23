import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Muted, Note } from "./Text";

/**
 * The split pane's vocabulary (legacy.css's `.listing`, `.lh`, `.gh`, `.cr`, `.row-link`,
 * `.save`, `.details`, `.dh`, `.db` and their parts): a LISTING of rows on the left — a head,
 * grouped rows that scroll, a foot — and the DETAILS of the selected row beside it. Both sit
 * in `chrome/Page`'s `<Pane split>`.
 *
 * Below 1024px on a page with levels (`data-level` on the `<main>`, see `chrome/Page`) the
 * listing is level 2 and the details level 3, one at a time, full width; the listing's own
 * name goes (the level header says it), its foot sticks to the bottom of the screen, and a
 * row's control column narrows so `Via` rides above the control.
 *
 * Every part renders a `<div>` unless it says otherwise, and takes `render` to become another
 * element (`render={<form />}`, `render={<section />}`).
 */

/** A part: one element, its classes and its slot name, re-targetable with `render`. */
function part(slot: string, classes: string) {
  function Part({ className, render, ...props }: useRender.ComponentProps<"div">): ReactNode {
    return useRender({
      defaultTagName: "div",
      render,
      props: mergeProps<"div">({ className: cn(classes, className) }, props),
      state: { slot },
    });
  }
  return Part;
}

/**
 * The listing column: 520px, growing with the viewport to 760px above 1024px (a workspace is
 * the only page it sits in). `wide` is the listing alone in its pane (the grant step, an app's
 * overview and danger zone): it takes the pane's width and caps its `DetailsBody` at 640px.
 * Below 1024px it is the pane's full width; on a page with levels, only at level 2.
 */
export function Listing({
  wide = false,
  className,
  render,
  ...props
}: useRender.ComponentProps<"div"> & { wide?: boolean }): ReactNode {
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(
      {
        className: cn(
          "group/listing flex min-h-0 min-w-0 flex-col max-lg:w-auto max-lg:border-r-0 [[data-level='1']_&]:max-lg:hidden [[data-level='3']_&]:max-lg:hidden",
          wide ? "w-auto flex-1" : "w-[520px] shrink-0 border-r lg:w-[clamp(520px,38vw,760px)]",
          className,
        ),
      },
      props,
    ),
    state: { slot: "listing", wide },
  });
}

/** The listing's head: its name, what it holds, its filter, over a rule. On a page with
 *  levels below 1024px, a head whose only content is its name draws nothing. */
export const ListingHead = part(
  "listing-head",
  "flex flex-col gap-2 border-b px-4 py-3.5 [[data-level]_&]:max-lg:[&:not(:has(>:not([data-slot=listing-title])))]:hidden",
);

/**
 * `.listing-title`, 16px semibold: the listing's name in its head, and the selected row's name
 * in a `DetailsHead` or a card in the rows. Inside a `ListingHead` below 1024px on a page with
 * levels it goes, since the level header carries it; anywhere else it stays.
 */
export const ListingTitle = part(
  "listing-title",
  "text-lg font-semibold [[data-level]_[data-slot=listing-head]_&]:max-lg:hidden",
);

/** A 12px muted line saying what the listing holds or reaches. */
export const Sum = part("sum", "text-xs leading-normal text-muted-foreground");

/** The listing's scrolling region, between its head and its foot. */
export const ListingScroll = part("listing-scroll", "min-h-0 flex-1 overflow-auto");

/** `.note.gh-state`: a `Note` standing in for rows — why a group or the whole listing is
 *  empty, or what a filter left — inset 16px, as the rows are. A `<p>`. */
export function ListingNote({ className, ...props }: useRender.ComponentProps<"p">): ReactNode {
  return <Note className={cn("p-4", className)} {...props} />;
}

/**
 * A group's heading: its name and count on the left, a note or a small form on the right,
 * 11px uppercase. `sticky` keeps it over a list long enough to lose it, on an opaque ground.
 */
export function GroupHead({
  sticky = false,
  className,
  ...props
}: ComponentProps<"div"> & { sticky?: boolean }): ReactNode {
  return (
    <div
      data-slot="group-head"
      className={cn(
        "flex items-center justify-between gap-2 px-4 pt-3 pb-1 text-2xs font-medium tracking-[0.06em] text-ring uppercase",
        sticky && "sticky top-0 z-1 bg-background",
        className,
      )}
      {...props}
    />
  );
}

/** The right side of a `GroupHead`, in sentence case. `render={<label />}` or
 *  `render={<form />}` when it is a control; a form lays its fields out in a row. */
export const GroupHeadNote = part("group-head-note", "flex items-center gap-1.5 tracking-normal normal-case");

/**
 * One listing row: what it names on the left, which yields and breaks mid-token rather than
 * push the control off the listing, and its `ListRowControl` on the right. `dim` is a row
 * that no longer applies; `sub` a row nested under the one above it, indented on the sunken
 * ground. A row that is a link puts its stretched link in the first cell.
 */
export function ListRow({
  dim = false,
  sub = false,
  className,
  render,
  ...props
}: useRender.ComponentProps<"div"> & { dim?: boolean; sub?: boolean }): ReactNode {
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(
      {
        className: cn(
          "relative grid grid-cols-[1fr_auto] items-center gap-x-2.5 border-b border-row-border px-4 py-1.5 text-sm hover:bg-muted [&>:first-child]:min-w-0 [&>:first-child]:wrap-anywhere",
          dim && "opacity-60",
          sub && "bg-sunken pl-8",
          className,
        ),
      },
      props,
    ),
    state: { slot: "list-row" },
  });
}

/**
 * `.row-link`: the link that makes a whole row one target — a listing's `ListRow` or a table's
 * `TableRow link` — its `::after` stretched over the nearest positioned box, the row. An
 * `<a>`; `render={<Link … />}` for a client route, `render={<button type="button" />}` for a
 * row that opens rather than navigates. What else the row holds is raised above it.
 */
export function RowLink({ className, render, ...props }: useRender.ComponentProps<"a">): ReactNode {
  return useRender({
    defaultTagName: "a",
    render,
    props: mergeProps<"a">({ className: cn("after:absolute after:inset-0", className) }, props),
    state: { slot: "row-link" },
  });
}

/** `.ty`: the dim 11px word after a row's name saying what kind of thing it is — a schema
 *  path's type, a pattern's family. A `<span>`. */
export function ListRowType({ className, ...props }: ComponentProps<"span">): ReactNode {
  return <span data-slot="list-row-type" className={cn("text-2xs text-ring", className)} {...props} />;
}

/** The 11px line under a row's name; `warn` is a dormant entry's amber. */
export function ListRowDetail({
  warn = false,
  className,
  ...props
}: ComponentProps<"div"> & { warn?: boolean }): ReactNode {
  return (
    <div
      data-slot="list-row-detail"
      className={cn("mt-px text-2xs", warn ? "text-warning" : "text-muted-foreground", className)}
      {...props}
    />
  );
}

/** A row's control column, raised above the row's stretched link so it stays clickable. On a
 *  page with levels below 1024px it wraps at 190px. */
export const ListRowControl = part(
  "list-row-control",
  "relative z-1 flex items-center justify-end gap-1.5 [[data-level]_&]:max-lg:max-w-[190px] [[data-level]_&]:max-lg:flex-wrap",
);

/** "via reader": what grants a row, beside its control; on a page with levels below 1024px,
 *  a right-aligned line of its own above the control. A `<span>`. */
export function Via({ className, ...props }: ComponentProps<"span">): ReactNode {
  return (
    <span
      data-slot="via"
      className={cn(
        "text-2xs whitespace-nowrap text-muted-foreground [[data-level]_&]:max-lg:block [[data-level]_&]:max-lg:w-full [[data-level]_&]:max-lg:text-right",
        className,
      )}
      {...props}
    />
  );
}

/** The foot of a paged walk: the next-page control and the sentence saying what is past it.
 *  It scrolls with the rows it follows. */
export const ListingMore = part("listing-more", "flex items-baseline gap-2 px-4 py-3 text-xs");

/**
 * The listing's foot on the sunken ground: the destructive control at the start, a `SaveBarEnd`
 * at the end. On a page with levels below 1024px it sticks to the bottom of the screen over
 * the rows (above their raised controls), on one line.
 */
export const SaveBar = part(
  "save-bar",
  "flex items-center justify-between gap-2.5 border-t bg-sunken px-4 py-3 text-xs [[data-level]_&]:max-lg:sticky [[data-level]_&]:max-lg:bottom-0 [[data-level]_&]:max-lg:z-2 [[data-level]_&]:max-lg:flex-nowrap [[data-level]_&]:max-lg:px-3 [[data-level]_&]:max-lg:py-2.5",
);

/** The end of a `SaveBar`: its counts and its verbs, pushed to the edge on a phone. */
export const SaveBarEnd = part("save-bar-end", "flex items-center gap-2.5 [[data-level]_&]:max-lg:ml-auto");

/** The saved counts in a `SaveBarEnd`: a `Muted` span, gone below 1024px on a page with levels
 *  (the head's reach line says them too). */
export function SaveBarCount({ className, ...props }: ComponentProps<"span">): ReactNode {
  return <Muted data-slot="save-bar-count" className={cn("[[data-level]_&]:max-lg:hidden", className)} {...props} />;
}

/** The details column beside the listing, on the sunken ground, scrolling on its own; on a
 *  page with levels below 1024px, only at level 3. */
export const Details = part(
  "details",
  "flex min-w-0 flex-1 flex-col overflow-auto bg-sunken max-lg:overflow-visible [[data-level='1']_&]:max-lg:hidden [[data-level='2']_&]:max-lg:hidden",
);

/** The details column's head: the selected row's name and badges on white, over a rule. */
export const DetailsHead = part("details-head", "border-b bg-background px-4 py-3.5");

/** The details column's body: a stack of `Card size="sm"` panels and `KvList`s. Inside a
 *  `wide` listing it is capped at 640px. */
export const DetailsBody = part(
  "details-body",
  "flex flex-col gap-3.5 px-4 py-3.5 group-data-[wide]/listing:max-w-pane",
);

/** A head's totals, one 12px muted line; wrapping on a page with levels below 1024px. */
export const Tiles = part(
  "tiles",
  "flex gap-4 text-xs text-muted-foreground [[data-level]_&]:max-lg:flex-wrap [[data-level]_&]:max-lg:gap-x-3.5 [[data-level]_&]:max-lg:gap-y-2",
);
