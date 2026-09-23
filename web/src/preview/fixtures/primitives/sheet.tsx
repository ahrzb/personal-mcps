import type { ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Columns } from "./Columns";
import { OverlayStage } from "./OverlayStage";

/**
 * The Sheet bench: the phone drawer `.menu`, /audit's record `.audit-drawer` and its Filters
 * `.audit-level`, each open over its scrim beside `<SheetContent>` in that variant, drawn in-flow
 * by `OverlayStage`. What sits INSIDE each panel is the caller's markup, the same on both sides,
 * so only the panel, its scrim and its motion's resting frame are compared.
 *
 * Each side renders already open, which is also why neither slides: an element that mounts open
 * starts there (legacy: `data-open` is present at the first style; Base UI: no starting frame
 * for a popup that is open on its first render).
 */

/** The phone drawer's own content, as Shell writes it. `focus` marks a nav entry. */
function MenuBody({ focus = false }: { focus?: boolean }): ReactNode {
  return (
    <>
      <div className="menu-head">
        <span className="brand">
          <span>personal-mcps</span>
        </span>
        <button type="button" className="menu-close" aria-label="Close menu">
          ✕
        </button>
      </div>
      <a className="menu-link" href="#apps" aria-current="page">
        Apps
      </a>
      <a className="menu-link" href="#agents" data-focus={focus ? "" : undefined}>
        Agents
      </a>
      <a className="menu-link" href="#audit">
        Audit
      </a>
      <div className="menu-foot">
        <span className="header-user">owner</span>
      </div>
    </>
  );
}

/**
 * The drawer at 390, in a 340px stand-in screen so its left edge, shadow and scrim fall 60px
 * into the cell. At 1280 both sides draw nothing: the drawer does not exist above the narrow
 * breakpoint, and that absence is what is compared.
 */
function Menu({ focus = false }: { focus?: boolean }): ReactNode {
  const viewport = { right: "auto", width: 340 };
  return (
    <Columns
      legacy={
        <OverlayStage height={360} viewport={viewport}>
          {() => (
            // `data-open` is the switch app.css's open-state rules read, as Base UI sets it.
            <>
              <div className="scrim" data-open="" />
              <div className="menu" data-open="">
                <MenuBody focus={focus} />
              </div>
            </>
          )}
        </OverlayStage>
      }
      next={
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
      }
    />
  );
}

/** The record's head and a line of body, as RecordDrawer writes them. */
function RecordBody(): ReactNode {
  return (
    <>
      <div className="a-dhead">
        <button type="button" className="a-dback">
          ‹ Audit
        </button>
        <span className="a-dtitle mono">tools/call github.search_issues</span>
        <span className="note a-dtime">Sep 23, 14:02:11</span>
        <button type="button" className="btn btn--outline btn--sm a-dclose wide-only">
          Close
        </button>
      </div>
      <div className="a-dbody">
        <p className="note">Bodies are read on their own, by id — the fields above came with the row.</p>
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
    <Columns
      legacy={
        <OverlayStage height={320} viewport={viewport}>
          {() => (
            <>
              <div className="audit-scrim" />
              <div className="audit-drawer">
                <RecordBody />
              </div>
            </>
          )}
        </OverlayStage>
      }
      next={
        <OverlayStage height={320} viewport={viewport}>
          {(container) => (
            <Sheet open modal={false}>
              <SheetContent variant="panel" container={container} initialFocus={false}>
                <RecordBody />
              </SheetContent>
            </Sheet>
          )}
        </OverlayStage>
      }
    />
  );
}

/** The Filters level's frame, as AuditPage writes it. */
function LevelBody(): ReactNode {
  return (
    <>
      <div className="a-lhead">
        <button type="button" className="a-dback" style={{ display: "inline-flex" }}>
          ‹ Audit
        </button>
        <b style={{ fontSize: 14 }}>Filters</b>
        <span className="badge">2 on</span>
        <button type="button" className="btn btn--outline btn--sm a-lclear">
          Clear
        </button>
      </div>
      <div className="a-lbody">
        <p className="note">The rail's groups.</p>
      </div>
      <div className="a-lfoot">
        <button type="button" className="btn btn--primary">
          Show 1,204 events
        </button>
      </div>
    </>
  );
}

/** The level in a stand-in screen inset 16px, so the shadow it casts past the screen's edge
 *  shows inside the cell. */
function Level(): ReactNode {
  const viewport = { inset: 16 };
  return (
    <Columns
      legacy={
        <OverlayStage height={320} viewport={viewport}>
          {() => (
            <div className="audit-level">
              <LevelBody />
            </div>
          )}
        </OverlayStage>
      }
      next={
        <OverlayStage height={320} viewport={viewport}>
          {(container) => (
            <Sheet open modal={false}>
              <SheetContent variant="level" container={container} initialFocus={false}>
                <LevelBody />
              </SheetContent>
            </Sheet>
          )}
        </OverlayStage>
      }
    />
  );
}

export const sheetStates: Record<string, PrimitiveState> = {
  "sheet-menu": () => <Menu />,
  "sheet-menu-focus": () => <Menu focus />,
  "sheet-panel": () => <Record />,
  "sheet-level": () => <Level />,
};
