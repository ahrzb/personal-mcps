import type { PrimitiveState } from "../../seed";
import { Columns } from "./Columns";

/**
 * The Checkbox bench: `.checkbox input`, `.cb` (and the static Tick).
 *
 * A stub until pass 2's P1b (fields) draws that legacy markup beside `<Checkbox>` in every
 * variant, size and state; its one state compares a placeholder with itself.
 */
export const checkboxStates: Record<string, PrimitiveState> = {
  checkbox: () => <Columns legacy="stub" next="stub" />,
};
