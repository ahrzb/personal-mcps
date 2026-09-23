import type { ComponentProps } from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/cn"

/**
 * The classes of a `.badge`: a tone (the variant) and a shape (the size).
 *
 * It draws legacy.css's badges exactly, so each variant and size names the class it replaces.
 * The shape lives entirely in the size, not in the base, because `count` is a shape of its own
 * (`.nav-badge`, which was never a `.badge`). So no two classes of one call name the same
 * property, and `badgeVariants()` is right without a merge.
 *
 * `.badge--dashed` is a className, `border-dashed`.
 */
const badgeVariants = cva("group/badge inline-flex items-center", {
  variants: {
    variant: {
      /** a bare `.badge`: a count or a quantity on /audit */
      default: "border-transparent bg-muted text-primary",
      /** `.badge--outline`: "current" */
      outline: "border-border bg-background text-foreground",
      /** `.badge--muted`: "offline", "revoked", "expired" */
      muted: "border-transparent bg-muted text-muted-foreground",
      /** `.badge--success`: "online", "connected", "executed" */
      success: "border-success-border bg-success-bg text-success",
      /** `.badge--warning`: "pending", "archived", "needs reconnect" */
      warning: "border-warning-border bg-warning-bg text-warning",
      /** `.badge--danger`: "denied", "rejected" */
      danger: "border-danger-border bg-danger-bg text-danger-fg",
      /** `.badge--mono`: an app's kind or slug */
      mono: "border-transparent bg-muted font-mono text-muted-foreground",
      /** `.nav-badge`'s red. It is drawn with `size="count"`. */
      count: "bg-destructive text-destructive-foreground",
    },
    size: {
      /** `.badge`: 20px, 11px text */
      default: "h-badge gap-1.5 rounded-sm border px-2 text-2xs font-medium whitespace-nowrap",
      /** `.badge--title`: 22px and 12px text, beside a 24px page title */
      title: "h-badge-title gap-1.5 rounded-sm border px-2 text-xs font-medium whitespace-nowrap",
      /** `.badge--xs`: 16px and 10px text, inside a row's first line */
      xs: "h-badge-xs gap-1.5 rounded-sm border px-1.5 text-badge-xs font-medium whitespace-nowrap",
      /** `.cr-detail .badge`: the default shape, but it wraps inside a row's detail line, at 20px
       *  or taller. A declared pattern is one unbreakable 300-character token. */
      wrap: "min-h-badge max-w-full gap-1.5 rounded-sm border px-2 text-2xs font-medium wrap-anywhere",
      /** `.nav-badge`: an 18px round count beside Approvals, with no border */
      count: "h-nav-badge min-w-nav-badge justify-center rounded-full px-[5px] text-2xs font-semibold",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
})

/** A `<span>` drawn as `.badge`, or the element `render` names. */
function Badge({
  className,
  variant = "default",
  size = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant, size }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

/**
 * `.dot`: the 6px status dot a badge starts with, in the badge's text colour ("online").
 * `idle` draws it hollow, as `.dot--idle` does ("offline").
 */
function BadgeDot({ idle = false, className, ...props }: ComponentProps<"span"> & { idle?: boolean }) {
  return (
    <span
      data-slot="badge-dot"
      className={cn(
        "size-1.5 shrink-0 rounded-full bg-current",
        idle && "border-[1.5px] border-ring bg-transparent",
        className
      )}
      {...props}
    />
  )
}

/**
 * `.badge-x`: the × inside a badge that drops the entry the badge names. The caller supplies the
 * glyph and the click. The glyph is 14px, because a 20px badge has no room for more. Its 24px
 * target is an overflowing `::after` rather than the box, which would push the badge open.
 */
function BadgeRemove({ className, type = "button", ...props }: ComponentProps<"button">) {
  return (
    <button
      data-slot="badge-remove"
      type={type}
      className={cn(
        "relative ml-0.5 inline-flex size-3.5 cursor-pointer items-center justify-center rounded-xs bg-transparent p-0 text-xs text-inherit after:absolute after:-inset-[5px] hover:bg-border hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export { Badge, BadgeDot, BadgeRemove, badgeVariants }
