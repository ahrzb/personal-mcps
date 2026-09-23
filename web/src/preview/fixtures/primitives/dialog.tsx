import type { ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Bench } from "./Bench";
import { OverlayStage } from "./OverlayStage";

/**
 * The Dialog bench: Confirm's `<Dialog>`, open over its scrim, drawn in-flow by
 * `OverlayStage`. The actions are the caller's, as Confirm's callers pass them.
 *
 * At 390 the cell is narrower than the 350px box, which then starts at the cell's left edge
 * (auto margins cannot go negative): the crop shows the left part of the box, its border,
 * text and the first action at its narrow share. Centring is proven at 1280, where the whole
 * box fits.
 */

const TITLE = "Delete agent “ci-bot”?";
const TEXT = "Deleting an agent deletes its tokens and removes its grants everywhere.";

/** Confirm's actions. `focus` marks Cancel, the button focus lands on when a dialog opens. */
function Actions({ focus }: { focus: boolean }): ReactNode {
  return (
    <>
      <Button variant="ghost" data-focus={focus ? "" : undefined}>
        Cancel
      </Button>
      <Button variant="danger">Delete</Button>
    </>
  );
}

function Confirm({ focus }: { focus: boolean }): ReactNode {
  return (
    <Bench>
      <OverlayStage height={280}>
        {(container) => (
          // Not modal, and no initial focus: a modal dialog would trap focus, lock the page's
          // scroll and focus its first action, where the bench wants the box at rest and
          // focuses Cancel itself in the focus state.
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
    </Bench>
  );
}

export const dialogStates: Record<string, PrimitiveState> = {
  dialog: () => <Confirm focus={false} />,
  "dialog-focus": () => <Confirm focus />,
};
