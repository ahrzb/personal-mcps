import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/cn"

/**
 * The classes of a `.btn`, for any element: `<Button>` below, and the `<a>`/`<Link>` sites that
 * take `buttonVariants()` as their className.
 *
 * It draws legacy.css's `.btn` family exactly (pass 2 changes the library, not the look), so each
 * variant and size names the legacy class it replaces. No two classes of one call name the same
 * property, so the string is right without a merge. The link sites rely on that, because they
 * take it as it is, with no `cn`.
 */
const buttonVariants = cva(
  // `no-underline`: an <a> with these classes would otherwise take the base link underline.
  // The focus ring is restated here rather than left to app.css's base `:focus-visible`, because
  // any `shadow-*` utility below (outline's resting shadow, mini's `none`) outranks that base
  // rule. The ring replaces the resting shadow, as the base rule's does, and keeps the variant's
  // border.
  "group/button inline-flex items-center justify-center gap-1.5 rounded-md border font-medium leading-none whitespace-nowrap no-underline cursor-pointer outline-none focus-visible:shadow-none focus-visible:ring-3 focus-visible:ring-ring/35 disabled:cursor-default disabled:opacity-50 aria-disabled:cursor-default aria-disabled:opacity-50",
  {
    variants: {
      variant: {
        /** `.btn--primary` */
        default: "border-primary bg-primary text-primary-foreground",
        /** `.btn--outline` */
        outline: "border-border bg-background text-foreground",
        /** `.btn--ghost`, and a bare `.btn`, which differs only in having no hover fill */
        ghost: "border-transparent bg-transparent text-foreground hover:bg-muted",
        /** `.btn--danger`: a confirm dialog's destructive action */
        danger: "border-destructive bg-destructive text-destructive-foreground",
        /** `.btn--danger-outline`: a row-level Delete */
        "danger-outline": "border-danger-border bg-background text-destructive",
        /** `.btn--danger-ghost` */
        "danger-ghost": "border-transparent bg-transparent text-destructive hover:bg-danger-bg",
      },
      size: {
        /** `.btn`: 36px, 44px on a phone */
        default: "h-control px-4 text-base max-md:h-control-touch",
        /** `.btn--sm`: 32px and 13px text, the default's 44px and 14px on a phone */
        sm: "h-control-sm px-3 text-sm max-md:h-control-touch max-md:text-base",
        /** `.btn--sm.btn--mini`: 24px in a dense row (/audit's strip), the same on a phone,
         *  with no resting shadow in any variant */
        xs: "h-control-xs px-2 text-2xs shadow-none",
        /** `.table .cell-actions .btn`: a row's control in a table's actions cell, `sm` at
         *  10px sides and 4px apart; on a phone an equal 44px share of the row's own action
         *  line. */
        cell: "ml-1 h-control-sm px-2.5 text-sm max-md:ml-0 max-md:h-control-touch max-md:flex-1 max-md:px-3 max-md:text-base",
      },
    },
    compoundVariants: [
      // `.btn--outline`'s resting shadow, which `.btn--mini` removed.
      { variant: "outline", size: ["default", "sm", "cell"], class: "shadow-xs" },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/** A `<button>` drawn as `.btn`. The variant and size say which one, and a className is merged in after them. */
function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
