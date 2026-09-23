import type { CSSProperties, ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Columns } from "./Columns";
import { OverlayStage } from "./OverlayStage";

/**
 * The Dialog bench: Confirm's native `dialog`, open over its scrim, beside `<Dialog>`, each
 * drawn in-flow by `OverlayStage`. The actions are the caller's `.btn`s on both sides, so only
 * the dialog itself is compared.
 *
 * At 390 the cell is narrower than the 350px box, which then starts at the cell's left edge on
 * BOTH sides (auto margins cannot go negative): the crop shows the left part of the
 * box, its border, text and the first action at its narrow share. Centring is proven at 1280,
 * where the whole box fits.
 */

const TITLE = "Delete agent “ci-bot”?";
const TEXT = "Deleting an agent deletes its tokens and removes its grants everywhere.";

/**
 * What the native element gets from being MODAL, which a dialog inside a column cannot be
 * (`showModal()` lifts it into the top layer, over the whole page): the UA's `dialog:modal`
 * declarations, and its `::backdrop` drawn as a sibling with legacy.css's colour. Also the
 * UA's `margin: auto`, the one declaration that centres it, which preflight's `margin: 0`
 * strips (pass 2's P4, inventory §4 #4). Confirm's `<dialog>` had that margin.
 */
const MODAL: CSSProperties = {
  position: "fixed",
  insetBlock: 0,
  margin: "auto",
  maxHeight: "calc(100% - 6px - 2em)",
  overflow: "auto",
};
const BACKDROP: CSSProperties = { position: "fixed", inset: 0, background: "rgba(9, 9, 11, 0.4)" };

/** Confirm's actions. `focus` marks Cancel, the button focus lands on when a dialog opens. */
function Actions({ focus }: { focus: boolean }): ReactNode {
  return (
    <>
      <button type="button" className="btn btn--ghost" data-focus={focus ? "" : undefined}>
        Cancel
      </button>
      <button type="button" className="btn btn--danger">
        Delete
      </button>
    </>
  );
}

function Confirm({ focus }: { focus: boolean }): ReactNode {
  return (
    <Columns
      legacy={
        <OverlayStage height={280}>
          {() => (
            <>
              <div style={BACKDROP} />
              <dialog open style={MODAL}>
                <div className="dialog-body">
                  <div>
                    <div className="dialog-title">{TITLE}</div>
                    <div className="dialog-text">{TEXT}</div>
                  </div>
                  <div className="actions">
                    <Actions focus={focus} />
                  </div>
                </div>
              </dialog>
            </>
          )}
        </OverlayStage>
      }
      next={
        <OverlayStage height={280}>
          {(container) => (
            // Not modal: a modal dialog makes the rest of the document inert, and the compare
            // has to focus the legacy column's Cancel too. No initial focus either, so the rest
            // state is at rest on both sides.
            <Dialog open modal={false}>
              <DialogContent container={container} initialFocus={false}>
                <DialogHeader>
                  <DialogTitle>{TITLE}</DialogTitle>
                  <DialogDescription>{TEXT}</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Actions focus={focus} />
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </OverlayStage>
      }
    />
  );
}

export const dialogStates: Record<string, PrimitiveState> = {
  dialog: () => <Confirm focus={false} />,
  "dialog-focus": () => <Confirm focus />,
};
