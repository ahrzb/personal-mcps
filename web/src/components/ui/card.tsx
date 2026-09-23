import * as React from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/cn"

const cardVariants = cva(
  "group/card overflow-hidden rounded-lg border bg-card shadow-xs",
  {
    variants: {
      size: {
        /** legacy.css's `.card--pad`: prose and controls, 24px in (16px on a phone). */
        default: "flex flex-col gap-4 p-6 max-md:p-4",
        /** `.db .card--pad`: a panel inside a details column, where 24px reads as a margin. */
        sm: "flex flex-col gap-2 px-3.5 py-3",
        /** The bare `.card`: a table, or its own `CardHeader`/`CardContent` sections, edge to
         *  edge. A block, not a flex column. */
        flush: "",
        /** `.auth-card`: the one card of a sign-in, device, consent or approval page. It goes
         *  chromeless and full-bleed on a phone, and does not clip what it holds. */
        auth: "flex w-auth max-w-full flex-col gap-5 overflow-visible p-6 max-md:rounded-none max-md:border-0 max-md:shadow-none",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
)

/**
 * The bordered, raised white surface every page groups its content in (legacy.css's `.card`
 * and its padded, detail-column and auth forms, one per `size`).
 *
 * A card with a danger action wears `className="border-danger-border"` (`.card--danger`).
 * `render` makes it another element, e.g. `render={<form />}` for a card that submits.
 */
function Card({
  className,
  size = "default",
  render,
  ...props
}: useRender.ComponentProps<"div"> & VariantProps<typeof cardVariants>) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      { className: cn(cardVariants({ size }), className) },
      props
    ),
    render,
    state: { slot: "card", size },
  })
}

/** `.card-head`: the title block on the left, one action on the right, top-aligned. The
 *  caller wraps title and description in one element when there is an action beside them. */
function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn("flex items-start justify-between gap-4", className)}
      {...props}
    />
  )
}

/**
 * `.card-title`, 16px semibold; 20px on a phone inside an `auth` card. `render={<h2 />}` for a
 * heading, which then also takes the base heading rule's 1.2 line height.
 */
function CardTitle({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(
          "text-lg font-semibold group-data-[size=auth]/card:max-md:text-title-narrow",
          className
        ),
      },
      props
    ),
    render,
    state: { slot: "card-title" },
  })
}

/** `.card-desc`, the muted line under a title; 14px on a phone inside an `auth` card. */
function CardDescription({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(
          "mt-1 text-sm text-muted-foreground group-data-[size=auth]/card:max-md:text-base",
          className
        ),
      },
      props
    ),
    render,
    state: { slot: "card-description" },
  })
}

/** A padded section of a `flush` card, above or below its table: `.card--pad` used as a part
 *  rather than as the card. */
function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("flex flex-col gap-4 p-6 max-md:p-4", className)}
      {...props}
    />
  )
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent }
