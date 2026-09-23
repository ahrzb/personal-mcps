import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/cn"

import { Input } from "@/components/ui/input"

/**
 * A field with things inside its box: /audit's search, `.a-search`. The box holds an icon,
 * a borderless input, and optionally a "Searching…" note. It has a 1px border and an 8px
 * radius, with no shadow and no ground of its own. Its parts sit 6px apart, 10px in from
 * each side.
 *
 * Focus draws NOTHING, as today: `.a-search input` removes the input's outline and shadow,
 * and the box has no focus style. A `focus-within` ring would be an accessibility fix, and a
 * look change for the owner to accept.
 *
 * `size`, as Input's:
 * - `default` is 36px, and 44px at the narrow breakpoint.
 * - `sm` is 32px at every width. It is the search's own size. The filter bar grows it to 44px
 *   at the narrow breakpoint at its call site (`max-md:h-control-touch`), because the record
 *   drawer's copy stays 32.
 */
const inputGroupVariants = cva(
  "flex items-center gap-1.5 rounded-md border border-input px-2.5",
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

function InputGroup({
  className,
  size,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupVariants>) {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn(inputGroupVariants({ size }), className)}
      {...props}
    />
  )
}

/**
 * Something beside the input: an icon, or a note such as "Searching…", which never wraps and
 * never squeezes the input. It sets no colour, so an icon draws in the text colour and a note
 * brings its own. A click on it focuses the input, unless the click was on a button.
 */
function InputGroupAddon({ className, onClick, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group-addon"
      className={cn("flex shrink-0 items-center whitespace-nowrap", className)}
      onClick={(event) => {
        onClick?.(event)
        if ((event.target as HTMLElement).closest("button")) return
        event.currentTarget.parentElement?.querySelector("input")?.focus()
      }}
      {...props}
    />
  )
}

/**
 * The group's input: `.a-search input`. It is Input with its box removed (no border, ground,
 * shadow, padding or height), with 13px text at every width and the line height it inherits,
 * and it takes the room its addons leave.
 */
function InputGroupInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <Input
      data-slot="input-group-control"
      className={cn(
        "h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-sm leading-[inherit] shadow-none max-md:h-auto",
        className
      )}
      {...props}
    />
  )
}

export { InputGroup, InputGroupAddon, InputGroupInput }
