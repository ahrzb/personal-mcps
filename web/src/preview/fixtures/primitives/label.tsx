import type { PrimitiveState } from "../../seed";
import { Label } from "@/components/ui/label";
import { Bench } from "./Bench";

/**
 * The Label bench: every form the pages write a control's name in — a `<label>` of its own,
 * one inside a field, the `<span>` a wrapping label holds, and the `<div>` that heads a group
 * of controls.
 */
export const labelStates: Record<string, PrimitiveState> = {
  label: () => (
    <Bench>
      <Label htmlFor="bench-label-a">Device code</Label>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="bench-label-b">Slug</Label>
      </div>
      <label>
        <Label render={<span />}>Current password</Label>
      </label>
      <Label render={<div />}>Authentication</Label>
    </Bench>
  ),
};
