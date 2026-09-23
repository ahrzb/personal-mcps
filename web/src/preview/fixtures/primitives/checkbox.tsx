import type { ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import { Checkbox, Tick } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Columns } from "./Columns";

/**
 * The Checkbox bench, in two parts:
 * - legacy.css's `.cb` as the pages write it (an `<input>`, a `<span>` statement, a
 *   `<button class="cb on">`), beside `<Checkbox variant="tick">` (the control) and `<Tick>`
 *   (the statement);
 * - /settings' native `.checkbox input`, beside the default `<Checkbox>`.
 *
 * Every row sits in a `p-1` frame, so a focus ring, which is drawn outside the square, stays
 * inside the cropped column.
 */

/** The statements' glyphs, as RecordingPane and RolesPane draw them. */
function Check(): ReactNode {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function Dash(): ReactNode {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
      <path d="M5 12h14" />
    </svg>
  );
}

/** legacy.css's `.cb` input. A checked one draws its tick as an `::after` whose 4 × 8px size
 *  was written for `content-box`, the browser's default for a pseudo-element. Preflight makes
 *  every pseudo-element `border-box` (pass 2's P4), which shrinks the tick by its border. The
 *  utility restores the default, so this column still draws what the pages drew. No page
 *  uses `.cb` now. */
const CB = "cb checked:after:box-content";

/** One row of squares. It is framed, so a ring drawn outside them is still in the shot. It
 *  wraps, so a row too wide for the 390px column never paints into its neighbour. */
function Row({ children }: { children: ReactNode }): ReactNode {
  return <div className="flex flex-wrap items-center gap-4 p-1">{children}</div>;
}

export const checkboxStates: Record<string, PrimitiveState> = {
  // The control in every state a page puts it in: off, on, on-but-disabled (an expanded path,
  // whose per-tool rows are the control), off-and-disabled, and locked.
  checkbox: () => (
    <Columns
      legacy={
        <Row>
          <input className={CB} type="checkbox" aria-label="off" />
          <input className={CB} type="checkbox" aria-label="on" defaultChecked />
          <input className={CB} type="checkbox" aria-label="on, disabled" defaultChecked disabled />
          <input className={CB} type="checkbox" aria-label="off, disabled" disabled />
          <input className={`${CB} lock`} type="checkbox" aria-label="locked" defaultChecked disabled />
        </Row>
      }
      next={
        <Row>
          <Checkbox variant="tick" aria-label="off" />
          <Checkbox variant="tick" aria-label="on" defaultChecked />
          <Checkbox variant="tick" aria-label="on, disabled" defaultChecked disabled />
          <Checkbox variant="tick" aria-label="off, disabled" disabled />
          <Checkbox variant="tick" lock aria-label="locked" defaultChecked disabled />
        </Row>
      }
    />
  ),
  // The statements: an unticked row, a locked one, a mixed path, and the role editor's ticked
  // pattern, a button that removes it (live, and while a save is pending).
  "checkbox-tick": () => (
    <Columns
      legacy={
        <Row>
          <span className="cb" aria-hidden="true"></span>
          <span className="cb lock">
            <Check />
          </span>
          <span className="cb mixed">
            <Dash />
          </span>
          <button type="button" className="cb on" title="remove this pattern">
            <Check />
          </button>
          <button type="button" className="cb on" title="remove this pattern" disabled>
            <Check />
          </button>
        </Row>
      }
      next={
        <Row>
          <Tick aria-hidden="true" />
          <Tick state="lock" />
          <Tick state="mixed" />
          <Tick state="on" render={<button type="button" />} title="remove this pattern" />
          <Tick state="on" render={<button type="button" disabled />} title="remove this pattern" />
        </Row>
      }
    />
  ),
  // /settings' "sign out my other sessions" row: `.checkbox input`, a NATIVE 16px box in the
  // primary accent, beside the Checkbox that replaces it.
  "checkbox-native": () => (
    <Columns
      legacy={
        <Row>
          <label className="checkbox">
            <input type="checkbox" />
            <span>Off</span>
          </label>
          <label className="checkbox">
            <input type="checkbox" defaultChecked />
            <span>On</span>
          </label>
        </Row>
      }
      next={
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
      }
    />
  ),
  // `data-focus`: visual-compare focuses each column's target just before shooting it.
  "checkbox-native-focus": () => (
    <Columns
      legacy={
        <Row>
          <label className="checkbox">
            <input type="checkbox" defaultChecked data-focus />
            <span>On</span>
          </label>
        </Row>
      }
      next={
        <Row>
          <Field orientation="horizontal" render={<label />}>
            <Checkbox defaultChecked data-focus />
            <span>On</span>
          </Field>
        </Row>
      }
    />
  ),
  "checkbox-focus": () => (
    <Columns
      legacy={
        <Row>
          <input className={CB} type="checkbox" aria-label="off" data-focus />
        </Row>
      }
      next={
        <Row>
          <Checkbox variant="tick" aria-label="off" data-focus />
        </Row>
      }
    />
  ),
  "checkbox-focus-checked": () => (
    <Columns
      legacy={
        <Row>
          <input className={CB} type="checkbox" aria-label="on" defaultChecked data-focus />
        </Row>
      }
      next={
        <Row>
          <Checkbox variant="tick" aria-label="on" defaultChecked data-focus />
        </Row>
      }
    />
  ),
  "checkbox-tick-focus": () => (
    <Columns
      legacy={
        <Row>
          <button type="button" className="cb on" title="remove this pattern" data-focus>
            <Check />
          </button>
        </Row>
      }
      next={
        <Row>
          <Tick state="on" render={<button type="button" />} title="remove this pattern" data-focus />
        </Row>
      }
    />
  ),
};
