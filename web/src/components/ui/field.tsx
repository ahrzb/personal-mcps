import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/cn"

/**
 * The form's layout, in legacy.css's terms:
 * - `FieldGroup` is `.form`.
 * - `Field` is `.field`, or `.checkbox` when it is horizontal.
 * - `FieldDescription` is `.field-hint`.
 * - `FieldError` is `.field-error`.
 *
 * A control's name is `Label` (`label.tsx`). Each part renders a `div` by default and takes
 * `render` for the element the page needs. The usual cases:
 * - `<FieldGroup render={<form />}>` for the form itself.
 * - `<Field render={<label />}>` where the whole field is the control's label, with its
 *   children rendered as `<span>`s, since a `<label>` holds only phrasing content.
 */

/** A column of fields 16px apart: `.form`. */
function FieldGroup({ className, render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">({ className: cn("flex flex-col gap-4", className) }, props),
    render,
    state: { slot: "field-group" },
  })
}

/**
 * One field's parts, stacked.
 * - `vertical` is `.field`: the name, the control and the hint, 6px apart.
 * - `horizontal` is `.checkbox`: a box and its sentence on one line, 10px apart, at body
 *   size and weight.
 */
const fieldVariants = cva("flex", {
  variants: {
    orientation: {
      vertical: "flex-col gap-1.5",
      horizontal: "items-center gap-2.5 text-base",
    },
  },
  defaultVariants: { orientation: "vertical" },
})

function Field({
  className,
  orientation,
  render,
  ...props
}: useRender.ComponentProps<"div"> & VariantProps<typeof fieldVariants>) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">({ className: cn(fieldVariants({ orientation }), className) }, props),
    render,
    state: { slot: "field", orientation: orientation ?? "vertical" },
  })
}

/** A field's standing hint, 13px and muted: `.field-hint`. */
function FieldDescription({ className, render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">({ className: cn("text-sm text-muted-foreground", className) }, props),
    render,
    state: { slot: "field-description" },
  })
}

/**
 * The refusal that names this field, 13px and red: `.field-error`. It carries no `role`, as
 * today's does not. The page decides whether a refusal is announced.
 */
function FieldError({ className, render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">({ className: cn("text-sm text-destructive", className) }, props),
    render,
    state: { slot: "field-error" },
  })
}

export { Field, FieldDescription, FieldError, FieldGroup }
