import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/cn"

const alertVariants = cva("flex rounded-md border", {
  variants: {
    /** The tone, named as `NoticeTone` names it (`lib/format.ts`), so a notice passes its own
     *  tone through; `default` is the untoned grey box. */
    variant: {
      default: "border-transparent bg-muted text-muted-foreground",
      success: "border-success-border bg-success-bg text-success",
      warning: "border-warning-border bg-warning-bg text-warning",
      danger: "border-danger-border bg-danger-bg text-danger-fg",
    },
    /** `compact` is /audit's one-line ceiling notice (`.a-ceiling`): 12px, centred on its
     *  icon, and inheriting its line height. Its icon may shrink, as `.a-ceiling`'s always
     *  has, so a message that wraps on a phone squeezes it to a sliver. */
    size: {
      default: "gap-2.5 px-3.5 py-3 text-sm leading-normal [&>svg]:mt-0.5 [&>svg]:shrink-0",
      compact: "items-center gap-2 px-3 py-2 text-xs",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
})

/**
 * A boxed message in a tone: legacy.css's `.alert` and its three tones, and `.a-ceiling`.
 *
 * A FLEX ROW, as `.alert` is, not the generated grid: every child is an item beside the last.
 * So an icon comes first and the words second, with a title and its description wrapped
 * together in ONE element; a bare message, or a message and a button, go in directly.
 *
 * No `role` of its own, unlike the generated one: each caller says whether its message is an
 * `alert` or a `status`, and some are neither.
 */
function Alert({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      className={cn(alertVariants({ variant, size }), className)}
      {...props}
    />
  )
}

/** `.alert-title`: 14px medium, above the description. */
function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("text-base font-medium", className)}
      {...props}
    />
  )
}

/**
 * `.alert-text`: the message, 2px below a title. The 2px stays on an untitled message too,
 * as /apps draws it; a message meant to sit level with its icon is written without this part.
 */
function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn("mt-0.5", className)}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription }
