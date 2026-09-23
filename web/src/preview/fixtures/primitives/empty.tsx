import type { PrimitiveState } from "../../seed";
import { Columns } from "./Columns";

/**
 * The Empty bench: `.empty`, `.empty--inline`.
 *
 * A stub until pass 2's P1b (surfaces) draws that legacy markup beside `<Empty>` in every
 * variant, size and state; its one state compares a placeholder with itself.
 */
export const emptyStates: Record<string, PrimitiveState> = {
  empty: () => <Columns legacy="stub" next="stub" />,
};
