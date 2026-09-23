import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { cn } from "@/lib/cn"

/**
 * The confirm dialog: a titled question, one line of consequence, and the caller's actions,
 * centred over the whole page on a scrim. It draws what Confirm's native `<dialog>` drew with
 * legacy.css's `dialog` rules, the UA's `dialog:modal` centring included, so a page moved onto
 * it looks the same. There is no ✕: every confirmation already carries a Cancel.
 */

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

/** The scrim: today's `dialog::backdrop`, with no blur and no fade, because the native one had
 *  neither. */
function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn("fixed inset-0 z-50 bg-scrim-dialog", className)}
      {...props}
    />
  )
}

/**
 * The box, on its scrim, portalled to the end of the document.
 *
 * Centred as the UA centres a modal `<dialog>` (`inset: 0; margin: auto; height:
 * fit-content`), not by `translate(-50%)`: a translate lands an odd-sized box on a half pixel and
 * blurs its text, where auto margins resolve to whole ones exactly as the native box did. It
 * appears at once; the native dialog never animated, and a zoom-in would also be caught
 * mid-frame by a screenshot.
 */
function DialogContent({
  className,
  children,
  container,
  ...props
}: DialogPrimitive.Popup.Props & {
  /** Where the portal mounts; absent, the end of `<body>`. Only the gallery bench passes one,
   *  to draw the dialog open inside a column (`preview/fixtures/primitives/OverlayStage.tsx`). */
  container?: DialogPrimitive.Portal.Props["container"]
}) {
  return (
    <DialogPortal container={container}>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          // `max-h-…` and `overflow-auto` are the UA's own `dialog:modal` values, kept so a
          // box too tall for the screen scrolls inside itself as the native one did.
          "fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100%-6px-2em)] w-auth max-w-[calc(100vw-40px)] flex-col gap-4 overflow-auto rounded-lg border border-border bg-background p-6 text-foreground shadow-pop outline-none",
          className
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

/** The actions' row: right-aligned at every width, and at the narrow breakpoint each action
 *  takes an equal share of it, side by side rather than stacked. */
function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-wrap items-center justify-end gap-2 max-md:*:flex-1",
        className
      )}
      {...props}
    />
  )
}

/** An `<h2>` at the card-title size, which keeps the line height of the text around it: the
 *  legacy sheet's `h2 { line-height: 1.2 }` would otherwise make it about 6px shorter than the div
 *  the native dialog titled itself with. */
function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-[inherit] font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm leading-normal text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
