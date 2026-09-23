import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/cn"

const emptyVariants = cva(
  "group/empty flex flex-col items-center rounded-lg bg-background text-center",
  {
    variants: {
      variant: {
        /** Its own card: legacy.css's `.empty`. */
        default: "border px-6 py-7 shadow-xs",
        /** `.empty--inline`: inside a card that is already the box, so no border, no side
         *  padding, and the lines spaced by the stack rather than hung off the title. */
        inline: "gap-2 px-0 py-3",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

/**
 * What a list says when it lists nothing: a centred title and a line of explanation. A button
 * under them is the caller's, with its own `mt-4`.
 */
function Empty({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof emptyVariants>) {
  return (
    <div
      data-slot="empty"
      data-variant={variant}
      className={cn(emptyVariants({ variant }), className)}
      {...props}
    />
  )
}

/** `.empty-title`: 15px semibold. */
function EmptyTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-title"
      className={cn("text-md leading-[1.4] font-semibold", className)}
      {...props}
    />
  )
}

/** `.empty-text`: muted, at most 46 characters a line (460px, and no top margin, inline). */
function EmptyDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-description"
      className={cn(
        "mt-1.5 max-w-[46ch] text-sm leading-5 text-muted-foreground group-data-[variant=inline]/empty:mt-0 group-data-[variant=inline]/empty:max-w-[460px]",
        className
      )}
      {...props}
    />
  )
}

export { Empty, EmptyTitle, EmptyDescription }
