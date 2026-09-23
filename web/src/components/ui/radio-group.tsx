import type { ReactNode } from "react"
import { Radio as RadioPrimitive } from "@base-ui/react/radio"
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/cn"

/**
 * One choice out of a few: a Base UI radio group. It is a `div role="radiogroup"` whose radios
 * are `<span role="radio">`s, each beside a hidden input that the form submits under the
 * group's `name`. Arrow keys move the choice, and exactly one is checked.
 *
 * `variant` is the group's layout, and says which item goes inside it:
 * - `card` is `.choice-list`: `RadioGroupCard`s stacked 8px apart.
 * - `segment` is `.seg`: `RadioGroupSegment`s joined into one bar.
 *
 * The group draws nothing else.
 */
const radioGroupVariants = cva("", {
  variants: {
    variant: {
      card: "flex flex-col gap-2",
      segment: "inline-flex shrink-0",
    },
  },
  defaultVariants: { variant: "card" },
})

function RadioGroup({
  className,
  variant,
  ...props
}: RadioGroupPrimitive.Props & VariantProps<typeof radioGroupVariants>) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn(radioGroupVariants({ variant }), className)}
      {...props}
    />
  )
}

/**
 * The radio circle, 16px. It draws what Chrome drew for `.choice`'s native radio in the
 * primary accent, pixel for pixel:
 * - unchecked, a 1px #767676 ring on white;
 * - checked, an accent ring around an accent dot, with 20% of the width clear between them.
 *
 * The circle sits on an inner span, so the focus ring can stay square, as the native radio's
 * was (its CSS radius was 0). Its only consumer is never disabled, so disabled has no look.
 */
function RadioGroupItem({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        "group/radio relative inline-flex size-4 shrink-0 outline-none focus-visible:ring-3 focus-visible:ring-ring/35",
        className
      )}
      {...props}
    >
      <span className="absolute inset-0 rounded-full border border-[#767676] bg-background group-data-checked/radio:border-primary" />
      {/* An SVG circle, not a rounded box: Chrome's dot is 9.6px (the width less 20% a
          side), and a box background would be snapped to whole pixels. */}
      <RadioPrimitive.Indicator
        data-slot="radio-group-indicator"
        render={<svg viewBox="0 0 16 16" />}
        className="absolute inset-0 fill-primary"
      >
        <circle cx="8" cy="8" r="4.8" />
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  )
}

/**
 * A choice drawn as a card: `.choice`. It holds a radio, a 14px/500 title and a 13px muted
 * description, and draws a primary border when chosen. The whole card is the radio's
 * `<label>`, so a click anywhere on it chooses.
 */
function RadioGroupCard({
  className,
  title,
  description,
  ...props
}: RadioPrimitive.Root.Props & { title: ReactNode; description: ReactNode }) {
  return (
    <label
      data-slot="radio-group-card"
      className={cn(
        "flex cursor-pointer items-start gap-2.5 rounded-md border bg-background px-3.5 py-3 has-data-checked:border-primary",
        className
      )}
    >
      <RadioGroupItem className="mt-px" {...props} />
      <div>
        <div className="text-base font-medium">{title}</div>
        <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>
      </div>
    </label>
  )
}

/**
 * A choice drawn as one segment of a joined bar: `.seg-opt`, the three-way none / ask / allow
 * of a grant row. It is 44×24 with 11px text. The bar's ends are rounded and its inner
 * borders are shared.
 * - Checked is solid primary, or solid `--warning` with `tone="warning"`.
 * - `implied` is hollow, a 2px primary ring, or a warning-coloured one with
 *   `tone="warning"`. It marks the level another entry already grants, so "this is granted"
 *   and "this row grants it" stay two statements.
 * - Disabled is sunken and dim.
 * - Focus draws today's ring, which replaces the implied ring rather than adding to it.
 *
 * The ends are found by type (`first-of-type`) because each radio's hidden input sits beside
 * it, so the last CHILD of the bar is an input.
 */
const segmentVariants = cva(
  "inline-flex h-control-xs w-11 cursor-pointer items-center justify-center border border-border bg-background text-2xs font-medium text-muted-foreground outline-none first-of-type:rounded-l-sm last-of-type:rounded-r-sm not-first-of-type:border-l-0 focus-visible:shadow-none focus-visible:ring-3 focus-visible:ring-ring/35 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground data-disabled:cursor-default data-disabled:bg-sunken data-disabled:text-dim-fg",
  {
    variants: {
      tone: {
        default: "",
        warning: "data-checked:border-warning data-checked:bg-warning",
      },
      implied: {
        false: "",
        true: "",
      },
    },
    compoundVariants: [
      { implied: true, tone: "default", className: "border-primary text-foreground shadow-[inset_0_0_0_1px_var(--color-primary)]" },
      { implied: true, tone: "warning", className: "border-warning text-warning shadow-[inset_0_0_0_1px_var(--color-warning)]" },
    ],
    defaultVariants: { tone: "default", implied: false },
  }
)

function RadioGroupSegment({
  className,
  tone,
  implied,
  ...props
}: RadioPrimitive.Root.Props & VariantProps<typeof segmentVariants>) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-segment"
      className={cn(segmentVariants({ tone, implied }), className)}
      {...props}
    />
  )
}

export { RadioGroup, RadioGroupCard, RadioGroupItem, RadioGroupSegment }
