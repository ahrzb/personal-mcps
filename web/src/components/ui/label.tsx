import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cn } from "@/lib/cn"

/**
 * A control's name, 14px at weight 500. This is legacy.css's `.label` and `.field > label`.
 *
 * It renders a `<label>`. Pass `render={<span />}` where a wrapping `<Field render={<label />}>`
 * already is the label, or `render={<div />}` where the name heads a group of controls rather
 * than one. The line height is inherited, as today's is.
 */
function Label({ className, render, ...props }: useRender.ComponentProps<"label">) {
  return useRender({
    defaultTagName: "label",
    props: mergeProps<"label">({ className: cn("text-base font-medium", className) }, props),
    render,
    state: { slot: "label" },
  })
}

export { Label }
