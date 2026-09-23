import type { PrimitiveState } from "../../seed";
import { Columns } from "./Columns";

/**
 * The RadioGroup bench: `.choice` cards and the `.seg` three-way.
 *
 * A stub until pass 2's P1b (fields) draws that legacy markup beside `<RadioGroup>` in every
 * variant, size and state; its one state compares a placeholder with itself.
 */
export const radioGroupStates: Record<string, PrimitiveState> = {
  "radio-group": () => <Columns legacy="stub" next="stub" />,
};
