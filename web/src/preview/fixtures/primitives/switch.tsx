import type { ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Bench } from "./Bench";

/**
 * The Switch bench: the Recording pane's `<Label>` holding its `<Switch>`, the label in the
 * classes of its one call site.
 *
 * Every row sits in a `p-1` frame, so a focus ring, which is drawn outside the track, stays
 * inside the crop.
 */

/** The Recording pane's switch label, spelled as utilities on Label. */
const SW_LABEL = "inline-flex cursor-pointer items-center gap-2 text-xs font-normal whitespace-nowrap text-muted-foreground";

/** One row, wrapping, as it did beside the legacy column its baselines were cut from. */
function Row({ children }: { children: ReactNode }): ReactNode {
  return <div className="flex flex-wrap items-center gap-4 p-1">{children}</div>;
}

export const switchStates: Record<string, PrimitiveState> = {
  // Off, on, and disabled in both, which the switch draws exactly as enabled.
  switch: () => (
    <Bench>
      <Row>
        <Label className={SW_LABEL}>
          <span>Record call bodies</span>
          <Switch />
        </Label>
        <Label className={SW_LABEL}>
          <span>Record call bodies</span>
          <Switch defaultChecked />
        </Label>
        <Switch aria-label="off, disabled" disabled />
        <Switch aria-label="on, disabled" defaultChecked disabled />
      </Row>
    </Bench>
  ),
  // `data-focus`: visual-compare focuses the target just before the shot.
  "switch-focus": () => (
    <Bench>
      <Row>
        <Label className={SW_LABEL}>
          <span>Record call bodies</span>
          <Switch defaultChecked data-focus />
        </Label>
      </Row>
    </Bench>
  ),
};
