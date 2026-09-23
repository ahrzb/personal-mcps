import type { PrimitiveState } from "../../seed";
import { Columns } from "./Columns";

/**
 * The Button bench: `.btn` in every variant and size, `.btn--mini`.
 *
 * A stub until pass 2's P1b (actions) draws that legacy markup beside `<Button>` in every
 * variant, size and state; its one state compares a placeholder with itself.
 */
export const buttonStates: Record<string, PrimitiveState> = {
  button: () => <Columns legacy="stub" next="stub" />,
};
