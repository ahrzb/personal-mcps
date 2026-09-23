import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/cn"

/**
 * The text field every form draws: legacy.css's typed-`input` rule as a component, the same
 * box pixel for pixel. Use it for every `type` that rule named (text, password, search, email,
 * url, number, date) and for a field written with no `type` at all, which that rule never
 * reached and which rendered as the browser's own grey field.
 *
 * Focus draws NativeSelect's ring: a `--ring` border and a 3px ring at 35%, replacing the
 * resting shadow. It is restated here because `border-input` and `shadow-xs` outrank app.css's
 * base `:focus-visible`. A text field matches `:focus-visible` however it was focused, so a
 * click or `autoFocus` shows it too.
 *
 * `aria-invalid="true"` is the invalid state: a red border and no shadow. Focused, it keeps
 * the red border and draws the ring.
 *
 * Disabled is dimmed to 50%, as Button and NativeSelect are.
 *
 * A mono field, one that holds an identifier or a code, says `font-mono` at its call site.
 *
 * `size`:
 * - `default` is 36px, and 44px at the narrow breakpoint (the touch target).
 * - `sm` is 32px at EVERY width. That is what today's two small controls do
 *   (`input.role-name`, `.gh-form select`), because each one's own rule outranks the narrow
 *   breakpoint's growth.
 *
 * It replaces the native `size` attribute, a width in characters, which nothing here uses.
 * The one-time-code box is sizing classes at its call site (`OtpBoxes`).
 */
const inputVariants = cva(
  "w-full rounded-md border border-input bg-background px-3 text-base text-foreground shadow-xs outline-none placeholder:text-ring focus-visible:border-ring focus-visible:shadow-none focus-visible:ring-3 focus-visible:ring-ring/35 disabled:cursor-default disabled:opacity-50 aria-invalid:border-destructive aria-invalid:shadow-none",
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

function Input({
  className,
  type,
  size,
  ...props
}: Omit<React.ComponentProps<"input">, "size"> & VariantProps<typeof inputVariants>) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(inputVariants({ size }), className)}
      {...props}
    />
  )
}

export { Input }
