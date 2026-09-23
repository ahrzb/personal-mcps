"use client"

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/cn"
import { CheckIcon, MinusIcon } from "lucide-react"

/**
 * The tick square, legacy.css's `.cb`: 14px, a 1.5px `--ring` border, a 3px radius. It is
 * shared by two components because a row draws either a CONTROL or a STATEMENT, and both must
 * sit on the same square.
 * - `Checkbox` is the control, where the owner may change it.
 * - `Tick` is the statement, where a pattern or the app already decided.
 *
 * `state` is what the square says:
 * - `off`: not in.
 * - `on`: in (the primary fill).
 * - `lock`: in, but decided elsewhere and not clearable here. It is grey, so "in" and "in,
 *   and yours to change" stay two statements.
 * - `mixed`: in on some of a path's tools (the primary fill, with a dash).
 *
 * `before:` is the ladder's 24px target, drawn AROUND the square by an overflowing
 * pseudo-element, since growing the box would push a dense row open.
 */
const tickVariants = cva(
  "relative inline-flex size-3.5 shrink-0 cursor-pointer appearance-none items-center justify-center rounded-xs border-[1.5px] border-ring bg-background p-0 text-primary-foreground outline-none before:absolute before:-inset-[5px] focus-visible:ring-3 focus-visible:ring-ring/35 disabled:cursor-default",
  {
    variants: {
      state: {
        off: "",
        on: "border-primary bg-primary",
        lock: "cursor-default border-ring bg-ring",
        mixed: "cursor-default border-primary bg-primary",
      },
    },
    defaultVariants: { state: "off" },
  }
)

/** The glyph a statement draws, 10px at stroke 3. `off` draws none. */
const GLYPH = {
  off: null,
  on: <CheckIcon size={10} strokeWidth={3} aria-hidden="true" />,
  lock: <CheckIcon size={10} strokeWidth={3} aria-hidden="true" />,
  mixed: <MinusIcon size={10} strokeWidth={3} aria-hidden="true" />,
} as const

/**
 * The static square: a `<span>` by default. `render={<button type="button" />}` gives a
 * ticked control that is not a checkbox, such as a role editor's pattern, which clicking
 * removes. It draws its state's glyph unless it is given children.
 */
function Tick({
  className,
  state,
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof tickVariants>) {
  const shown = state ?? "off"
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      { className: cn(tickVariants({ state: shown }), className), children: GLYPH[shown] },
      props
    ),
    render,
    state: { slot: "tick", state: shown },
  })
}

/**
 * The control: a Base UI checkbox, which is a `<span role="checkbox">` beside a hidden input
 * that the form submits. It comes in two looks, and each is what today's page draws there.
 *
 * `variant="default"` is a form's box: /settings' `.checkbox input`, 16px, which Chrome drew
 * natively in the primary accent.
 * - It draws what Chrome drew, pixel for pixel, as an inner SVG in Chrome's own geometry: a
 *   1px #767676 frame at a 2px radius, and when checked the accent fill with Chrome's tick
 *   path in white.
 * - The drawing sits inside the root, so the focus ring can stay square, as the native box's
 *   was (its CSS radius was 0).
 * - Its only consumer is checked or unchecked, never disabled, so disabled has no look.
 *
 * `variant="tick"` is `.cb`, the tick square of a dense listing row. Checked draws the primary
 * fill and today's tick.
 * - The tick is a rotated border, not a path, because that is what a checked `input.cb`
 *   draws, and a statement's SVG tick beside it would not match.
 * - `lock` is the grey `lock` square, for a box that is checked, disabled and decided
 *   elsewhere. It is a prop and not derived from disabled + checked, because a checked box
 *   can also be disabled for another reason (a path whose per-tool rows are its control), and
 *   that box stays black.
 * - The margin, 3px with 4px on the left, is Chrome's user-agent margin for a checkbox.
 *   `.cb` never reset it, so every `input.cb` sits that far off a statement square in the
 *   next row. Keeping it is what leaves every row where it is today. Dropping it is a look
 *   change, and P4's preflight would drop it silently from any input that still carried it.
 *
 * `indeterminate` has no look in either variant, because no page draws a mixed CONTROL
 * today: mixed is a `Tick`.
 */
function Checkbox({
  className,
  variant = "default",
  lock = false,
  ...props
}: CheckboxPrimitive.Root.Props & { variant?: "default" | "tick"; lock?: boolean }) {
  if (variant === "tick")
    return (
      <CheckboxPrimitive.Root
        data-slot="checkbox"
        className={cn(
          tickVariants({ state: lock ? "lock" : "off" }),
          !lock && "data-checked:border-primary data-checked:bg-primary",
          "m-[3px] ml-1 data-disabled:cursor-default",
          className
        )}
        {...props}
      >
        <CheckboxPrimitive.Indicator
          data-slot="checkbox-indicator"
          className="-mt-0.5 box-content h-2 w-1 rotate-45 border-r-2 border-b-2 border-primary-foreground"
        />
      </CheckboxPrimitive.Root>
    )
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "group/checkbox relative inline-flex size-4 shrink-0 outline-none focus-visible:ring-3 focus-visible:ring-ring/35",
        className
      )}
      {...props}
    >
      {/* Chrome's geometry: a 1px frame stroked on a rect inset by half a pixel, or the
          accent filled over the whole box. A CSS border draws the 2px corners differently. */}
      <svg viewBox="0 0 16 16" className="absolute inset-0" aria-hidden="true">
        <rect x="0.5" y="0.5" width="15" height="15" rx="2" className="fill-background stroke-[#767676] group-data-checked/checkbox:hidden" />
        <rect width="16" height="16" rx="2" className="hidden fill-primary group-data-checked/checkbox:block" />
      </svg>
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        render={<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.56} />}
        className="absolute inset-0 text-background"
      >
        <path d="M3.2 8l3.2 3.2L12.8 3.2" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox, Tick }
