import * as React from "react"
import { cn } from "@/lib/cn"

/**
 * Rows of records, drawn as legacy.css's `.table` — or, at `size="dense"`, as /audit's
 * `.a-etab` (11px uppercase heads, 6px cell padding, top-aligned, a rule under the last row
 * too, because a foot follows it inside the card).
 *
 * Below 768px every table stacks, as `.table` does: the header row goes and each body row is
 * a block — a card body — holding its cells as blocks. What a cell shows at that width (the
 * one-line summary, the actions row, /audit's ordering) is the caller's, as className on its
 * cells; `preview/fixtures/primitives/table.tsx` spells each one.
 *
 * Rows neither hover nor tint by themselves: a row that is a link carries its own
 * `relative cursor-pointer hover:bg-muted` beside the stretched link inside it. A selected row
 * is `data-state="selected"`.
 *
 * The container scrolls sideways rather than letting a too-wide table clip at the card's edge.
 */
function Table({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"table"> & {
  /** `dense` is /audit's events table; `default` every other one. */
  size?: "default" | "dense"
}) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
    >
      <table
        data-slot="table"
        data-size={size}
        className={cn(
          "group/table w-full border-collapse text-left max-md:block max-md:w-auto",
          className
        )}
        {...props}
      />
    </div>
  )
}

/** The header row group. Gone below 768px. */
function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("max-md:hidden", className)}
      {...props}
    />
  )
}

/** The body row group. A default table's last row drops its rule, since the card's edge is
 *  right under it. */
function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn(
        "max-md:block group-data-[size=default]/table:[&>tr:last-child]:border-b-0 group-data-[size=default]/table:[&>tr:last-child>*]:border-b-0",
        className
      )}
      {...props}
    />
  )
}

/**
 * One row. Wide, its rule is its cells' (a row's own border would sit inside the box that a
 * stretched link's `::after` fills, a pixel short of today's); stacked below 768px, the rule
 * is the row's, under each card.
 */
function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "data-[state=selected]:bg-muted max-md:block max-md:border-b max-md:border-row-border max-md:px-4 max-md:py-3 group-data-[size=dense]/table:max-md:px-3.5 group-data-[size=dense]/table:max-md:py-2.5",
        className
      )}
      {...props}
    />
  )
}

/** A column heading: muted, one line at the default size, over a rule darker than the rules
 *  between body rows. */
function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "border-b border-border px-5 py-3 text-left align-middle text-sm font-medium whitespace-nowrap text-muted-foreground group-data-[size=dense]/table:px-4 group-data-[size=dense]/table:text-2xs group-data-[size=dense]/table:tracking-[0.04em] group-data-[size=dense]/table:whitespace-normal group-data-[size=dense]/table:uppercase",
        className
      )}
      {...props}
    />
  )
}

/**
 * A cell. It WRAPS, unlike the generated one: a long token must break inside the card rather
 * than push the table past it. Unpadded and unruled below 768px, where the row's padding and
 * rule are the card's.
 */
function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "border-b border-row-border align-middle text-sm max-md:block max-md:border-b-0 max-md:p-0 md:px-5 md:py-3 group-data-[size=dense]/table:align-top group-data-[size=dense]/table:md:px-4 group-data-[size=dense]/table:md:py-1.5",
        className
      )}
      {...props}
    />
  )
}

export { Table, TableHeader, TableBody, TableHead, TableRow, TableCell }
