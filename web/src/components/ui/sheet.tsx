import { Dialog as SheetPrimitive } from "@base-ui/react/dialog"
import { cva } from "class-variance-authority"
import { cn } from "@/lib/cn"

/**
 * A panel over the page, fixed to an edge of the screen: a Base UI Dialog, so focus is trapped,
 * Escape closes it and the page behind is inert. The app has exactly three, and each `variant`
 * draws one as the legacy sheet drew it, scrim included, so the three differ in more than a
 * width and a call site cannot mix them.
 */

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({ ...props }: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

/** Unstyled: each sheet titles itself inside its own header. */
function SheetTitle({ ...props }: SheetPrimitive.Title.Props) {
  return <SheetPrimitive.Title data-slot="sheet-title" {...props} />
}

/**
 * The three panels. The z-indices are legacy.css's and audit.css's, kept so each still stacks
 * against the page as it did.
 *
 * - `menu`, the phone's navigation drawer (legacy `.menu`): 280px from the right, never past
 *   85% of the screen, sliding in over 220ms. `shadow-pop` rather than the sheet's own
 *   `0 0 40px`, because that is what pass 1 shipped (a note app.css carried from P0 to P5). It exists below the
 *   narrow breakpoint only; above it the bar's own nav is the navigation.
 * - `panel`, a wide inspector beside a page that stays readable (audit's `.audit-drawer`):
 *   `min(620px, 100vw)` from the right with a left rule. At the narrow breakpoint 620px IS
 *   the screen, so it takes all of it and drops the rule and the shadow.
 * - `level`, the phone's full-screen level (audit's `.audit-level`). Its shadow falls outside
 *   the screen and never shows; it is kept because a full-page capture draws it below the
 *   fold and it decides how Chrome antialiases the level's text (as audit.css recorded).
 */
const sheetVariants = cva("fixed flex flex-col bg-background outline-none", {
  variants: {
    variant: {
      menu: "inset-y-0 right-0 z-20 w-70 max-w-[85vw] gap-0.5 p-2 shadow-pop transition-transform duration-220 ease-[ease] data-starting-style:translate-x-full data-ending-style:translate-x-full md:hidden",
      panel:
        "inset-y-0 right-0 z-41 w-[min(620px,100vw)] border-l border-border shadow-record max-md:left-0 max-md:w-screen max-md:border-l-0 max-md:shadow-none",
      level: "inset-0 z-45 shadow-pop",
    },
  },
})

/** Each panel's scrim, one step beneath it: the menu's darker one fades with its slide, the
 *  panel's lighter one leaves the page readable and goes with the panel's edges at the narrow
 *  breakpoint, and a level covers the screen, so it has none. */
const SCRIM = {
  menu: "z-19 bg-scrim-drawer transition-opacity duration-220 ease-[ease] data-starting-style:opacity-0 data-ending-style:opacity-0 md:hidden",
  panel: "z-40 bg-scrim-record max-md:hidden",
  level: null,
} as const

/** The panel, on its scrim, portalled to the end of the document. */
function SheetContent({
  variant,
  container,
  className,
  ...props
}: SheetPrimitive.Popup.Props & {
  /** Which of the app's three panels this is; `sheetVariants` says what each one is. */
  variant: keyof typeof SCRIM
  /** Where the portal mounts; absent, the end of `<body>`. Only the gallery bench passes one,
   *  to draw the sheet open inside a column (`preview/fixtures/primitives/OverlayStage.tsx`). */
  container?: SheetPrimitive.Portal.Props["container"]
}) {
  const scrim = SCRIM[variant]
  return (
    <SheetPrimitive.Portal container={container}>
      {scrim === null ? null : (
        <SheetPrimitive.Backdrop
          data-slot="sheet-overlay"
          className={cn("fixed inset-0", scrim)}
        />
      )}
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        className={cn(sheetVariants({ variant }), className)}
        {...props}
      />
    </SheetPrimitive.Portal>
  )
}

export { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger }
