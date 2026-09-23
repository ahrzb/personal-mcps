import type { PrimitiveState } from "../../seed";
import { Columns } from "./Columns";

/**
 * The Switch bench: `.sw`, `.sw-label`.
 *
 * A stub until pass 2's P1b (fields) draws that legacy markup beside `<Switch>` in every
 * variant, size and state; its one state compares a placeholder with itself.
 */
export const switchStates: Record<string, PrimitiveState> = {
  switch: () => <Columns legacy="stub" next="stub" />,
};
