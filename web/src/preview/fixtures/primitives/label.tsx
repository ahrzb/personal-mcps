import type { PrimitiveState } from "../../seed";
import { Columns } from "./Columns";

/**
 * The Label bench: `.label`, `.field > label`.
 *
 * A stub until pass 2's P1b (fields) draws that legacy markup beside `<Label>` in every
 * variant, size and state; its one state compares a placeholder with itself.
 */
export const labelStates: Record<string, PrimitiveState> = {
  label: () => <Columns legacy="stub" next="stub" />,
};
