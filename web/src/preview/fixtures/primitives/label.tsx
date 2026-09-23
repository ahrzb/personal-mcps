import type { PrimitiveState } from "../../seed";
import { Label } from "@/components/ui/label";
import { Columns } from "./Columns";

/**
 * The Label bench: every form the pages write a control's name in, beside `<Label>`. Those
 * forms are `.label` on a `<label>`, a bare `<label>` inside `.field`, `.label` on the
 * `<span>` a wrapping label holds, and `.label` on the `<div>` that heads a group of
 * controls.
 */
export const labelStates: Record<string, PrimitiveState> = {
  label: () => (
    <Columns
      legacy={
        <>
          <label className="label" htmlFor="bench-label-a">
            Device code
          </label>
          <div className="field">
            <label htmlFor="bench-label-b">Slug</label>
          </div>
          <label>
            <span className="label">Current password</span>
          </label>
          <div className="label">Authentication</div>
        </>
      }
      next={
        <>
          <Label htmlFor="bench-label-a">Device code</Label>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bench-label-b">Slug</Label>
          </div>
          <label>
            <Label render={<span />}>Current password</Label>
          </label>
          <Label render={<div />}>Authentication</Label>
        </>
      }
    />
  ),
};
