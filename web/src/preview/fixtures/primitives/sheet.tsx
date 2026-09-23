import type { ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import { Note } from "@/chrome/Text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { BACK, LEVEL_HEAD } from "@/features/audit/parts";
import { Bench } from "./Bench";
import { OverlayStage } from "./OverlayStage";

/**
 * The Sheet bench: `<SheetContent>` in its three variants — the phone drawer, /audit's record
 * panel and its Filters level — each open over its scrim, drawn in-flow by `OverlayStage`. What
 * sits INSIDE each panel is a short stand-in for the caller's markup, in the caller's classes.
 *
 * Each renders already open, which is also why none slides: Base UI gives a popup that is open
 * on its first render no starting frame.
 */

/** A drawer entry, as Shell writes it but ringed by the base `:focus-visible` rule. */
const MENU_LINK =
  "flex h-control-touch items-center justify-between rounded-lg px-3 text-md font-medium text-muted-foreground no-underline aria-[current=page]:bg-muted aria-[current=page]:text-foreground";

/** The phone drawer's own content, in Shell's classes. `focus` marks a nav entry. */
function MenuBody({ focus = false }: { focus?: boolean }): ReactNode {
  return (
    <>
      <div className="mb-1.5 flex h-header items-center justify-between border-b border-row-border pl-3">
        <span className="flex shrink-0 items-center gap-2 text-md font-semibold">
          <span>personal-mcps</span>
        </span>
        <button
          type="button"
          className="inline-flex size-control-touch cursor-pointer items-center justify-center rounded-md bg-transparent p-0 text-foreground"
          aria-label="Close menu"
        >
          ✕
        </button>
      </div>
      <a className={MENU_LINK} href="#apps" aria-current="page">
        Apps
      </a>
      <a className={MENU_LINK} href="#agents" data-focus={focus ? "" : undefined}>
        Agents
      </a>
      <a className={MENU_LINK} href="#audit">
        Audit
      </a>
      <div className="mt-auto flex items-center justify-between gap-2.5 border-t border-row-border px-3 pt-2.5 pb-1">
        <span className="text-base text-muted-foreground">owner</span>
      </div>
    </>
  );
}

/**
 * The drawer at 390, in a 340px stand-in screen so its left edge, shadow and scrim fall 60px
 * into the cell. At 1280 it draws nothing: the drawer does not exist above the narrow
 * breakpoint, and that absence is what is compared.
 */
function Menu({ focus = false }: { focus?: boolean }): ReactNode {
  const viewport = { right: "auto", width: 340 };
  return (
    <Bench>
      <OverlayStage height={360} viewport={viewport}>
        {(container) => (
          // Not modal, and no initial focus: see the dialog bench.
          <Sheet open modal={false}>
            <SheetContent variant="menu" container={container} initialFocus={false}>
              <MenuBody focus={focus} />
            </SheetContent>
          </Sheet>
        )}
      </OverlayStage>
    </Bench>
  );
}

/** The record's head and a line of body, in RecordDrawer's classes. */
function RecordBody(): ReactNode {
  return (
    <>
      <div className={LEVEL_HEAD}>
        <button type="button" className={`${BACK} hidden max-md:inline-flex`}>
          ‹ Audit
        </button>
        <span className="min-w-0 truncate font-mono text-base font-semibold max-md:flex-[0_1_auto] max-md:overflow-visible max-md:whitespace-normal max-md:wrap-anywhere">
          tools/call github.search_issues
        </span>
        <Note render={<span />} className="whitespace-nowrap">
          Sep 23, 14:02:11
        </Note>
        <Button variant="outline" size="sm" className="ml-auto max-md:hidden">
          Close
        </Button>
      </div>
      <div className="flex flex-1 flex-col gap-3.5 overflow-auto px-4 py-3.5 max-md:py-3">
        <Note>Bodies are read on their own, by id — the fields above came with the row.</Note>
      </div>
    </>
  );
}

/**
 * The record at 1280 in a 680px stand-in screen, so its left rule, shadow and 60px of scrim land
 * in the 616px cell (the right-hand Close falls outside). At 390 it is the whole screen from
 * its left edge, with no scrim.
 */
function Record(): ReactNode {
  const viewport = { right: "auto", width: 680 };
  return (
    <Bench>
      <OverlayStage height={320} viewport={viewport}>
        {(container) => (
          <Sheet open modal={false}>
            <SheetContent variant="panel" container={container} initialFocus={false}>
              <RecordBody />
            </SheetContent>
          </Sheet>
        )}
      </OverlayStage>
    </Bench>
  );
}

/** The Filters level's frame, in AuditPage's classes. */
function LevelBody(): ReactNode {
  return (
    <>
      <div className={LEVEL_HEAD}>
        <button type="button" className={`${BACK} inline-flex`}>
          ‹ Audit
        </button>
        <b className="text-base">Filters</b>
        <Badge>2 on</Badge>
        <Button variant="outline" size="sm" className="ml-auto">
          Clear
        </Button>
      </div>
      <div className="flex-1 overflow-auto px-2 pt-2 pb-3">
        <Note>The rail's groups.</Note>
      </div>
      <div className="sticky bottom-0 flex border-t bg-background px-4 py-3">
        <Button className="h-control-touch flex-1">Show 1,204 events</Button>
      </div>
    </>
  );
}

/** The level in a stand-in screen inset 16px, so the shadow it casts past the screen's edge
 *  shows inside the cell. */
function Level(): ReactNode {
  const viewport = { inset: 16 };
  return (
    <Bench>
      <OverlayStage height={320} viewport={viewport}>
        {(container) => (
          <Sheet open modal={false}>
            <SheetContent variant="level" container={container} initialFocus={false}>
              <LevelBody />
            </SheetContent>
          </Sheet>
        )}
      </OverlayStage>
    </Bench>
  );
}

export const sheetStates: Record<string, PrimitiveState> = {
  "sheet-menu": () => <Menu />,
  "sheet-menu-focus": () => <Menu focus />,
  "sheet-panel": () => <Record />,
  "sheet-level": () => <Level />,
};
