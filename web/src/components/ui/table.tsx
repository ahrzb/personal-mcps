import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/cn"

/**
 * Rows of records, drawn as legacy.css's `.table` — or, at `size="dense"`, as /audit's
 * `.a-etab` (11px uppercase heads, 6px cell padding, top-aligned, a rule under the last row
 * too, because a foot follows it inside the card).
 *
 * Below 768px every table stacks, as `.table` does: the header row goes and each body row is
 * a block — a card body — holding its cells as blocks. The actions cell (`variant="actions"`)
 * becomes a row of its own under the card; what any other cell shows at that width (the
 * one-line summary, /audit's ordering) is the caller's, as className on its cells, and
 * `preview/fixtures/primitives/table.tsx` spells each one.
 *
 * Rows neither hover nor tint by themselves: a row that is a link says `link`, and holds the
 * stretched link (`chrome/Listing`'s `RowLink`) in its first cell. A selected row is
 * `data-state="selected"`.
 *
 * The container neither scrolls nor positions, because legacy's `.table` had no wrapper and
 * each property alone moves pixels: `relative` drops Chrome to greyscale antialiasing on the
 * head text (/audit's events at 1280, found by p3-audit), and `overflow-x-auto` shifts
 * antialiased corners inside it (app-detail's Overview at 390, found by p3-app-detail). So a
 * stretched row link measures against its own row's `relative`, never the container.
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
      className="w-full"
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
function TableRow({
  className,
  link = false,
  ...props
}: React.ComponentProps<"tr"> & {
  /** The whole row is the link in its first cell (legacy.css's `.agent-row`, `.app-row`): it
   *  positions that link's stretched `::after`, fills when hovered, and raises its actions
   *  cell above the link so the row's own controls still take their clicks. */
  link?: boolean
}) {
  return (
    <tr
      data-slot="table-row"
      data-link={link || undefined}
      className={cn(
        "data-[state=selected]:bg-muted max-md:block max-md:border-b max-md:border-row-border max-md:px-4 max-md:py-3 group-data-[size=dense]/table:max-md:px-3.5 group-data-[size=dense]/table:max-md:py-2.5",
        link && "group/row relative cursor-pointer hover:bg-muted",
        className
      )}
      {...props}
    />
  )
}

/** `.row-chevron`: the chevron closing a link row's actions cell. Decoration for where the row
 *  goes, so hidden from anyone listing the page's links: the row's link says it. */
function TableRowChevron() {
  return (
    <span data-slot="table-row-chevron" className="inline-flex items-center text-ring">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m9 6 6 6-6 6" />
      </svg>
    </span>
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

const tableCellVariants = cva(
  "border-b border-row-border align-middle text-sm max-md:block max-md:border-b-0 max-md:p-0 md:px-5 md:py-3 group-data-[size=dense]/table:align-top group-data-[size=dense]/table:md:px-4 group-data-[size=dense]/table:md:py-1.5",
  {
    variants: {
      variant: {
        default: "",
        /** `.cell-mono`: an identifier in 12px mono, breaking anywhere, so a key prefix or a
         *  slug never widens the card. */
        mono: "font-mono text-xs wrap-anywhere",
        /** `.cell-actions`: the row's controls, right-aligned on one line; below 768px their
         *  own left-aligned row under the card. In a `link` row it is raised above the row's
         *  link. Its buttons are `size="cell"`. */
        actions:
          "text-right whitespace-nowrap max-md:mt-2.5 max-md:flex max-md:gap-2.5 max-md:text-left group-data-[link]/row:relative group-data-[link]/row:z-1",
      },
    },
    defaultVariants: { variant: "default" },
  }
)

/**
 * A cell. It WRAPS, unlike the generated one: a long token must break inside the card rather
 * than push the table past it. Unpadded and unruled below 768px, where the row's padding and
 * rule are the card's. `variant` names the legacy cell looks a page reuses.
 */
function TableCell({
  className,
  variant,
  ...props
}: React.ComponentProps<"td"> & VariantProps<typeof tableCellVariants>) {
  return (
    <td
      data-slot="table-cell"
      className={cn(tableCellVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Table, TableHeader, TableBody, TableHead, TableRow, TableRowChevron, TableCell }
