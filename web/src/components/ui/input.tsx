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
 * Deliberately NO focus ring, because today's field has none. legacy.css's `:focus-visible`
 * ring loses to its own `input[type=…]` rule on specificity, so a focused field looks exactly
 * like a resting one apart from its caret. Adding a ring is a look change for the owner to
 * accept, not something a conversion slips in.
 *
 * `aria-invalid="true"` is the invalid state: a red border and no shadow.
 *
 * `size`:
 * - `default` is 36px, and 44px at the narrow breakpoint (the touch target).
 * - `sm` is 32px at EVERY width. That is what today's two small controls do
 *   (`input.role-name`, `.gh-form select`), because each one's own rule outranks the narrow
 *   breakpoint's growth.
 *
 * It replaces the native `size` attribute, a width in characters, which nothing here uses.
 * The one-time-code box is sizing classes at its call site (`OtpBoxes`).
 *
 * `.input--mono` has NO counterpart. It never applied: `input[type=…]` sets
 * `font-family: inherit` and outranks it, so every field that carries it draws in sans. A mono
 * field is a look change. `input.role-name` is the exception: it is mono, because its own rule
 * outranks the typed rule, so its call site says `font-mono`.
 */
// `font-[family-name:inherit]` rather than `font-[inherit]`: cn reads the bare form as a
// WEIGHT, so a caller's `font-semibold` would delete it and the field would fall back to the
// browser's own font.
const inputVariants = cva(
  "w-full rounded-md border border-input bg-background px-3 font-[family-name:inherit] text-base text-foreground shadow-xs outline-none placeholder:text-ring aria-invalid:border-destructive aria-invalid:shadow-none",
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
