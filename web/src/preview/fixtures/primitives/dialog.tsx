import type { PrimitiveState } from "../../seed";
import { Columns } from "./Columns";

/**
 * The Dialog bench: Confirm's native `dialog`.
 *
 * A stub until pass 2's P1b (overlays) draws that legacy markup beside `<Dialog>` in every
 * variant, size and state; its one state compares a placeholder with itself.
 */
export const dialogStates: Record<string, PrimitiveState> = {
  dialog: () => <Columns legacy="stub" next="stub" />,
};
