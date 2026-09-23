import type { ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import { Checkbox, Tick } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Bench } from "./Bench";

/**
 * The Checkbox bench, in two parts:
 * - `<Checkbox variant="tick">`, the control RecordingPane and RolesPane write, and `<Tick>`,
 *   the same square as a statement or a button;
 * - the default `<Checkbox>`, /settings' "sign out my other sessions" box.
 *
 * Every row sits in a `p-1` frame, so a focus ring, which is drawn outside the square, stays
 * inside the crop.
 */

/** One row of squares. It is framed, so a ring drawn outside them is still in the shot. It
 *  wraps, as it did beside the legacy column its baselines were cut from. */
function Row({ children }: { children: ReactNode }): ReactNode {
  return <div className="flex flex-wrap items-center gap-4 p-1">{children}</div>;
}

export const checkboxStates: Record<string, PrimitiveState> = {
  // The control in every state a page puts it in: off, on, on-but-disabled (an expanded path,
  // whose per-tool rows are the control), off-and-disabled, and locked.
  checkbox: () => (
    <Bench>
      <Row>
        <Checkbox variant="tick" aria-label="off" />
        <Checkbox variant="tick" aria-label="on" defaultChecked />
        <Checkbox variant="tick" aria-label="on, disabled" defaultChecked disabled />
        <Checkbox variant="tick" aria-label="off, disabled" disabled />
        <Checkbox variant="tick" lock aria-label="locked" defaultChecked disabled />
      </Row>
    </Bench>
  ),
  // The statements: an unticked row, a locked one, a mixed path, and the role editor's ticked
  // pattern, a button that removes it (live, and while a save is pending).
  "checkbox-tick": () => (
    <Bench>
      <Row>
        <Tick aria-hidden="true" />
        <Tick state="lock" />
        <Tick state="mixed" />
        <Tick state="on" render={<button type="button" />} title="remove this pattern" />
        <Tick state="on" render={<button type="button" disabled />} title="remove this pattern" />
      </Row>
    </Bench>
  ),
  // /settings' "sign out my other sessions" row, whose Checkbox replaced a native 16px box in
  // the primary accent.
  "checkbox-native": () => (
    <Bench>
      <Row>
        <Field orientation="horizontal" render={<label />}>
          <Checkbox />
          <span>Off</span>
        </Field>
        <Field orientation="horizontal" render={<label />}>
          <Checkbox defaultChecked />
          <span>On</span>
        </Field>
      </Row>
    </Bench>
  ),
  // `data-focus`: visual-compare focuses the target just before the shot.
  "checkbox-native-focus": () => (
    <Bench>
      <Row>
        <Field orientation="horizontal" render={<label />}>
          <Checkbox defaultChecked data-focus />
          <span>On</span>
        </Field>
      </Row>
    </Bench>
  ),
  "checkbox-focus": () => (
    <Bench>
      <Row>
        <Checkbox variant="tick" aria-label="off" data-focus />
      </Row>
    </Bench>
  ),
  "checkbox-focus-checked": () => (
    <Bench>
      <Row>
        <Checkbox variant="tick" aria-label="on" defaultChecked data-focus />
      </Row>
    </Bench>
  ),
  "checkbox-tick-focus": () => (
    <Bench>
      <Row>
        <Tick state="on" render={<button type="button" />} title="remove this pattern" data-focus />
      </Row>
    </Bench>
  ),
};
