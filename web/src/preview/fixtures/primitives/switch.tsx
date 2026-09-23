import type { ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Columns } from "./Columns";

/**
 * The Switch bench: the Recording pane's `.sw-label` holding its `.sw`, beside `<Label>`
 * holding `<Switch>`. `.sw-label` is Label with the classes of its one call site.
 *
 * Every row sits in a `p-1` frame, so a focus ring, which is drawn outside the track, stays
 * inside the cropped column.
 */

/** `.sw-label`, spelled as utilities on Label. */
const SW_LABEL = "inline-flex cursor-pointer items-center gap-2 text-xs font-normal whitespace-nowrap text-muted-foreground";

/** One row, wrapping, so a row too wide for the 390px column never paints into its neighbour. */
function Row({ children }: { children: ReactNode }): ReactNode {
  return <div className="flex flex-wrap items-center gap-4 p-1">{children}</div>;
}

export const switchStates: Record<string, PrimitiveState> = {
  // Off, on, and disabled in both, which `.sw` draws exactly as enabled.
  switch: () => (
    <Columns
      legacy={
        <Row>
          <label className="sw-label">
            <span>Record call bodies</span>
            <input className="sw" type="checkbox" />
          </label>
          <label className="sw-label">
            <span>Record call bodies</span>
            <input className="sw" type="checkbox" defaultChecked />
          </label>
          <input className="sw" type="checkbox" aria-label="off, disabled" disabled />
          <input className="sw" type="checkbox" aria-label="on, disabled" defaultChecked disabled />
        </Row>
      }
      next={
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
      }
    />
  ),
  // `data-focus`: visual-compare focuses each column's target just before shooting it.
  "switch-focus": () => (
    <Columns
      legacy={
        <Row>
          <label className="sw-label">
            <span>Record call bodies</span>
            <input className="sw" type="checkbox" defaultChecked data-focus />
          </label>
        </Row>
      }
      next={
        <Row>
          <Label className={SW_LABEL}>
            <span>Record call bodies</span>
            <Switch defaultChecked data-focus />
          </Label>
        </Row>
      }
    />
  ),
};
