import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/cn"

/**
 * A `<select>` drawn as today's field. It is Input's box: the same height, padding, border,
 * radius, shadow and text. The platform keeps its own picker, so the phone still gets its
 * wheel, and the consent page still posts the plain form field it posts today. This is why
 * the popup Select was not used (pass 2 brief, ruling 1.5).
 *
 * The browser draws the arrow, exactly as it does today: the element keeps its native
 * appearance, with no drawn chevron. Options are plain `<option>`s.
 *
 * - Focus draws today's ring: a `--ring` border and a 3px ring at 35%. It REPLACES the
 *   resting shadow and does not add to it.
 * - `aria-invalid="true"` draws a red border and no shadow. Focused, it keeps the red border
 *   and draws the ring, as Input does, so an invalid field still shows where focus is.
 * - Disabled is dimmed to 50%, as Button is. Preflight leaves a disabled control undimmed.
 * - `size`, as Input's: `default` is 36px and 44px at the narrow breakpoint; `sm` is 32px at
 *   every width. `sm` is `.gh-form select`, whose call site also says `w-auto`.
 */
const nativeSelectVariants = cva(
  "w-full cursor-pointer rounded-md border border-input bg-background px-3 text-base text-foreground shadow-xs focus-visible:border-ring focus-visible:shadow-none focus-visible:ring-3 focus-visible:ring-ring/35 focus-visible:outline-none disabled:cursor-default disabled:opacity-50 aria-invalid:border-destructive aria-invalid:shadow-none",
  {
    variants: {
      size: {
        default: "h-control max-md:h-control-touch",
        sm: "h-control-sm",
      },
    },
    defaultVariants: { size: "default" },
  }
)

function NativeSelect({
  className,
  size,
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & VariantProps<typeof nativeSelectVariants>) {
  return (
    <select
      data-slot="native-select"
      className={cn(nativeSelectVariants({ size }), className)}
      {...props}
    />
  )
}

export { NativeSelect }
