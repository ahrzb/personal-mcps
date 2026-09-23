"use client"

import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { cn } from "@/lib/cn"

/**
 * An on/off control drawn as a pill: legacy.css's `.sw`, the Recording pane's "record call
 * bodies". It is a Base UI switch, a `<span role="switch">` beside a hidden input that the
 * form submits.
 *
 * - The track is 36×20, `--border` grey when off and primary when on.
 * - The 16px thumb slides 16px in 0.15s.
 * - Focus draws today's 3px ring.
 * - Disabled has no look of its own, as `.sw` has none.
 *
 * The margin, 3px with 4px on the left, is Chrome's user-agent margin for the checkbox
 * `.sw` was drawn on. `.sw` never reset it, so keeping it leaves the switch where it sits
 * today.
 *
 * Its visible label is the caller's: `<Label>` wrapping the text and the switch, since a
 * colour alone is a state only a sighted reader has.
 */
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "relative m-[3px] ml-1 inline-block h-5 w-9 shrink-0 cursor-pointer rounded-full bg-border outline-none focus-visible:ring-3 focus-visible:ring-ring/35 data-checked:bg-primary",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="absolute top-0.5 left-0.5 size-4 rounded-full bg-background shadow-thumb transition-[left] duration-150 ease-[ease] data-checked:left-4.5"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
