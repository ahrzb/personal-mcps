import type { PrimitiveState } from "../../seed";
import { Columns } from "./Columns";

/**
 * The Table bench: `.table` (wide and stacked), `.a-etab`.
 *
 * A stub until pass 2's P1b (surfaces) draws that legacy markup beside `<Table>` in every
 * variant, size and state; its one state compares a placeholder with itself.
 */
export const tableStates: Record<string, PrimitiveState> = {
  table: () => <Columns legacy="stub" next="stub" />,
};
