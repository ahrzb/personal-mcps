import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The rows a card's controls sit in. A confirm DIALOG's are not here: they are `DialogFooter`
 * (`components/ui/dialog`), which is side by side at every width.
 */

/**
 * `.actions`: a row of controls 12px apart, wrapping when it runs out of room, aligned to the
 * end. `start` aligns it to the start (`.actions--start`). `grow` gives every child an equal
 * share of the row below 768px (the narrow `.actions .btn { flex: 1 }`); leave it off where
 * the row holds something that must not grow, and put `max-md:flex-1` on each control that
 * should.
 */
export function Actions({
  start = false,
  grow = false,
  className,
  ...props
}: ComponentProps<"div"> & { start?: boolean; grow?: boolean }): ReactNode {
  return (
    <div
      data-slot="actions"
      className={cn("flex flex-wrap items-center gap-3", !start && "justify-end", grow && "max-md:*:flex-1", className)}
      {...props}
    />
  );
}

/**
 * An actions row's phone form: its controls stacked full width, 10px apart, drawn below 768px
 * only. The row it stands in for carries `max-md:hidden`, so exactly one of the two shows.
 */
export function NarrowActions({ className, ...props }: ComponentProps<"div">): ReactNode {
  return <div data-slot="narrow-actions" className={cn("hidden flex-col gap-2.5 max-md:flex", className)} {...props} />;
}

/**
 * `.confirm-actions`: the refusal and the acceptance of a decision card (consent's Deny and
 * Allow, a device's Deny and Approve), side by side, each growing from its own width so a
 * longer label keeps its room. On a phone they stack, the acceptance on top.
 */
export function ConfirmActions({ className, ...props }: ComponentProps<"div">): ReactNode {
  return (
    <div
      data-slot="confirm-actions"
      className={cn("flex gap-3 *:flex-auto max-md:flex-col-reverse max-md:gap-2.5", className)}
      {...props}
    />
  );
}
